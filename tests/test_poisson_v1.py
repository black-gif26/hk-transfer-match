"""Deterministic checks for the trained Poisson model."""

from __future__ import annotations

import unittest
from datetime import date, timedelta

from ucl_pipeline.models import Match
from ucl_pipeline.poisson_v1 import (
    V1Config,
    eligible_matches,
    fit_poisson,
    predict_rates,
    select_and_evaluate,
    time_weight,
)


def _match(day: date, home: str, away: str, hg: int, ag: int, competition: str = "League", season: str = "2023-24", ambiguous: bool = False) -> Match:
    return Match(day, season, competition, "", home, away, hg, ag, "test", 1, score_ambiguous=ambiguous)


class PoissonV1Tests(unittest.TestCase):
    def test_time_weight_decays_and_drops_same_day(self):
        cutoff = date(2024, 6, 1)
        self.assertEqual(time_weight(cutoff, cutoff, 0.01), 0.0)
        self.assertAlmostEqual(time_weight(cutoff - timedelta(days=100), cutoff, 0.01), 0.367879, places=5)
        self.assertEqual(time_weight(cutoff - timedelta(days=10), cutoff, 0.0), 1.0)

    def test_fit_is_finite_centered_and_sums_to_one(self):
        rows = []
        start = date(2023, 1, 1)
        for index in range(40):
            rows.append(_match(start + timedelta(days=index), "A", "B", 2, 0))
            rows.append(_match(start + timedelta(days=100 + index), "B", "A", 1, 1))
        fit = fit_poisson(rows, date(2024, 1, 1), decay=0.0, l2=0.1, config=V1Config(max_iter=200))
        self.assertTrue(fit.converged)
        self.assertGreater(fit.home_advantage, 0.0)
        self.assertAlmostEqual(sum(fit.attack.values()), 0.0, places=8)
        self.assertAlmostEqual(sum(fit.defence.values()), 0.0, places=8)
        self.assertGreater(fit.attack["A"], fit.attack["B"])
        pred = predict_rates(fit, "A", "B", "League")
        self.assertEqual(pred["abstain"], 0)
        self.assertGreater(pred["home_xg"], 0.0)
        self.assertGreater(pred["away_xg"], 0.0)
        self.assertAlmostEqual(pred["p_home"] + pred["p_draw"] + pred["p_away"], 1.0, places=8)
        self.assertAlmostEqual(pred["p_over_25"] + pred["p_under_25"], 1.0, places=8)
        self.assertGreaterEqual(pred["p_btts"], 0.0)
        self.assertLessEqual(pred["p_btts"], 1.0)

    def test_future_same_day_ambiguous_and_unseen_are_excluded(self):
        past = _match(date(2024, 5, 1), "A", "B", 1, 0)
        same_day = _match(date(2024, 6, 1), "A", "B", 8, 0)
        future = _match(date(2024, 7, 1), "A", "B", 9, 0)
        disputed = _match(date(2024, 5, 2), "A", "B", 1, 0, ambiguous=True)
        plain = fit_poisson([past], date(2024, 6, 1), 0.0, 0.1, V1Config(max_iter=20))
        contaminated = fit_poisson([past, same_day, future, disputed], date(2024, 6, 1), 0.0, 0.1, V1Config(max_iter=20))
        self.assertEqual(plain.n_matches, 1)
        self.assertEqual(contaminated.n_matches, 1)
        self.assertEqual(plain.attack, contaminated.attack)
        self.assertEqual(predict_rates(plain, "A", "Z", "League")["reason"], "unseen_team")

    def test_cross_league_flag_and_walk_forward_keeps_test_out_of_selection(self):
        rows = []
        for index in range(12):
            rows.append(_match(date(2024, 5, 1) + timedelta(days=index), "A", "B", 2, 0, season="2023-24"))
            rows.append(_match(date(2024, 5, 1) + timedelta(days=index), "C", "D", 1, 1, competition="Other", season="2023-24"))
        rows.append(_match(date(2024, 9, 3), "A", "B", 2, 1, season="2024-25"))
        rows.append(_match(date(2024, 9, 4), "C", "A", 0, 1, competition="Other", season="2024-25"))
        rows.append(_match(date(2025, 9, 3), "A", "B", 1, 0, season="2025-26"))
        config = V1Config(decays=(0.0,), l2_grid=(0.2,), max_iter=200)
        result = select_and_evaluate(rows, config)
        self.assertEqual(result["chosen"]["decay"], 0.0)
        self.assertEqual(result["test"]["v1"]["n"], result["test"]["n_comparable"])
        self.assertTrue(result["test"]["fits_converged"])
        self.assertLess(result["fit"].cutoff, date(2025, 9, 3))
        flagged = [row for row in result["validation_rows"] if row["home_team"] == "C" and row["away_team"] == "A"]
        self.assertIn("cross_league_strength", flagged[0]["v1_flags"])
        self.assertTrue(eligible_matches(rows))


if __name__ == "__main__":
    unittest.main()
