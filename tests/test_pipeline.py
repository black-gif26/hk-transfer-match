"""Unit tests that do not download the source repositories."""

from __future__ import annotations

import unittest
from datetime import date

from ucl_pipeline.dedupe import dedupe
from ucl_pipeline.predict import (
    compare_windows,
    format_message,
    outcome_probs,
    predict_fixture,
    score_markets,
    training_seasons,
    usable_history,
)
from ucl_pipeline.telegram import credentials_from_env
from ucl_pipeline.fbtxt import parse_champions_league_text, parse_fb_date
from ucl_pipeline.features import build_features
from ucl_pipeline.models import SOURCE_PRIORITY, Match
from ucl_pipeline.normalize import normalize_team, season_key
from ucl_pipeline.scores import parse_score


class ScoreTests(unittest.TestCase):
    def test_ninety_minutes_separated_from_extra_time_and_penalties(self):
        parsed = parse_score("1-4 pen. 0-1 a.e.t. (0-1, 0-1)")
        self.assertEqual((parsed.home_goals, parsed.away_goals), (0, 1))
        self.assertFalse(parsed.ambiguous)

    def test_extra_time_headline_is_not_the_ninety_minute_score(self):
        parsed = parse_score("2-3 a.e.t. (1-3, 0-1)")
        self.assertEqual((parsed.home_goals, parsed.away_goals), (1, 3))
        self.assertFalse(parsed.ambiguous)

    def test_plain_full_time_and_half_time(self):
        parsed = parse_score("6-3 (3-1)")
        self.assertEqual((parsed.home_goals, parsed.away_goals), (6, 3))
        self.assertFalse(parsed.ambiguous)

    def test_extra_time_without_ninety_minute_score_is_ambiguous(self):
        parsed = parse_score("2-2 a.e.t.")
        self.assertTrue(parsed.ambiguous)
        self.assertIsNone(parsed.home_goals)


class TextTests(unittest.TestCase):
    SAMPLE = """
= UEFA Champions League 2024/25

▪ Finals, Round of 16
  Tue Dec 10 2024
    21:00  Paris Saint-Germain (FRA) v Liverpool FC (ENG)  0-1 (0-0)
  Wed Jan 15
    21:00  Liverpool FC (ENG) v Paris Saint-Germain FC (FRA)  1-4 pen. 0-1 a.e.t. (0-1, 0-1)
           Manchester City (ENG) v Real Madrid (ESP)  2-2 a.e.t.
"""

    def test_group_restart_stays_in_the_same_season(self):
        text = """
= UEFA Champions League 2021/22
▪ Group A
  Tue Dec 7 2021
    21:00  Liverpool FC (ENG) v AC Milan (ITA)  1-0
▪ Group B
  Wed Sep 15
    21:00  Club Atlético de Madrid (ESP) v FC Porto (POR)  2-1 (1-0)
"""
        matches, _stats = parse_champions_league_text(text, path_season="2021-22", qualifying=False)
        self.assertEqual(matches[0].date, date(2021, 12, 7))
        self.assertEqual(matches[1].date, date(2021, 9, 15))
        self.assertEqual((matches[1].home_goals, matches[1].away_goals), (2, 1))

    def test_year_rolls_forward_and_scores_are_split(self):
        matches, stats = parse_champions_league_text(
            self.SAMPLE, path_season="2024-25", qualifying=False
        )
        self.assertEqual(stats["ambiguous"], 1)
        self.assertEqual(matches[0].date, date(2024, 12, 10))
        self.assertEqual(matches[1].date, date(2025, 1, 15))
        self.assertEqual(matches[1].home_team, "Liverpool FC")
        self.assertEqual(matches[1].away_team, "Paris Saint-Germain FC")
        self.assertEqual((matches[1].home_goals, matches[1].away_goals), (0, 1))
        self.assertTrue(matches[2].score_ambiguous)
        self.assertIsNone(matches[2].home_goals)

    def test_date_helper_uses_season_when_no_previous_date(self):
        self.assertEqual(parse_fb_date("Wed Jan 15", None, "2024-25"), date(2025, 1, 15))
        self.assertEqual(parse_fb_date("Tue Sep 17 2024", None, "2024-25"), date(2024, 9, 17))


class NormalizeTests(unittest.TestCase):
    def test_aliases_and_season(self):
        self.assertEqual(normalize_team("Manchester City (ENG)"), "Manchester City FC")
        self.assertEqual(normalize_team("SL Benfica"), "Sport Lisboa e Benfica")
        self.assertEqual(normalize_team("AZ Alkmaar"), "AZ")
        self.assertEqual(normalize_team("NEC Nijmegen"), "NEC")
        self.assertEqual(season_key("2024/2025"), "2024-25")
        self.assertEqual(normalize_team("Paris FC"), "Paris FC")


class DedupeTests(unittest.TestCase):
    def test_priority_keeps_openfootball_and_flags_conflict(self):
        left = Match(
            date=date(2025, 3, 11),
            season="2024-25",
            competition="UEFA Champions League",
            stage="Round of 16",
            home_team="Liverpool FC",
            away_team="Paris Saint-Germain FC",
            home_goals=0,
            away_goals=1,
            source="openfootball-cl",
            priority=SOURCE_PRIORITY["openfootball-cl"],
        )
        right = Match(
            date=date(2025, 3, 11),
            season="2024-25",
            competition="UEFA Champions League",
            stage="Finals, Round of 16",
            home_team="Liverpool FC",
            away_team="Paris Saint-Germain FC",
            home_goals=1,
            away_goals=4,
            source="paperfox",
            priority=SOURCE_PRIORITY["paperfox"],
        )
        kept, conflicts, _ambiguous = dedupe([right, left])
        self.assertEqual(len(kept), 1)
        self.assertEqual(kept[0].source, "openfootball-cl")
        self.assertEqual((kept[0].home_goals, kept[0].away_goals), (0, 1))
        self.assertEqual(conflicts[0]["reason"], "score_conflict")

    def test_awarded_flag_survives_when_scores_agree(self):
        played = Match(
            date=date(2024, 12, 14),
            season="2024-25",
            competition="Bundesliga",
            stage="Matchday 14",
            home_team="1. FC Union Berlin",
            away_team="VfL Bochum 1848",
            home_goals=0,
            away_goals=2,
            source="football.json",
            priority=SOURCE_PRIORITY["football.json"],
        )
        awarded = Match(
            date=date(2024, 12, 14),
            season="2024-25",
            competition="Bundesliga",
            stage="REGULAR_SEASON",
            home_team="1. FC Union Berlin",
            away_team="VfL Bochum 1848",
            home_goals=0,
            away_goals=2,
            source="tarekmasryo",
            priority=SOURCE_PRIORITY["tarekmasryo"],
            score_ambiguous=True,
            ambiguous_reason="awarded",
        )
        kept, conflicts, ambiguous = dedupe([played, awarded])
        self.assertEqual(len(conflicts), 0)
        self.assertTrue(kept[0].score_ambiguous)
        self.assertEqual(kept[0].ambiguous_reason, "awarded")
        self.assertEqual(ambiguous[0]["reason"], "awarded")


class FeatureTests(unittest.TestCase):
    def test_no_future_or_same_day_leakage_and_insufficient_flag(self):
        rows = [
            Match(date(2024, 8, 1), "2024-25", "English Premier League", "Matchday 1",
                  "Arsenal FC", "Chelsea FC", 2, 0, "football.json", 2),
            Match(date(2024, 8, 10), "2024-25", "English Premier League", "Matchday 2",
                  "Chelsea FC", "Arsenal FC", 1, 1, "football.json", 2),
            Match(date(2024, 8, 20), "2024-25", "UEFA Champions League", "League",
                  "Arsenal FC", "Bayern", 1, 0, "openfootball-cl", 1),
            Match(date(2024, 8, 20), "2024-25", "English Premier League", "Matchday 3",
                  "Arsenal FC", "Spurs", 4, 0, "football.json", 2),
            Match(date(2024, 9, 1), "2024-25", "UEFA Champions League", "League",
                  "Arsenal FC", "PSV", 3, 1, "openfootball-cl", 1),
        ]
        features = build_features(rows)
        first = features[0]
        self.assertEqual(first["home_prior_n"], 2)
        self.assertEqual(first["home_last5_w"], 1)
        self.assertEqual(first["home_last5_d"], 1)
        self.assertEqual(first["home_last5_gf"], 3)
        self.assertEqual(first["home_rest_days"], 10)
        self.assertEqual(first["home_insufficient_history"], 1)
        self.assertEqual(first["away_prior_n"], 0)
        self.assertEqual(first["away_insufficient_history"], 1)
        second = features[1]
        # The same-day league match is visible only to later fixtures.
        self.assertEqual(second["home_prior_n"], 4)
        self.assertEqual(second["home_last5_gf"], 8)
        self.assertEqual(second["home_last5_w"], 3)
        self.assertEqual(second["home_rest_days"], 12)
        self.assertEqual(second["home_insufficient_history"], 1)
        self.assertEqual(second["home_last20_gf"], 8)


class PredictTests(unittest.TestCase):
    def test_poisson_probabilities_sum_to_one_and_favour_the_stronger_side(self):
        home, draw, away = outcome_probs(2.0, 0.6)
        self.assertAlmostEqual(home + draw + away, 1.0, places=6)
        self.assertGreater(home, away)
        busy = score_markets(2.0, 1.4)
        quiet = score_markets(0.8, 0.6)
        self.assertAlmostEqual(busy["p_over_25"] + busy["p_under_25"], 1.0, places=6)
        self.assertGreater(busy["p_over_25"], quiet["p_over_25"])
        self.assertGreater(busy["p_btts"], quiet["p_btts"])
        self.assertGreater(busy["p_btts"], 0.0)
        self.assertLess(busy["p_btts"], 1.0)

    def test_prediction_uses_recent_rates_and_flags_short_history(self):
        feature = {
            "date": "2026-10-21",
            "kickoff": "20:00",
            "season": "2026-27",
            "competition": "La Liga",
            "stage": "Matchday 6",
            "home_team": "Levante UD",
            "away_team": "Athletic Club",
            "home_prior_n": 4,
            "away_prior_n": 12,
            "home_last10_gf": 6,
            "home_last10_ga": 4,
            "away_last10_gf": 15,
            "away_last10_ga": 8,
        }
        row = predict_fixture(feature, (1.6, 1.2))
        self.assertEqual(row["low_confidence"], 1)
        self.assertIn(row["pick"], {"home", "draw", "away"})
        self.assertAlmostEqual(float(row["p_home"]) + float(row["p_draw"]) + float(row["p_away"]), 1.0, places=2)
        self.assertAlmostEqual(float(row["p_over_25"]) + float(row["p_under_25"]), 1.0, places=2)
        self.assertGreater(float(row["home_xg"]), 0)
        self.assertGreater(float(row["away_xg"]), 0)

    def test_windows_use_latest_complete_seasons_and_drop_future_updates(self):
        self.assertEqual(training_seasons(2), ("2024-25", "2025-26"))
        self.assertEqual(training_seasons(3), ("2023-24", "2024-25", "2025-26"))
        self.assertEqual(training_seasons(5)[0], "2021-22")
        matches = [
            Match(date(2024, 5, 1), "2023-24", "UEFA Champions League", "", "A", "B", 1, 0, "x", 1),
            Match(date(2025, 5, 1), "2024-25", "UEFA Champions League", "", "A", "B", 2, 0, "x", 1),
            Match(date(2026, 10, 20), "2026-27", "La Liga", "", "A", "C", 1, 0, "x", 2),
            Match(date(2026, 10, 21), "2026-27", "La Liga", "", "A", "D", 3, 0, "x", 2),
            Match(date(2022, 5, 1), "2021-22", "UEFA Champions League", "", "A", "E", 1, 1, "x", 1),
        ]
        kept = usable_history(matches, 2, date(2026, 10, 21))
        self.assertEqual({(match.season, match.away_team) for match in kept}, {("2024-25", "B"), ("2026-27", "C")})

    def test_europa_league_uses_champions_league_home_edge_when_it_has_no_history(self):
        history = []
        for index in range(12):
            history.append(
                Match(
                    date(2025, 9, 1 + index),
                    "2025-26",
                    "UEFA Champions League",
                    "",
                    "Home Side",
                    "Away Side",
                    2,
                    0,
                    "x",
                    1,
                )
            )
        fixture = Match(
            date(2026, 10, 22),
            "2026-27",
            "UEFA Europa League",
            "League phase Matchday 3",
            "Home Side",
            "Away Side",
            None,
            None,
            "uefa.com",
            9,
            kickoff="00:45 HK",
        )
        rows = [row for row in compare_windows(history, [fixture]) if row["train_window"] == 5 and row["form_n"] == 10]
        self.assertEqual(len(rows), 1)
        self.assertNotEqual(rows[0]["p_home"], "")
        self.assertIn("home_edge_from_champions_league", rows[0]["note"])

    def test_message_states_when_no_fixture_exists(self):
        text = format_message(date(2026, 10, 21), [], ["checked"])
        self.assertIn("沒有未開賽", text)
        self.assertIn("checked", text)

    def test_telegram_credentials_are_not_hardcoded(self):
        token, chat = credentials_from_env()
        self.assertFalse(token)
        self.assertFalse(chat)


if __name__ == "__main__":
    unittest.main()
