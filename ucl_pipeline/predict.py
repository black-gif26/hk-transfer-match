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
    "p_home",
    "p_draw",
    "p_away",
    "pick",
    "home_prior_n",
    "away_prior_n",
    "low_confidence",
    "note",
]


def poisson_pmf(k: int, lam: float) -> float:
    if lam < 0:
        raise ValueError("lambda must be non-negative")
    if lam == 0:
        return 1.0 if k == 0 else 0.0
    probability = math.exp(-lam)
    for i in range(1, k + 1):
        probability *= lam / i
    return probability


def outcome_probs(home_xg: float, away_xg: float, limit: int = 10) -> tuple[float, float, float]:
    home = [poisson_pmf(k, home_xg) for k in range(limit + 1)]
    away = [poisson_pmf(k, away_xg) for k in range(limit + 1)]
    home_win = draw = away_win = 0.0
    for home_goals, home_p in enumerate(home):
        for away_goals, away_p in enumerate(away):
            mass = home_p * away_p
            if home_goals > away_goals:
                home_win += mass
            elif home_goals == away_goals:
                draw += mass
            else:
                away_win += mass
    total = home_win + draw + away_win
    if total <= 0:
        return 0.0, 0.0, 0.0
    return home_win / total, draw / total, away_win / total


def _per_game(total: int, prior_n: int) -> float | None:
    games = min(10, prior_n)
    if games <= 0:
        return None
    return total / games


def league_edge(matches: list[Match], competition: str) -> tuple[float, float] | None:
    scored = [
        match
        for match in matches
        if match.competition == competition and match.goals_pair() is not None and not match.score_ambiguous
    ]
    if not scored:
        return None
    home = sum(match.home_goals or 0 for match in scored) / len(scored)
    away = sum(match.away_goals or 0 for match in scored) / len(scored)
    return home, away


def predict_fixture(feature: dict, edge: tuple[float, float] | None) -> dict:
    home_prior = int(feature["home_prior_n"])
    away_prior = int(feature["away_prior_n"])
    home_for = _per_game(int(feature["home_last10_gf"]), home_prior)
    home_against = _per_game(int(feature["home_last10_ga"]), home_prior)
    away_for = _per_game(int(feature["away_last10_gf"]), away_prior)
    away_against = _per_game(int(feature["away_last10_ga"]), away_prior)
    if home_for is None or away_for is None or home_against is None or away_against is None or edge is None:
        return {
            **_identity(feature),
            "home_xg": "",
            "away_xg": "",
            "p_home": "",
            "p_draw": "",
            "p_away": "",
            "pick": "",
            "home_prior_n": home_prior,
            "away_prior_n": away_prior,
            "low_confidence": 1,
            "note": "insufficient_history",
        }
    home_edge = (edge[0] - edge[1]) / 2
    home_xg = max(0.05, (home_for + away_against) / 2 + home_edge)
    away_xg = max(0.05, (away_for + home_against) / 2 - home_edge)
    p_home, p_draw, p_away = outcome_probs(home_xg, away_xg)
    pick = max(("home", p_home), ("draw", p_draw), ("away", p_away), key=lambda item: item[1])[0]
    low = home_prior < 5 or away_prior < 5
    notes: list[str] = []
    if low:
        notes.append("fewer_than_5_prior_matches")
    for side in ("home", "away"):
        rest = feature.get(f"{side}_rest_days")
        if rest not in ("", None) and int(rest) > 14:
            notes.append(f"{side}_last_scored_match_{int(rest)}_days_earlier")
    note = ";".join(notes)
    return {
        **_identity(feature),
        "home_xg": round(home_xg, 2),
        "away_xg": round(away_xg, 2),
        "p_home": round(p_home, 3),
        "p_draw": round(p_draw, 3),
        "p_away": round(p_away, 3),
        "pick": pick,
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


def format_message(on: date, rows: list[dict], coverage_notes: list[str]) -> str:
    lines = [f"{on.isoformat()} 聯賽預測（賽前近況計算，不是已訓練模型）", ""]
    if not rows:
        lines.append("已檢查的聯賽資料裡，這一日沒有未開賽的賽事。")
    for row in rows:
        kick = f"{row['kickoff']} " if row.get("kickoff") else ""
        lines.append(f"{row['competition']} {row['stage']}".strip())
        lines.append(f"{kick}{row['home_team']} vs {row['away_team']}")
        if row["pick"] == "":
            lines.append("無法計算：賽前紀錄不足。")
        else:
            lines.append(
                f"主勝 {float(row['p_home']):.1%} / 和 {float(row['p_draw']):.1%} / "
                f"客勝 {float(row['p_away']):.1%}"
            )
            lines.append(f"預期入球 {row['home_xg']}-{row['away_xg']}，傾向 { _pick_zh(row['pick']) }")
            if row["low_confidence"]:
                lines.append(
                    f"信心不足：主隊近況 {row['home_prior_n']} 場，客隊 {row['away_prior_n']} 場。"
                )
            if "days_earlier" in str(row["note"]):
                lines.append("近況只計到最近一場有比分的賽事；中間未填比分的賽程沒有算進攻守。")
        lines.append("")
    lines.extend(coverage_notes)
    return "\n".join(lines).strip() + "\n"


def _pick_zh(pick: str) -> str:
    return {"home": "主勝", "draw": "和", "away": "客勝"}.get(pick, pick)


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
        "2026-27 只載入 football.json 當季實際存在的頂級聯賽檔。",
        "openfootball/champions-league 沒有 2026-27 目錄，歐聯今晚賽程不在資料內。",
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
    fixtures = fixtures_for(unplayed, on)
    features = build_features(history, fixtures)
    by_key = {
        (row["date"], row["home_team"], row["away_team"]): row
        for row in features
    }
    predictions = []
    for fixture in fixtures:
        feature = by_key[(fixture.date.isoformat(), fixture.home_team, fixture.away_team)]
        feature["kickoff"] = fixture.kickoff
        edge = league_edge(history, fixture.competition)
        predictions.append(predict_fixture(feature, edge))
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
