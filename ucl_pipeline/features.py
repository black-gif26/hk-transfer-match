"""Prior-form features for UCL matches.

History is domestic plus UCL (including qualifying) and uses only matches
dated strictly before the fixture. Same-day matches are left out because
kickoff order is not known for every source. Ambiguous scores are not used
as history.
"""

from __future__ import annotations

from collections import defaultdict

from ucl_pipeline.models import Match

FEATURE_FIELDS = [
    "date",
    "season",
    "competition",
    "stage",
    "home_team",
    "away_team",
    "home_goals",
    "away_goals",
    "label_score_ambiguous",
    "home_prior_n",
    "home_last5_w",
    "home_last5_d",
    "home_last5_l",
    "home_last5_gf",
    "home_last5_ga",
    "home_last10_w",
    "home_last10_d",
    "home_last10_l",
    "home_last10_gf",
    "home_last10_ga",
    "home_last20_w",
    "home_last20_d",
    "home_last20_l",
    "home_last20_gf",
    "home_last20_ga",
    "home_rest_days",
    "home_insufficient_history",
    "away_prior_n",
    "away_last5_w",
    "away_last5_d",
    "away_last5_l",
    "away_last5_gf",
    "away_last5_ga",
    "away_last10_w",
    "away_last10_d",
    "away_last10_l",
    "away_last10_gf",
    "away_last10_ga",
    "away_last20_w",
    "away_last20_d",
    "away_last20_l",
    "away_last20_gf",
    "away_last20_ga",
    "away_rest_days",
    "away_insufficient_history",
]


def _split(rows: list[tuple]) -> dict[str, int]:
    wins = draws = losses = goals_for = goals_against = 0
    for _when, scored, conceded in rows:
        goals_for += scored
        goals_against += conceded
        if scored > conceded:
            wins += 1
        elif scored < conceded:
            losses += 1
        else:
            draws += 1
    return {
        "w": wins,
        "d": draws,
        "l": losses,
        "gf": goals_for,
        "ga": goals_against,
    }


def build_features(matches: list[Match], targets: list[Match] | None = None) -> list[dict]:
    played = [
        match
        for match in matches
        if match.goals_pair() is not None and not match.score_ambiguous
    ]
    played.sort(key=lambda match: (match.date, match.competition, match.home_team, match.away_team))
    if targets is None:
        targets = [
            match
            for match in matches
            if match.competition == "UEFA Champions League" and match.goals_pair() is not None
        ]
    targets = sorted(targets, key=lambda match: (match.date, match.home_team, match.away_team))

    history: dict[str, list[tuple]] = defaultdict(list)
    index = 0
    rows: list[dict] = []
    for target in targets:
        while index < len(played) and played[index].date < target.date:
            event = played[index]
            history[event.home_team].append((event.date, event.home_goals, event.away_goals))
            history[event.away_team].append((event.date, event.away_goals, event.home_goals))
            index += 1
        home_hist = history.get(target.home_team, [])
        away_hist = history.get(target.away_team, [])
        row: dict[str, object] = {
            "date": target.date.isoformat(),
            "season": target.season,
            "competition": target.competition,
            "stage": target.stage,
            "home_team": target.home_team,
            "away_team": target.away_team,
            "home_goals": target.home_goals,
            "away_goals": target.away_goals,
            "label_score_ambiguous": 1 if target.score_ambiguous else 0,
        }
        row.update(_form_block(home_hist, target, "home"))
        row.update(_form_block(away_hist, target, "away"))
        rows.append(row)
    return rows


def _form_block(history: list[tuple], target: Match, prefix: str) -> dict[str, object]:
    prior = len(history)
    last5 = _split(history[-5:])
    last10 = _split(history[-10:])
    last20 = _split(history[-20:])
    rest: object = ""
    if history:
        rest = (target.date - history[-1][0]).days
    block: dict[str, object] = {
        f"{prefix}_prior_n": prior,
        f"{prefix}_insufficient_history": 1 if prior < 5 else 0,
        f"{prefix}_rest_days": rest,
    }
    for window, stats in (("last5", last5), ("last10", last10), ("last20", last20)):
        for key, value in stats.items():
            block[f"{prefix}_{window}_{key}"] = value
    return block
