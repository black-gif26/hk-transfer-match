# Poisson V1

V0 remains the default. `python3 -m ucl_pipeline predict` and its Telegram message are unchanged.

V1 fits a regularised Poisson scoring model and compares it with V0 on a date-based walk-forward. Decay and L2 are chosen on 2024–25 only. 2025–26 is scored after that choice.

```bash
python3 -m ucl_pipeline v1 --output output --cache cache
python3 -m unittest tests.test_pipeline tests.test_poisson_v1
```

Artifacts go to `output/v1/<UTC timestamp>/`: `metrics.json`, `parameters.json`, `predictions_validation.csv`, `predictions_test.csv`, and `report.md`.

The fit uses matches dated before the first day of the fixture's month. Same-day matches stay out. Disputed scores stay out. A club with no earlier match is left without a probability. Sparse clubs are shrunk toward the zero-centred attack and defence averages and flagged when they have fewer than five matches. Competition levels are separate parameters; the most common competition in the fit is the zero reference. A cross-league flag means the two clubs never appear in the same competition in that fit.

The objective is a sum, not a mean:

`L = Σ w_i (exp(η_home) - y_home η_home + exp(η_away) - y_away η_away) + (l2 / 2) * (home advantage² + every attack² + every defence² + every non-reference competition²)`.

`w_i` is 1 when decay is 0 and `exp(-decay * days before cutoff)` otherwise. L2 is not scaled by the number of matches. Attack sums to 0 and defence sums to 0 inside the parameter vector. The reference competition is fixed at 0. The training loss does not clip η. Solver: `scipy.optimize.minimize`, method L-BFGS-B, `gtol` 1e-5, `maxiter` 2000. A fit is converged only when L-BFGS-B reports success and the analytic gradient infinity norm is at most 1e-5. Parameters.json records the optimizer status, message, iterations, objective, gradient infinity norm, runtime, bound hits, and how many fitted η values fall outside the prediction guard. The guard is not applied inside the training loss. Connected components of the match graph are counted; a cross-league flag still means the two clubs share no competition in that fit. Grid points that miss the gradient check stay in `metrics.json` under `failed_fits` and are not used for the 2025–26 score. Decay 0.0015 and L2 4 are frozen from that 2024–25 choice.

`cross_league_strength` means the clubs never share a competition in the fit. `cross_domestic_league` means their domestic leagues differ, including when they have both played in Europe.

```bash
python3 -m ucl_pipeline v1-audit --folder output/v1/<stamp> --cache cache
python3 -m ucl_pipeline shadow --date YYYY-MM-DD --output output --cache cache
```

Shadow refits frozen V1 on matches dated before that day and writes `output/shadow/<UTC stamp>/`. It does not call Telegram. The draft prints HKJC coupon names when a fixture has one. English names in the CSV stay the model keys. Each priced line shows both sides of over/under 2.5 and names the higher one, so an over probability under one half is labelled as the under.
