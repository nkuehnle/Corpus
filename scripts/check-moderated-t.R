# Independent reference for the moderated t-test in src-tauri/analytics, written with base R's
# own special functions (the method of limma's squeezeVar / eBayes, Smyth 2004).
#   Rscript scripts/check-moderated-t.R
fit_prior <- function(s2, df) {
  e <- log(s2) - digamma(df / 2) + log(df / 2)
  spread <- sum((e - mean(e))^2) / (length(e) - 1) - trigamma(df / 2)
  if (spread <= 0) return(list(d0 = Inf, s0 = exp(mean(e))))
  # Solve trigamma(y) = spread.
  y <- uniroot(function(y) trigamma(y) - spread, c(1e-8, 1e8), tol = 1e-14)$root
  d0 <- 2 * y
  list(d0 = d0, s0 = exp(mean(e) + digamma(d0 / 2) - log(d0 / 2)))
}
options(digits = 12)
p <- fit_prior(c(0.5, 1, 2, 0.25, 4, 1.5, 0.75, 3), 4)
cat("prior d0 =", p$d0, " s0^2 =", p$s0, "\n")

# A small log-scale matrix: 3 samples in A, 4 in B.
y <- rbind(
  c(5.1, 4.9, 5.3, 6.9, 7.2, 7.0, 6.8),
  c(8.0, 8.4, 7.7, 8.1, 7.9, 8.3, 8.2),
  c(3.0, 3.6, 2.5, 2.0, 1.4, 2.6, 1.1),
  c(6.2, 6.1, 6.4, 6.0, 6.5, 6.3, 6.1),
  c(9.5, 8.1, 9.9, 11.0, 12.4, 10.2, 11.9),
  c(4.4, 4.0, 4.1, 5.0, 4.6, 4.9, 5.3)
)
a <- 1:3; b <- 4:7; df <- 5
s2 <- apply(y, 1, function(r) (2 * var(r[a]) + 3 * var(r[b])) / df)
fc <- rowMeans(y[, b]) - rowMeans(y[, a])
p <- fit_prior(s2, df)
post <- (p$d0 * p$s0 + df * s2) / (p$d0 + df)
t <- fc / sqrt(post * (1 / 3 + 1 / 4))
pv <- 2 * pt(-abs(t), p$d0 + df)
cat("matrix d0 =", p$d0, " s0^2 =", p$s0, "\n")
print(cbind(log2fc = fc, t = t, p = pv, padj = p.adjust(pv, "BH")))
