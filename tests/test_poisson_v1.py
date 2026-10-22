"""Deterministic checks for the trained Poisson model."""

from __future__ import annotations

import json
import math
import unittest
from datetime import date, timedelta
from pathlib import Path

from ucl_pipeline.models import Match
from ucl_pipeline.poisson_v1 import (
    V1Config,
    competition_flags,
    eligible_matches,
    fit_poisson,
    initial_theta,
    objective_and_gradient,
    pick_validation_candidate,
    predict_rates,
    select_and_evaluate,
    time_weight,
)
from ucl_pipeline.shadow import label_prediction, render_draft, write_shadow
from ucl_pipeline.web_fixtures import EL_2026_10_22, hkjc_label
from ucl_pipeline.v1_audit import leakage_problems


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
        self.assertLessEqual(fit.grad_inf, 1e-5)
        self.assertTrue(math.isfinite(fit.objective))
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
        self.assertIn("cross_domestic_league", flagged[0]["v1_flags"])
        self.assertTrue(eligible_matches(rows))

    def test_analytic_gradient_matches_finite_differences(self):
        rows = []
        start = date(2023, 3, 1)
        for index in range(8):
            rows.append(_match(start + timedelta(days=index), "A", "B", 2, 0, competition="League"))
            rows.append(_match(start + timedelta(days=20 + index), "B", "C", 1, 2, competition="League"))
            rows.append(_match(start + timedelta(days=40 + index), "C", "A", 0, 1, competition="Cup"))
        cutoff = date(2023, 8, 1)
        theta = initial_theta(rows, cutoff, 0.002, "shifted")
        loss, grad = objective_and_gradient(rows, cutoff, 0.002, 0.7, theta)
        self.assertTrue(math.isfinite(loss))
        step = 1e-6
        for index in range(theta.size):
            up = theta.copy()
            down = theta.copy()
            up[index] += step
            down[index] -= step
            loss_up, _gradient = objective_and_gradient(rows, cutoff, 0.002, 0.7, up)
            loss_down, _gradient = objective_and_gradient(rows, cutoff, 0.002, 0.7, down)
            finite = (loss_up - loss_down) / (2.0 * step)
            self.assertAlmostEqual(finite, float(grad[index]), places=5)
        fit = fit_poisson(rows, cutoff, 0.002, 0.7, V1Config(max_iter=200))
        self.assertTrue(fit.converged)
        self.assertLessEqual(fit.grad_inf, 1e-5)
        self.assertEqual(fit.n_components, 1)
        self.assertEqual(fit.competition["League"], 0.0)
        self.assertAlmostEqual(sum(fit.attack.values()), 0.0, places=8)
        self.assertAlmostEqual(sum(fit.defence.values()), 0.0, places=8)

    def test_disconnected_components_stay_in_the_reduced_parameterization(self):
        rows = []
        start = date(2023, 4, 1)
        for index in range(10):
            rows.append(_match(start + timedelta(days=index), "A", "B", 3, 1, competition="League"))
            rows.append(_match(start + timedelta(days=index), "C", "D", 0, 0, competition="Other"))
        cutoff = date(2023, 6, 1)
        config = V1Config(max_iter=200)
        fits = [
            fit_poisson(rows, cutoff, 0.001, 1.0, config, x0=initial_theta(rows, cutoff, 0.001, kind))
            for kind in ("mean_rate", "zeros", "shifted")
        ]
        self.assertTrue(all(fit.converged for fit in fits))
        self.assertTrue(all(fit.n_components == 2 for fit in fits))
        self.assertTrue(all(fit.grad_inf <= 1e-5 for fit in fits))
        objectives = [fit.objective for fit in fits]
        self.assertAlmostEqual(max(objectives) - min(objectives), 0.0, places=6)
        home = [predict_rates(fit, "A", "B", "League")["home_xg"] for fit in fits]
        self.assertAlmostEqual(max(home) - min(home), 0.0, places=5)

    def test_domestic_flag_is_separate_from_no_shared_competition(self):
        shared_europe = competition_flags(
            {"English Premier League", "UEFA Champions League"},
            {"La Liga", "UEFA Champions League"},
            10,
            10,
        )
        self.assertEqual(shared_europe, ["cross_domestic_league"])
        self.assertEqual(competition_flags({"Bundesliga"}, {"Bundesliga"}, 10, 10), [])
        self.assertIn("cross_league_strength", competition_flags({"Primeira Liga"}, {"Eredivisie"}, 10, 10))

    def test_failed_validation_month_is_ineligible(self):
        failed = {"fits_converged": False, "metrics": {"n": 10, "log_loss_1x2": 0.1}}
        kept = {"fits_converged": True, "metrics": {"n": 10, "log_loss_1x2": 0.9}, "decay": 0.0015}
        chosen = pick_validation_candidate([failed, kept])
        self.assertEqual(chosen["decay"], 0.0015)
        with self.assertRaises(ValueError):
            pick_validation_candidate([failed])

    def test_shadow_refits_before_cutoff_and_does_not_write_telegram(self):
        history = [
            _match(date(2024, 5, 1), "A", "B", 2, 0),
            _match(date(2024, 5, 2), "A", "B", 1, 0),
            _match(date(2026, 10, 22), "A", "B", 9, 0),
        ]
        fixture = _match(date(2026, 10, 22), "A", "B", None, None)
        folder = write_shadow(history, [fixture], date(2026, 10, 22), Path("output"), stamp="test-shadow")
        text = (folder / "fit.json").read_text(encoding="utf-8")
        self.assertIn("2026-10-22", text)
        self.assertIn('"telegram": false', text)
        self.assertNotIn("2026-05-01", text)
        saved = (folder / "predictions.csv").read_text(encoding="utf-8")
        self.assertIn("A", saved)
        self.assertFalse((folder / "telegram_message.txt").exists())
        payload = json.loads(text)
        self.assertEqual(payload["data_version"]["max_date"], "2024-05-02")
        self.assertLess(payload["fit"]["n_matches"], 3)

    def test_europa_v1_is_experimental_and_unseen_teams_abstain(self):
        fixture = _match(date(2026, 10, 22), "A", "B", None, None)
        fixture = Match(
            fixture.date, fixture.season, "UEFA Europa League", "", "A", "B", None, None, "uefa.com", 9, kickoff="00:45 HK"
        )
        labelled = label_prediction(fixture, {"abstain": 0, "reason": ""}, {"p_home": 0.5})
        self.assertEqual(labelled["role"], "v1_experimental")
        self.assertIn("reference_competition_level", labelled["warnings"])
        unseen = label_prediction(fixture, {"abstain": 1, "reason": "unseen_team"}, {"p_home": ""})
        self.assertEqual(unseen["role"], "abstain")
        fallback = label_prediction(fixture, {"abstain": 1, "reason": "unseen_team"}, {"p_home": 0.4})
        self.assertEqual(fallback["role"], "v0_fallback")
        text = render_draft(
            [
                {
                    "kickoff": "00:45 HK",
                    "home_team": "A",
                    "away_team": "B",
                    "role": "v1_experimental",
                    "p_home_v1": 0.5,
                    "p_draw_v1": 0.25,
                    "p_away_v1": 0.25,
                    "p_over_v1": 0.6,
                    "p_btts_v1": 0.55,
                    "home_xg_v1": 1.7,
                    "away_xg_v1": 1.1,
                },
                {
                    "kickoff": "03:00 HK",
                    "home_team": "C",
                    "away_team": "D",
                    "role": "abstain",
                },
            ],
            {
                "updated_at_hkt": "2026-10-22 16:00 香港時間",
                "prediction_cutoff": "2026-10-22",
                "data_version": {"sha256_12": "abc", "max_date": "2026-09-20"},
                "source_summary": "齊全度未知",
            },
        )
        self.assertIn("V1實驗", text)
        self.assertIn("無法預測", text)
        self.assertIn("不是賽果", text)
        named = render_draft(
            [
                {
                    "kickoff": "00:45 HK",
                    "hkjc_code": "FB7332",
                    "home_zh": "祖雲達斯",
                    "away_zh": "雷恩",
                    "home_team": "Juventus FC",
                    "away_team": "Stade Rennais FC 1901",
                    "role": "v1_experimental",
                    "p_home_v1": 0.516,
                    "p_draw_v1": 0.249,
                    "p_away_v1": 0.235,
                    "p_over_v1": 0.483,
                    "p_btts_v1": 0.505,
                    "home_xg_v1": 1.61,
                    "away_xg_v1": 1.00,
                }
            ],
            {
                "updated_at_hkt": "2026-10-22 16:00 香港時間",
                "prediction_cutoff": "2026-10-22",
                "data_version": {"sha256_12": "abc", "max_date": "2026-09-20"},
                "source_summary": "齊全度未知",
            },
        )
        self.assertIn("FB7332 祖雲達斯 vs 雷恩", named)
        self.assertNotIn("Juventus", named)
        self.assertIn("大2.5 48.3%｜小2.5 51.7% → 傾向小", named)
        self.assertIn("V1實驗", text)
        self.assertIn("大2.5 60.0%｜小2.5 40.0% → 傾向大", text)
        labelled = [hkjc_label(home, away) for _kick, home, away in EL_2026_10_22]
        self.assertEqual(len(labelled), 18)
        self.assertTrue(all(code.startswith("FB") and home_zh and away_zh for code, home_zh, away_zh in labelled))

    def test_leakage_check_rejects_a_row_before_its_cutoff(self):
        row = {
            "season": "2025-26",
            "date": "2025-09-03",
            "cutoff": "2025-10-01",
            "date_obj": date(2025, 9, 3),
            "cutoff_obj": date(2025, 10, 1),
            "v1_ok": 1,
            "converged": 1,
            "home_team": "A",
        }
        self.assertTrue(leakage_problems([row], "2025-26"))


if __name__ == "__main__":
    unittest.main()
