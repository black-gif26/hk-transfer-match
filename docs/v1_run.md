# Poisson V1

V0 remains the default. `python3 -m ucl_pipeline predict` and its Telegram message are unchanged.

V1 fits a regularised Poisson scoring model and compares it with V0 on a date-based walk-forward. Decay and L2 are chosen on 2024–25 only. 2025–26 is scored after that choice.

```bash
python3 -m ucl_pipeline v1 --output output --cache cache
python3 -m unittest tests.test_pipeline tests.test_poisson_v1
```

Artifacts go to `output/v1/<UTC timestamp>/`: `metrics.json`, `parameters.json`, `predictions_validation.csv`, `predictions_test.csv`, and `report.md`.

The fit uses matches dated before the first day of the fixture's month. Same-day matches stay out. Disputed scores stay out. A club with no earlier match is left without a probability. Sparse clubs are shrunk toward the zero-centred attack and defence averages and flagged when they have fewer than five matches. Competition levels are separate parameters; the most common competition in the fit is the zero reference. A cross-league flag means the two clubs never appear in the same competition in that fit.

## Convergence

The solver is a diagonal Newton step with backtracking and projection (attack and defence centred, reference competition pinned at 0). On the cached data it does not reach the 1e-5 step tolerance. One fit of the 8264 eligible matches before 2024-08-01 (decay 0.0015, L2 1, 256 teams) used 200 iterations in 1.35s and stopped at a max step of 5.59e-4. Between iterations 100 and 200 the largest attack change was 0.029 and the largest competition-level change was 0.054. Because those parameters are still moving, the walk-forward comparison was not treated as a finished evaluation, and no test-season metrics are reported. `tests.test_poisson_v1.PoissonV1Tests.test_cross_league_flag_and_walk_forward_keeps_test_out_of_selection` fails on `fits_converged`.
