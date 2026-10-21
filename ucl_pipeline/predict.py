"""Baseline probabilities for fixtures that have no score yet.

This is a calculation from prior results, not a fitted model.
Home and away expected goals are the average of the team's recent scoring
rate and the opponent's recent conceding rate, shifted by that competition's
historical home edge. Outcomes use two independent Poisson distributions.
"""

from __future__ import annotations

import csv
import math
from datetime import date
from pathlib import Path

from ucl_pipeline.dedupe import dedupe
from ucl_pipeline.features import build_features
from ucl_pipeline.models import Match
from ucl_pipeline.sources import load_all, load_football_json
from ucl_pipeline.telegram import credentials_from_env, send_message
from ucl_pipeline.web_fixtures import web_fixtures_on

# Five complete seasons in the collected training set. 2026-27 is not one of them.
COMPLETE_SEASONS = ("2021-22", "2022-23", "2023-24", "2024-25", "2025-26")
TRAIN_WINDOWS = (2, 3, 5)
FORM_LENGTHS = (5, 10, 20)
# Played matches from this season may update form only when dated before the fixture.
UPDATE_SEASON = "2026-27"
# Season directory that exists in football.json after the pipeline's 2025-26 cutoff.
# champions-league has no 2026-27 directory (HTTP 404 on inspection).
FIXTURE_SEASONS = ("2026-27",)
PREDICTION_FIELDS = [
    "date",
    "kickoff",
    "season",
    "competition",
    "stage",
    "home_team",
    "away_team",
    "home_xg",
    "away_xg",
    "p_over_25",
    "p_under_25",
    "p_btts",
    "p_home",
    "p_draw",
    "p_away",
    "pick",
    "home_prior_n",
    "away_prior_n",
    "low_confidence",
    "note",
    "train_window",
    "train_seasons",
    "form_n",
]


def training_seasons(window: int) -> tuple[str, ...]:
    if window not in TRAIN_WINDOWS:
        raise ValueError(f"training window must be one of {TRAIN_WINDOWS}")
    return COMPLETE_SEASONS[-window:]


def usable_history(matches: list[Match], window: int, as_of: date) -> list[Match]:
    """Training-window matches plus 2026-27 results strictly before as_of."""
    allowed = set(training_seasons(window))
    kept: list[Match] = []
    for match in matches:
        if match.goals_pair() is None or match.score_ambiguous or match.date >= as_of:
            continue
        if match.season in allowed or match.season == UPDATE_SEASON:
            kept.append(match)
    return kept


def poisson_pmf(k: int, lam: float) -> float:
    if lam < 0:
        raise ValueError("lambda must be non-negative")
    if lam == 0:
        return 1.0 if k == 0 else 0.0
    probability = math.exp(-lam)
    for i in range(1, k + 1):
        probability *= lam / i
    return probability


def score_markets(home_xg: float, away_xg: float, limit: int = 10) -> dict[str, float]:
    """Independent Poisson markets on the same 0..limit scoreline grid.

    Over 2.5 is three or more goals. Both teams score means each side has at least one.
    The truncated grid is renormalised so each pair of complementary markets sums to 1.
    """
    home = [poisson_pmf(k, home_xg) for k in range(limit + 1)]
    away = [poisson_pmf(k, away_xg) for k in range(limit + 1)]
    home_win = draw = away_win = 0.0
    over_25 = under_25 = btts = 0.0
    for home_goals, home_p in enumerate(home):
        for away_goals, away_p in enumerate(away):
            mass = home_p * away_p
            if home_goals > away_goals:
                home_win += mass
            elif home_goals == away_goals:
                draw += mass
            else:
                away_win += mass
            if home_goals + away_goals >= 3:
                over_25 += mass
            else:
                under_25 += mass
            if home_goals >= 1 and away_goals >= 1:
                btts += mass
    total = home_win + draw + away_win
    if total <= 0:
        return {
            "p_home": 0.0,
            "p_draw": 0.0,
            "p_away": 0.0,
            "p_over_25": 0.0,
            "p_under_25": 0.0,
            "p_btts": 0.0,
        }
    return {
        "p_home": home_win / total,
        "p_draw": draw / total,
        "p_away": away_win / total,
        "p_over_25": over_25 / total,
        "p_under_25": under_25 / total,
        "p_btts": btts / total,
    }


def outcome_probs(home_xg: float, away_xg: float, limit: int = 10) -> tuple[float, float, float]:
    markets = score_markets(home_xg, away_xg, limit)
    return markets["p_home"], markets["p_draw"], markets["p_away"]


def _per_game(total: int, prior_n: int, form_n: int) -> float | None:
    games = min(form_n, prior_n)
    if games <= 0:
        return None
    return total / games


def league_edge(
    matches: list[Match],
    competition: str,
    seasons: tuple[str, ...] | None = None,
) -> tuple[float, float] | None:
    scored = [
        match
        for match in matches
        if match.competition == competition
        and match.goals_pair() is not None
        and not match.score_ambiguous
        and (seasons is None or match.season in seasons)
    ]
    if not scored:
        return None
    home = sum(match.home_goals or 0 for match in scored) / len(scored)
    away = sum(match.away_goals or 0 for match in scored) / len(scored)
    return home, away


def predict_fixture(
    feature: dict,
    edge: tuple[float, float] | None,
    form_n: int = 10,
) -> dict:
    if form_n not in FORM_LENGTHS:
        raise ValueError(f"form length must be one of {FORM_LENGTHS}")
    home_prior = int(feature["home_prior_n"])
    away_prior = int(feature["away_prior_n"])
    home_for = _per_game(int(feature[f"home_last{form_n}_gf"]), home_prior, form_n)
    home_against = _per_game(int(feature[f"home_last{form_n}_ga"]), home_prior, form_n)
    away_for = _per_game(int(feature[f"away_last{form_n}_gf"]), away_prior, form_n)
    away_against = _per_game(int(feature[f"away_last{form_n}_ga"]), away_prior, form_n)
    if home_for is None or away_for is None or home_against is None or away_against is None or edge is None:
        return {
            **_identity(feature),
            "home_xg": "",
            "away_xg": "",
            "p_over_25": "",
            "p_under_25": "",
            "p_btts": "",
            "p_home": "",
            "p_draw": "",
            "p_away": "",
            "pick": "",
            "form_n": form_n,
            "home_prior_n": home_prior,
            "away_prior_n": away_prior,
            "low_confidence": 1,
            "note": "insufficient_history",
        }
    home_edge = (edge[0] - edge[1]) / 2
    home_xg = max(0.05, (home_for + away_against) / 2 + home_edge)
    away_xg = max(0.05, (away_for + home_against) / 2 - home_edge)
    markets = score_markets(home_xg, away_xg)
    p_home, p_draw, p_away = markets["p_home"], markets["p_draw"], markets["p_away"]
    pick = max((("home", p_home), ("draw", p_draw), ("away", p_away)), key=lambda item: item[1])[0]
    low = home_prior < form_n or away_prior < form_n
    notes: list[str] = []
    if low:
        notes.append(f"fewer_than_{form_n}_prior_matches")
    for side in ("home", "away"):
        rest = feature.get(f"{side}_rest_days")
        if rest not in ("", None) and int(rest) > 14:
            notes.append(f"{side}_last_scored_match_{int(rest)}_days_earlier")
    note = ";".join(notes)
    return {
        **_identity(feature),
        "home_xg": round(home_xg, 2),
        "away_xg": round(away_xg, 2),
        "p_over_25": round(markets["p_over_25"], 3),
        "p_under_25": round(markets["p_under_25"], 3),
        "p_btts": round(markets["p_btts"], 3),
        "p_home": round(p_home, 3),
        "p_draw": round(p_draw, 3),
        "p_away": round(p_away, 3),
        "pick": pick,
        "form_n": form_n,
        "home_prior_n": home_prior,
        "away_prior_n": away_prior,
        "low_confidence": 1 if low else 0,
        "note": note,
    }


def _identity(feature: dict) -> dict:
    return {
        "date": feature["date"],
        "kickoff": feature.get("kickoff") or "",
        "season": feature["season"],
        "competition": feature["competition"],
        "stage": feature["stage"],
        "home_team": feature["home_team"],
        "away_team": feature["away_team"],
    }


def compare_windows(history: list[Match], fixtures: list[Match]) -> list[dict]:
    """One row per fixture, training window, and form length. Each row has three probabilities."""
    rows: list[dict] = []
    for window in TRAIN_WINDOWS:
        seasons = training_seasons(window)
        for fixture in fixtures:
            scoped = usable_history(history, window, fixture.date)
            feature = build_features(scoped, [fixture])[0]
            feature["kickoff"] = fixture.kickoff
            edge = league_edge(scoped, fixture.competition, seasons)
            edge_note = ""
            if edge is None and fixture.competition == "UEFA Europa League":
                edge = league_edge(scoped, "UEFA Champions League", seasons)
                edge_note = "home_edge_from_champions_league"
            for form_n in FORM_LENGTHS:
                row = predict_fixture(feature, edge, form_n=form_n)
                if edge_note:
                    row["note"] = ";".join(part for part in (row["note"], edge_note) if part)
                row["train_window"] = window
                row["train_seasons"] = ",".join(seasons)
                rows.append(row)
    return rows


def format_message(on: date, rows: list[dict], coverage_notes: list[str]) -> str:
    lines = [f"{on.isoformat()} 聯賽預測（賽前近況計算，不是已訓練模型）", ""]
    if not rows:
        lines.append("已檢查的聯賽資料裡，這一日沒有未開賽的賽事。")
    for row in rows:
        kick = f"{row['kickoff']} " if row.get("kickoff") else ""
        lines.append(f"{row['competition']} {row['stage']}".strip())
        lines.append(f"{kick}{row['home_team']} vs {row['away_team']}")
        if row.get("train_window"):
            lines.append(f"訓練視窗 {row['train_window']} 季，近 {row['form_n']} 場")
        if row["p_home"] == "":
            lines.append("主勝 / 和 / 客勝：賽前紀錄不足，無機率。")
        else:
            if row.get("home_xg") not in ("", None):
                lines.append(f"主隊預期入球 {float(row['home_xg']):.2f}")
                lines.append(f"客隊預期入球 {float(row['away_xg']):.2f}")
            if row.get("p_over_25") not in ("", None):
                lines.append(
                    f"大 2.5 {float(row['p_over_25']):.1%} / 細 2.5 {float(row['p_under_25']):.1%}"
                )
                lines.append(f"雙方入球 {float(row['p_btts']):.1%}")
            lines.append(
                f"主勝 {float(row['p_home']):.1%} / 和 {float(row['p_draw']):.1%} / "
                f"客勝 {float(row['p_away']):.1%}"
            )
            if row["low_confidence"]:
                lines.append(
                    f"該近況窗口未填滿：主隊 {row['home_prior_n']} 場，客隊 {row['away_prior_n']} 場。"
                )
        lines.append("")
    lines.extend(coverage_notes)
    return "\n".join(lines).strip() + "\n"


def _merge_fixtures(existing: list[Match], extra: list[Match]) -> list[Match]:
    seen = {(match.date, match.home_team, match.away_team) for match in existing}
    merged = list(existing)
    for match in extra:
        key = (match.date, match.home_team, match.away_team)
        if key not in seen:
            merged.append(match)
            seen.add(key)
    merged.sort(key=lambda match: (match.kickoff, match.competition, match.home_team))
    return merged


def fixtures_for(matches: list[Match], on: date) -> list[Match]:
    selected = [
        match
        for match in matches
        if match.date == on and match.goals_pair() is None and not match.score_ambiguous
    ]
    selected.sort(key=lambda match: (match.kickoff, match.competition, match.home_team))
    return selected


def load_prediction_matches(cache_dir: Path, refresh: bool = False) -> tuple[list[Match], list[Match], list[str]]:
    """Return played history, unplayed rows from later seasons, and coverage notes."""
    raw, _notes = load_all(cache_dir, refresh=refresh)
    extra_notes: list[dict] = []
    extra = load_football_json(
        cache_dir,
        refresh,
        extra_notes,
        seasons=FIXTURE_SEASONS,
        keep_unplayed=True,
    )
    notes = [
        "訓練集是 2021-22 至 2025-26 五個完整賽季。",
        "輸出比較最近 2、3、5 季，每隊再用賽前最近 5、10、20 場。",
        "2026-27 只加入預測日期之前已有比分的比賽，不計入主場優勢基準。",
        "2026-10-21 歐冠賽程來自 BBC Sport 與 FBref，不在訓練檔內。",
    ]
    for note in extra_notes:
        if note.get("status") not in (None, 200) and note.get("url"):
            notes.append(f"未能下載 {note['url']}（HTTP {note['status']}）。")
        if "files_used" in note:
            used = ", ".join(note["files_used"]) or "沒有檔案"
            notes.append(f"{note['season']} 使用檔案：{used}。")
    played = [match for match in extra if match.goals_pair() is not None]
    unplayed = [match for match in extra if match.goals_pair() is None and not match.score_ambiguous]
    history, _conflicts, _ambiguous = dedupe(raw + played)
    return history, unplayed, notes


def predict_date(on: date, cache_dir: Path, output_dir: Path, *, refresh: bool = False, push: bool = True) -> dict:
    output_dir.mkdir(parents=True, exist_ok=True)
    history, unplayed, notes = load_prediction_matches(cache_dir, refresh=refresh)
    fixtures = _merge_fixtures(fixtures_for(unplayed, on), web_fixtures_on(on))
    predictions = compare_windows(history, fixtures)
    message = format_message(on, predictions, notes)
    (output_dir / "predictions.csv").write_text("", encoding="utf-8")
    with (output_dir / "predictions.csv").open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=PREDICTION_FIELDS, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(predictions)
    (output_dir / "telegram_message.txt").write_text(message, encoding="utf-8")
    token, chat_id = credentials_from_env()
    if not push:
        delivery = {"sent": False, "reason": "push_disabled"}
    elif not token or not chat_id:
        delivery = {"sent": False, "reason": "missing_credentials"}
    else:
        delivery = send_message(message, token, chat_id)
    return {"date": on.isoformat(), "predictions": predictions, "message": message, "telegram": delivery}
