//! Analyses the Corpus data viewer runs on an expression table.
//!
//! A table arrives as a row-major matrix: one row per gene (or other feature), one column per
//! sample, `NaN` where a cell is empty. Everything here is plain numerics with no knowledge
//! of the app, so it can be tested on its own.

use nalgebra::{DMatrix, SymmetricEigen};
use statrs::distribution::{ContinuousCDF, Normal, StudentsT};
use statrs::function::gamma::digamma;

/// How raw values become the scale the statistics work on.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Transform {
    /// Raw read counts: log2 counts per million, with the offsets voom uses
    /// (`log2((count + 0.5) / (library size + 1) * 1e6)`).
    Counts,
    /// Already normalised, not yet logged (CPM, TPM, FPKM): `log2(x + 1)`.
    Log,
    /// Already on a log scale (microarray RMA, log-CPM): used as is.
    None,
}

impl Transform {
    pub fn parse(name: &str) -> Result<Self, String> {
        match name {
            "counts" => Ok(Self::Counts),
            "log" => Ok(Self::Log),
            "none" => Ok(Self::None),
            other => Err(format!("unknown transform \"{other}\"")),
        }
    }
}

/// A genes x samples matrix, row-major.
pub struct Matrix<'a> {
    pub values: &'a [f64],
    pub rows: usize,
    pub cols: usize,
}

impl<'a> Matrix<'a> {
    pub fn new(values: &'a [f64], rows: usize, cols: usize) -> Result<Self, String> {
        if values.len() != rows * cols {
            return Err(format!("expected {rows} x {cols} values, got {}", values.len()));
        }
        Ok(Self { values, rows, cols })
    }

    fn row(&self, r: usize) -> &[f64] {
        &self.values[r * self.cols..(r + 1) * self.cols]
    }

    /// Total count per sample over all genes, counting empty cells as zero.
    fn library_sizes(&self) -> Vec<f64> {
        let mut sizes = vec![0.0; self.cols];
        for r in 0..self.rows {
            for (size, v) in sizes.iter_mut().zip(self.row(r)) {
                if v.is_finite() {
                    *size += v;
                }
            }
        }
        sizes
    }
}

fn transformed(value: f64, library: f64, transform: Transform) -> f64 {
    match transform {
        Transform::Counts => ((value + 0.5) / (library + 1.0) * 1e6).log2(),
        Transform::Log => (value + 1.0).log2(),
        Transform::None => value,
    }
}

/// A count this size in enough samples marks a gene as expressed (the usual rule of thumb).
const MIN_COUNT: f64 = 10.0;

/// One tested gene. `row` is its index in the input matrix.
#[derive(Clone, Debug, PartialEq)]
pub struct DeRow {
    pub row: usize,
    pub mean_a: f64,
    pub mean_b: f64,
    /// Mean of group B minus mean of group A on the log2 scale: positive means higher in B.
    pub log2_fc: f64,
    /// Moderated t statistic.
    pub t: f64,
    pub p: f64,
    /// Benjamini-Hochberg adjusted p-value.
    pub p_adj: f64,
}

fn mean_var(values: &[f64]) -> (f64, f64) {
    let n = values.len() as f64;
    let mean = values.iter().sum::<f64>() / n;
    let var = values.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / (n - 1.0);
    (mean, var)
}

/// Second derivative of log-gamma. Recurrence up to 6, then the asymptotic series.
fn trigamma(mut x: f64) -> f64 {
    let mut sum = 0.0;
    while x < 6.0 {
        sum += 1.0 / (x * x);
        x += 1.0;
    }
    let x2 = x * x;
    let x3 = x2 * x;
    sum + 1.0 / x + 1.0 / (2.0 * x2) + 1.0 / (6.0 * x3) - 1.0 / (30.0 * x3 * x2) + 1.0 / (42.0 * x3 * x2 * x2) - 1.0 / (30.0 * x3 * x3 * x3)
}

/// Third derivative of log-gamma.
fn tetragamma(mut x: f64) -> f64 {
    let mut sum = 0.0;
    while x < 6.0 {
        sum -= 2.0 / (x * x * x);
        x += 1.0;
    }
    let x2 = x * x;
    let x4 = x2 * x2;
    sum - 1.0 / x2 - 1.0 / (x2 * x) - 1.0 / (2.0 * x4) + 1.0 / (6.0 * x4 * x2) - 1.0 / (6.0 * x4 * x4) + 3.0 / (10.0 * x4 * x4 * x2)
}

/// Solves `trigamma(y) = x` for y by Newton's method on 1/trigamma, as limma does.
fn trigamma_inverse(x: f64) -> f64 {
    if x > 1e7 {
        return 1.0 / x.sqrt();
    }
    if x < 1e-6 {
        return 1.0 / x;
    }
    let mut y = 0.5 + 1.0 / x;
    for _ in 0..50 {
        let tri = trigamma(y);
        let step = tri * (1.0 - tri / x) / tetragamma(y);
        y += step;
        if -step / y < 1e-8 {
            break;
        }
    }
    y
}

/// What the genes as a whole say about a typical variance: the prior that each gene's own
/// variance is shrunk toward.
#[derive(Clone, Debug)]
pub struct VariancePrior {
    /// Prior variance for each gene. It follows expression level: in count data, weakly
    /// expressed genes are noisier on the log scale than strongly expressed ones.
    pub s0_squared: Vec<f64>,
    /// How many observations' worth of weight the prior carries. Infinite when the genes'
    /// variances differ from the trend no more than chance alone would produce.
    pub d0: f64,
}

/// Genes per bin when estimating how variance changes with expression level.
const TREND_BIN: usize = 200;
const TREND_MAX_BINS: usize = 20;

/// The typical log-variance at each gene's expression level: genes are sorted by mean
/// expression and cut into equal-sized bins, and the bin averages are joined by straight
/// lines. Returns the fitted value per gene and the number of bins used.
fn variance_trend(e: &[f64], expression: &[f64]) -> (Vec<f64>, usize) {
    let n = e.len();
    let bins = (n / TREND_BIN).clamp(1, TREND_MAX_BINS);
    let mut order: Vec<usize> = (0..n).collect();
    order.sort_by(|&i, &j| expression[i].total_cmp(&expression[j]));

    // (mean expression, mean log-variance) of each bin, in order of expression.
    let knots: Vec<(f64, f64)> = (0..bins)
        .map(|b| {
            let members = &order[b * n / bins..(b + 1) * n / bins];
            let count = members.len() as f64;
            (members.iter().map(|&i| expression[i]).sum::<f64>() / count, members.iter().map(|&i| e[i]).sum::<f64>() / count)
        })
        .collect();

    let fitted = expression
        .iter()
        .map(|&x| {
            let next = knots.partition_point(|k| k.0 < x);
            if next == 0 {
                knots[0].1
            } else if next == knots.len() {
                knots[knots.len() - 1].1
            } else {
                let (x0, y0) = knots[next - 1];
                let (x1, y1) = knots[next];
                if x1 > x0 { y0 + (y1 - y0) * (x - x0) / (x1 - x0) } else { y0 }
            }
        })
        .collect();
    (fitted, bins)
}

/// Fits a scaled F distribution to the gene variances by the method of moments on their logs
/// (Smyth 2004, the empirical Bayes step of limma), with the prior variance allowed to follow
/// mean expression (the idea of limma-trend). `df` is each variance's degrees of freedom.
pub fn fit_variance_prior(variances: &[f64], expression: &[f64], df: f64) -> VariancePrior {
    let n = variances.len();
    let offset = digamma(df / 2.0) - (df / 2.0).ln();
    let e: Vec<f64> = variances.iter().map(|v| v.ln() - offset).collect();
    let (trend, bins) = variance_trend(&e, expression);
    let residual = e.iter().zip(&trend).map(|(v, t)| (v - t).powi(2)).sum::<f64>();
    let spread = if n > bins { residual / (n - bins) as f64 - trigamma(df / 2.0) } else { 0.0 };
    if spread > 0.0 {
        let d0 = 2.0 * trigamma_inverse(spread);
        let shift = digamma(d0 / 2.0) - (d0 / 2.0).ln();
        VariancePrior { s0_squared: trend.iter().map(|t| (t + shift).exp()).collect(), d0 }
    } else {
        VariancePrior { s0_squared: trend.iter().map(|t| t.exp()).collect(), d0: f64::INFINITY }
    }
}

/// Two-sided p-value for a t statistic; a normal distribution when `df` is infinite.
fn two_sided_p(t: f64, df: f64) -> f64 {
    // The survival function keeps precision for the very small p-values far out in the tail.
    if df.is_finite() {
        match StudentsT::new(0.0, 1.0, df) {
            Ok(dist) => 2.0 * dist.sf(t.abs()),
            Err(_) => f64::NAN,
        }
    } else {
        2.0 * Normal::standard().sf(t.abs())
    }
}

/// Benjamini-Hochberg adjustment, returned in the order the p-values were given.
pub fn benjamini_hochberg(p: &[f64]) -> Vec<f64> {
    let n = p.len();
    let mut order: Vec<usize> = (0..n).collect();
    order.sort_by(|&i, &j| p[i].total_cmp(&p[j]));
    let mut adjusted = vec![0.0; n];
    let mut running = 1.0_f64;
    // From the largest p down, so each adjusted value is no larger than the ones above it.
    for (rank, &i) in order.iter().enumerate().rev() {
        running = running.min(p[i] * n as f64 / (rank + 1) as f64);
        adjusted[i] = running;
    }
    adjusted
}

fn check_groups(matrix: &Matrix, a: &[usize], b: &[usize]) -> Result<(), String> {
    if a.len() < 2 || b.len() < 2 {
        return Err("Each group needs at least two samples.".into());
    }
    if a.iter().chain(b).any(|&c| c >= matrix.cols) {
        return Err("A group refers to a column that is not in the table.".into());
    }
    if a.iter().any(|c| b.contains(c)) {
        return Err("A sample cannot be in both groups.".into());
    }
    Ok(())
}

/// Compares group B with group A, gene by gene, with a moderated t-test: each gene's pooled
/// variance is shrunk toward the variance typical of genes expressed at its level before the
/// t statistic is formed (limma's empirical Bayes with a trend), then p-values are
/// Benjamini-Hochberg adjusted.
///
/// Shrinking is what makes small groups workable: with three samples a group, a gene's own
/// variance is too noisy to trust, and borrowing from thousands of other genes steadies it.
///
/// Genes are skipped when any selected sample is empty, when they do not vary, and (for raw
/// counts) when fewer than the smaller group's worth of samples reach ten reads.
pub fn differential_expression(matrix: &Matrix, group_a: &[usize], group_b: &[usize], transform: Transform) -> Result<Vec<DeRow>, String> {
    check_groups(matrix, group_a, group_b)?;
    let libraries = matrix.library_sizes();
    let smaller = group_a.len().min(group_b.len());
    let (na, nb) = (group_a.len() as f64, group_b.len() as f64);
    let df = na + nb - 2.0;

    let mut rows = Vec::new();
    let mut variances = Vec::new();
    let mut expression = Vec::new();
    let (mut a, mut b) = (Vec::with_capacity(group_a.len()), Vec::with_capacity(group_b.len()));
    for r in 0..matrix.rows {
        let raw = matrix.row(r);
        let selected = || group_a.iter().chain(group_b).map(|&c| raw[c]);
        if selected().any(|v| !v.is_finite()) || (transform == Transform::Log && selected().any(|v| v < 0.0)) {
            continue;
        }
        if transform == Transform::Counts && selected().filter(|&v| v >= MIN_COUNT).count() < smaller {
            continue;
        }
        a.clear();
        b.clear();
        a.extend(group_a.iter().map(|&c| transformed(raw[c], libraries[c], transform)));
        b.extend(group_b.iter().map(|&c| transformed(raw[c], libraries[c], transform)));
        let (mean_a, var_a) = mean_var(&a);
        let (mean_b, var_b) = mean_var(&b);
        let pooled = ((na - 1.0) * var_a + (nb - 1.0) * var_b) / df;
        if !(pooled > 0.0) {
            continue;
        }
        variances.push(pooled);
        expression.push((na * mean_a + nb * mean_b) / (na + nb));
        rows.push(DeRow { row: r, mean_a, mean_b, log2_fc: mean_b - mean_a, t: 0.0, p: 0.0, p_adj: 0.0 });
    }
    if rows.is_empty() {
        return Ok(rows);
    }

    let prior = fit_variance_prior(&variances, &expression, df);
    for ((row, &variance), &s0_squared) in rows.iter_mut().zip(&variances).zip(&prior.s0_squared) {
        let (shrunk, total_df) = if prior.d0.is_finite() {
            ((prior.d0 * s0_squared + df * variance) / (prior.d0 + df), prior.d0 + df)
        } else {
            (s0_squared, f64::INFINITY)
        };
        row.t = row.log2_fc / (shrunk * (1.0 / na + 1.0 / nb)).sqrt();
        row.p = two_sided_p(row.t, total_df);
    }

    let adjusted = benjamini_hochberg(&rows.iter().map(|r| r.p).collect::<Vec<_>>());
    for (row, p_adj) in rows.iter_mut().zip(adjusted) {
        row.p_adj = p_adj;
    }
    Ok(rows)
}

/// Sample coordinates on the leading principal components.
#[derive(Debug)]
pub struct Pca {
    /// `scores[sample][component]`.
    pub scores: Vec<Vec<f64>>,
    /// Share of the variance each component carries, summing to at most 1.
    pub explained: Vec<f64>,
    /// How many genes went into it.
    pub genes: usize,
}

/// PCA of the chosen samples over the `top` most variable genes, each gene centred.
///
/// Works on the samples x samples matrix, which stays small however many genes there are.
pub fn pca(matrix: &Matrix, samples: &[usize], transform: Transform, top: usize, components: usize) -> Result<Pca, String> {
    let n = samples.len();
    if n < 3 {
        return Err("PCA needs at least three samples.".into());
    }
    if samples.iter().any(|&c| c >= matrix.cols) {
        return Err("A sample refers to a column that is not in the table.".into());
    }
    let libraries = matrix.library_sizes();

    // Centred rows with their variance, for genes that are complete and vary.
    let mut genes: Vec<(f64, Vec<f64>)> = Vec::new();
    for r in 0..matrix.rows {
        let raw = matrix.row(r);
        if samples.iter().any(|&c| !raw[c].is_finite() || (transform == Transform::Log && raw[c] < 0.0)) {
            continue;
        }
        if transform == Transform::Counts && samples.iter().filter(|&&c| raw[c] >= MIN_COUNT).count() < 2 {
            continue;
        }
        let mut values: Vec<f64> = samples.iter().map(|&c| transformed(raw[c], libraries[c], transform)).collect();
        let (mean, var) = mean_var(&values);
        if var > 0.0 {
            values.iter_mut().for_each(|v| *v -= mean);
            genes.push((var, values));
        }
    }
    if genes.is_empty() {
        return Err("No gene varies across these samples.".into());
    }
    genes.sort_by(|x, y| y.0.total_cmp(&x.0));
    genes.truncate(top.max(1));

    let mut gram = DMatrix::<f64>::zeros(n, n);
    for (_, values) in &genes {
        for i in 0..n {
            for j in i..n {
                gram[(i, j)] += values[i] * values[j];
            }
        }
    }
    for i in 0..n {
        for j in 0..i {
            gram[(i, j)] = gram[(j, i)];
        }
    }

    let eigen = SymmetricEigen::new(gram);
    let mut order: Vec<usize> = (0..n).collect();
    order.sort_by(|&i, &j| eigen.eigenvalues[j].total_cmp(&eigen.eigenvalues[i]));
    let total: f64 = eigen.eigenvalues.iter().filter(|v| **v > 0.0).sum();
    // Centring removes one dimension, so n samples have at most n - 1 components.
    let keep = components.min(n - 1);

    let mut scores = vec![Vec::with_capacity(keep); n];
    let mut explained = Vec::with_capacity(keep);
    for &k in order.iter().take(keep) {
        let value = eigen.eigenvalues[k].max(0.0);
        explained.push(value / total);
        for (sample, score) in scores.iter_mut().enumerate() {
            score.push(eigen.eigenvectors[(sample, k)] * value.sqrt());
        }
    }
    Ok(Pca { scores, explained, genes: genes.len() })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: f64, b: f64, tolerance: f64) -> bool {
        (a - b).abs() < tolerance
    }

    #[test]
    fn polygamma_functions_match_known_values() {
        // trigamma(1) = pi^2 / 6, trigamma(1/2) = pi^2 / 2, tetragamma(1) = -2 zeta(3).
        assert!(close(trigamma(1.0), 1.644_934_066_848, 1e-8), "{}", trigamma(1.0));
        assert!(close(trigamma(0.5), 4.934_802_200_545, 1e-8));
        assert!(close(trigamma(10.0), 0.105_166_335_681_7, 1e-10));
        assert!(close(tetragamma(1.0), -2.404_113_806_319, 1e-8));
        assert!(close(tetragamma(7.5), -0.020_305_252_536_64, 1e-9), "{}", tetragamma(7.5));
        for y in [0.3, 1.0, 2.5, 40.0] {
            assert!(close(trigamma_inverse(trigamma(y)), y, 1e-6 * y.max(1.0)), "y = {y}");
        }
    }

    #[test]
    fn variance_prior_matches_reference_values() {
        // Reference: the same method in R (digamma, trigamma, psigamma), see scripts/check-moderated-t.R.
        // Too few genes for a trend, so every gene gets the same prior variance.
        let variances = [0.5, 1.0, 2.0, 0.25, 4.0, 1.5, 0.75, 3.0];
        let expression = [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0];
        let prior = fit_variance_prior(&variances, &expression, 4.0);
        assert!(close(prior.d0, 9.942_445_898_16, 1e-5), "d0 = {}", prior.d0);
        assert!(prior.s0_squared.iter().all(|v| close(*v, 1.375_028_893_1, 1e-6)), "{:?}", prior.s0_squared);
        // Variances no more spread than chance would give: the prior takes over entirely.
        assert!(fit_variance_prior(&[1.0, 1.01, 0.99, 1.0], &[1.0, 2.0, 3.0, 4.0], 4.0).d0.is_infinite());
    }

    #[test]
    fn variance_trend_follows_expression_level() {
        // 800 genes in four bins of 200: log-variance falls from 2 to -1 as expression rises.
        let expression: Vec<f64> = (0..800).map(|i| i as f64 / 100.0).collect();
        let e: Vec<f64> = (0..800).map(|i| [2.0, 1.0, 0.0, -1.0][i / 200]).collect();
        let (fitted, bins) = variance_trend(&e, &expression);
        assert_eq!(bins, 4);
        // Flat beyond the outer bin centres, straight lines between them.
        assert!(close(fitted[0], 2.0, 1e-12) && close(fitted[799], -1.0, 1e-12));
        assert!(close(fitted[200], 1.497_5, 1e-9), "{}", fitted[200]);
        assert!(fitted.windows(2).all(|w| w[1] <= w[0] + 1e-12));
    }

    #[test]
    fn benjamini_hochberg_keeps_input_order_and_is_monotone() {
        let adjusted = benjamini_hochberg(&[0.01, 0.04, 0.03, 0.005]);
        let expected = [0.02, 0.04, 0.04, 0.02];
        for (got, want) in adjusted.iter().zip(expected) {
            assert!(close(*got, want, 1e-12), "{adjusted:?}");
        }
        assert_eq!(benjamini_hochberg(&[0.5, 0.9]), vec![0.9, 0.9]);
        assert!(benjamini_hochberg(&[]).is_empty());
    }

    #[test]
    fn differential_expression_on_log_values() {
        #[rustfmt::skip]
        let values = [
            1.0, 2.0, 3.0,  4.0, 5.0, 6.0,   // up in B
            5.0, 5.0, 5.0,  5.0, 5.0, 5.0,   // constant: skipped
            4.0, 5.0, 6.0,  1.0, 2.0, 3.0,   // down in B
            1.0, f64::NAN, 3.0, 4.0, 5.0, 6.0, // incomplete: skipped
        ];
        let matrix = Matrix::new(&values, 4, 6).unwrap();
        let rows = differential_expression(&matrix, &[0, 1, 2], &[3, 4, 5], Transform::None).unwrap();
        assert_eq!(rows.iter().map(|r| r.row).collect::<Vec<_>>(), vec![0, 2]);
        assert!(close(rows[0].log2_fc, 3.0, 1e-12) && close(rows[1].log2_fc, -3.0, 1e-12));
        // Both genes have pooled variance 1, so the variances show no spread and the prior takes
        // over with infinite weight. Its variance is 2 / exp(digamma(2)) = 1.3104, not 1,
        // because the mean of a log variance sits below the log of the true variance.
        // t = 3 / sqrt(1.3104 * 2/3) = 3.2097 and p comes from the normal (reference: R).
        assert!(close(rows[0].t, 3.209_654_888_5, 1e-6) && close(rows[1].t, -3.209_654_888_5, 1e-6), "t = {}", rows[0].t);
        assert!(close(rows[0].p, 0.001_328_944_25, 1e-8), "p = {}", rows[0].p);
        // Two tests with the same p-value: adjustment leaves them equal to p.
        assert!(close(rows[0].p_adj, rows[0].p, 1e-12));
    }

    #[test]
    fn moderated_t_matches_the_r_reference() {
        // Three samples in A, four in B; expected values from scripts/check-moderated-t.R.
        #[rustfmt::skip]
        let values = [
            5.1, 4.9, 5.3,  6.9, 7.2, 7.0, 6.8,
            8.0, 8.4, 7.7,  8.1, 7.9, 8.3, 8.2,
            3.0, 3.6, 2.5,  2.0, 1.4, 2.6, 1.1,
            6.2, 6.1, 6.4,  6.0, 6.5, 6.3, 6.1,
            9.5, 8.1, 9.9, 11.0, 12.4, 10.2, 11.9,
            4.4, 4.0, 4.1,  5.0, 4.6, 4.9, 5.3,
        ];
        let matrix = Matrix::new(&values, 6, 7).unwrap();
        let rows = differential_expression(&matrix, &[0, 1, 2], &[3, 4, 5, 6], Transform::None).unwrap();
        let expected = [
            (1.875, 10.971_536_585, 8.342_764_148e-6, 5.005_658_489e-5),
            (0.091_666_666_7, 0.444_695_690_4, 0.669_395_602_2, 0.803_274_722_7),
            (-1.258_333_333, -3.051_637_728, 0.017_562_425_15, 0.026_343_637_72),
            (-0.008_333_333_3, -0.047_079_213_56, 0.963_709_271_9, 0.963_709_271_9),
            (2.208_333_333, 3.557_887_494, 0.008_590_815_059, 0.017_181_630_12),
            (0.783_333_333_3, 3.791_246_878, 0.006_252_951_03, 0.017_181_630_12),
        ];
        assert_eq!(rows.len(), expected.len());
        for (row, (fc, t, p, p_adj)) in rows.iter().zip(expected) {
            assert!(close(row.log2_fc, fc, 1e-8), "{row:?}");
            assert!(close(row.t, t, 1e-5 * t.abs().max(1.0)), "{row:?}");
            assert!(close(row.p, p, 1e-6 * p.max(1e-3)), "{row:?}");
            assert!(close(row.p_adj, p_adj, 1e-6 * p_adj.max(1e-3)), "{row:?}");
        }
    }

    #[test]
    fn counts_are_scaled_by_library_size_and_filtered() {
        // Sample B columns were sequenced twice as deep; gene 0 and 2 are unchanged in
        // proportion, gene 1 is truly doubled, gene 3 is too low to test.
        #[rustfmt::skip]
        let values = [
            100.0, 110.0,  90.0,   200.0, 220.0, 180.0,
            100.0,  90.0, 110.0,   400.0, 360.0, 440.0,
            800.0, 800.0, 800.0,  1400.0, 1420.0, 1380.0,
              1.0,   0.0,   2.0,     3.0,   1.0,   2.0,
        ];
        let matrix = Matrix::new(&values, 4, 6).unwrap();
        let rows = differential_expression(&matrix, &[0, 1, 2], &[3, 4, 5], Transform::Counts).unwrap();
        assert_eq!(rows.iter().map(|r| r.row).collect::<Vec<_>>(), vec![0, 1, 2]);
        // Library sizes are about 1000 and 2000, so gene 0's doubled counts are no change...
        assert!(rows[0].log2_fc.abs() < 0.05, "{}", rows[0].log2_fc);
        // ...and gene 1's fourfold counts are a twofold change.
        assert!(close(rows[1].log2_fc, 1.0, 0.05), "{}", rows[1].log2_fc);
    }

    #[test]
    fn groups_are_validated() {
        let values = [1.0; 8];
        let matrix = Matrix::new(&values, 2, 4).unwrap();
        assert!(differential_expression(&matrix, &[0], &[1, 2], Transform::None).is_err());
        assert!(differential_expression(&matrix, &[0, 1], &[1, 2], Transform::None).is_err());
        assert!(differential_expression(&matrix, &[0, 1], &[2, 9], Transform::None).is_err());
        assert!(Matrix::new(&values, 3, 3).is_err());
    }

    #[test]
    fn pca_separates_two_groups_on_the_first_component() {
        // 20 genes that differ between samples 0-2 and 3-5, plus small sample-specific noise.
        let mut values = Vec::new();
        for gene in 0..20 {
            for sample in 0..6 {
                let group = if sample < 3 { 0.0 } else { 4.0 };
                let noise = ((gene * 7 + sample * 13) % 5) as f64 * 0.05;
                values.push(group + noise);
            }
        }
        let matrix = Matrix::new(&values, 20, 6).unwrap();
        let result = pca(&matrix, &[0, 1, 2, 3, 4, 5], Transform::None, 1000, 3).unwrap();
        assert_eq!(result.genes, 20);
        assert_eq!(result.scores.len(), 6);
        assert_eq!(result.explained.len(), 3);
        assert!(result.explained[0] > 0.95, "{:?}", result.explained);
        assert!(result.explained.iter().sum::<f64>() <= 1.0 + 1e-9);
        let pc1: Vec<f64> = result.scores.iter().map(|s| s[0]).collect();
        // The two groups sit on opposite sides of zero.
        assert!(pc1[..3].iter().all(|v| v.signum() == pc1[0].signum()));
        assert!(pc1[3..].iter().all(|v| v.signum() == -pc1[0].signum()));
    }

    #[test]
    fn pca_needs_three_samples_and_some_variation() {
        let values = [1.0; 12];
        let matrix = Matrix::new(&values, 3, 4).unwrap();
        assert!(pca(&matrix, &[0, 1], Transform::None, 100, 2).is_err());
        assert!(pca(&matrix, &[0, 1, 2], Transform::None, 100, 2).is_err());
    }
}
