# The app's two-group comparison, written independently in base R, for checking the Rust code
# on a real count table. Both should report the same numbers:
#   Rscript scripts/check-moderated-t-on-counts.R counts.txt.gz TOTSHAM TOTOVLD
#   (cd src-tauri/analytics && cargo run --example compare -- counts.txt TOTSHAM TOTOVLD)
args <- commandArgs(TRUE)
x <- read.delim(gzfile(args[1]), check.names = FALSE)
a <- grep(args[2], colnames(x)); b <- grep(args[3], colnames(x))
m <- as.matrix(x[, c(a, b)]); ia <- seq_along(a); ib <- length(a) + seq_along(b)
lib <- colSums(m); keep <- rowSums(m >= 10) >= min(length(a), length(b))
y <- log2(t((t(m[keep, ]) + 0.5) / (lib + 1) * 1e6))
df <- length(a) + length(b) - 2
s2 <- ((length(a) - 1) * apply(y[, ia], 1, var) + (length(b) - 1) * apply(y[, ib], 1, var)) / df
ok <- s2 > 0; y <- y[ok, ]; s2 <- s2[ok]
fc <- rowMeans(y[, ib]) - rowMeans(y[, ia])
A <- (length(a) * rowMeans(y[, ia]) + length(b) * rowMeans(y[, ib])) / (length(a) + length(b))
e <- log(s2) - digamma(df / 2) + log(df / 2)
# Trend: equal-count bins by expression, bin means joined by straight lines (as in the Rust code).
n <- length(e); bins <- max(1, min(20, n %/% 200)); o <- order(A)
kx <- ky <- numeric(bins)
for (k in 1:bins) { idx <- o[(floor((k - 1) * n / bins) + 1):floor(k * n / bins)]; kx[k] <- mean(A[idx]); ky[k] <- mean(e[idx]) }
trend <- if (bins > 1) approx(kx, ky, xout = A, rule = 2)$y else rep(ky[1], n)
spread <- sum((e - trend)^2) / (n - bins) - trigamma(df / 2)
d0 <- if (spread > 0) 2 * uniroot(function(v) trigamma(v) - spread, c(1e-8, 1e8), tol = 1e-14)$root else Inf
s0 <- if (is.finite(d0)) exp(trend + digamma(d0 / 2) - log(d0 / 2)) else exp(trend)
post <- if (is.finite(d0)) (d0 * s0 + df * s2) / (d0 + df) else s0
t <- fc / sqrt(post * (1 / length(a) + 1 / length(b)))
p <- if (is.finite(d0)) 2 * pt(-abs(t), d0 + df) else 2 * pnorm(-abs(t))
padj <- p.adjust(p, "BH")
cat(args[1], ": groups", length(a), "vs", length(b), " tested", length(p), " d0", round(d0, 2), " s0^2 range", signif(range(s0), 4),
    " min padj", signif(min(padj), 3), " padj<0.05:", sum(padj < 0.05), " and |lfc|>=1:", sum(padj < 0.05 & abs(fc) >= 1), " sum|t|", round(sum(abs(t)), 4), "\n")
