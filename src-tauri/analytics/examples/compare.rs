//! Runs the two-group comparison on a tab-separated count table, for checking against R:
//!   cargo run --example compare -- counts.txt TOTSHAM TOTOVLD
//! Groups are the columns whose names contain each pattern. Compare with scripts/check-moderated-t.R.
use corpus_analytics::{differential_expression, Matrix, Transform};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let text = std::fs::read_to_string(&args[1]).expect("readable file");
    let mut lines = text.lines();
    let header: Vec<&str> = lines.next().expect("a header line").split('\t').collect();
    let columns = |pattern: &str| -> Vec<usize> { header.iter().enumerate().filter(|(_, h)| h.contains(pattern)).map(|(i, _)| i).collect() };
    let (a, b) = (columns(&args[2]), columns(&args[3]));
    let chosen: Vec<usize> = a.iter().chain(&b).copied().collect();

    let mut values = Vec::new();
    let mut rows = 0;
    for line in lines {
        let cells: Vec<&str> = line.split('\t').collect();
        values.extend(chosen.iter().map(|&c| cells[c].parse::<f64>().unwrap_or(f64::NAN)));
        rows += 1;
    }
    let matrix = Matrix::new(&values, rows, chosen.len()).unwrap();
    let group_a: Vec<usize> = (0..a.len()).collect();
    let group_b: Vec<usize> = (a.len()..chosen.len()).collect();
    let result = differential_expression(&matrix, &group_a, &group_b, Transform::Counts).unwrap();

    let significant = result.iter().filter(|r| r.p_adj < 0.05).count();
    let large = result.iter().filter(|r| r.p_adj < 0.05 && r.log2_fc.abs() >= 1.0).count();
    let smallest = result.iter().map(|r| r.p_adj).fold(f64::INFINITY, f64::min);
    let sum_t: f64 = result.iter().map(|r| r.t.abs()).sum();
    println!("groups {} vs {}  tested {}  min padj {smallest:.3e}  padj<0.05: {significant}  and |lfc|>=1: {large}  sum|t| {sum_t:.4}", a.len(), b.len(), result.len());
}
