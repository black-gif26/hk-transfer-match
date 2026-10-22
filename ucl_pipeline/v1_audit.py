"""Audit a saved V1 walk-forward folder. Does not refit the validation grid."""

from __future__ import annotations

import csv
import json
import math
from collections import Counter, defaultdict
from datetime import date
from pathlib import Path

import numpy as np

from ucl_pipeline.models import Match
from ucl_pipeline.poisson_v1 import (
    FROZEN_DECAY,
    FROZEN_L2,
    NON_DOMESTIC,
    PROB_FLOOR,
    _metrics,
    _outcome_index,
    competition_flags,
    eligible_matches,
)

PROB_FIELDS = (
    "p_home_v0", "p_draw_v0", "p_away_v0", "p_over_v0", "p_btts_v0",
    "p_home_v1", "p_draw_v1", "p_away_v1", "p_over_v1", "p_btts_v1",
    "p_home_base", "p_draw_base", "p_away_base", "p_over_base", "p_btts_base",
)


def load_prediction_rows(path: Path) -> list[dict]:
    with path.open(encoding="utf-8", newline="") as handle:
        rows = list(csv.DictReader(handle))
    for row in rows:
        row["home_goals"] = int(row["home_goals"])
        row["away_goals"] = int(row["away_goals"])
        row["v0_ok"] = int(row["v0_ok"])
        row["v1_ok"] = int(row["v1_ok"])
        row["converged"] = int(row["converged"])
        row["date_obj"] = date.fromisoformat(row["date"])
        row["cutoff_obj"] = date.fromisoformat(row["cutoff"])
        for field in PROB_FIELDS:
            row[field] = float(row[field]) if row.get(field) not in ("", None) else ""
    return rows


def leakage_problems(rows: list[dict], season: str) -> list[str]:
    problems = []
    for row in rows:
        if row["season"] != season:
            problems.append(f"{row['date']} season {row['season']} is not {season}")
        if row["date_obj"] < row["cutoff_obj"]:
            problems.append(f"{row['date']} is before cutoff {row['cutoff']}")
        month_start = date(row["date_obj"].year, row["date_obj"].month, 1)
        if row["cutoff_obj"] != month_start:
            problems.append(f"{row['date']} cutoff {row['cutoff']} is not the month start")
        if row["v1_ok"] and not row["converged"]:
            problems.append(f"{row['date']} {row['home_team']} scored from a fit that did not converge")
    return problems


def _group(competition: str) -> str:
    if competition == "UEFA Champions League":
        return "UCL main stage"
    if competition == "UEFA Champions League Qualifying":
        return "UCL qualifiers"
    return competition


def _by_competition(rows: list[dict]) -> list[dict]:
    groups: dict[str, list[dict]] = defaultdict(list)
    for row in rows:
        groups[_group(row["competition"])].append(row)
    order = ["UCL main stage", "UCL qualifiers"]
    names = order + sorted(name for name in groups if name not in order)
    table = []
    for name in names:
        subset = groups.get(name, [])
        if not subset:
            continue
        compared = [row for row in subset if row["v0_ok"] and row["v1_ok"]]
        table.append(
            {
                "competition": name,
                "n": len(subset),
                "n_comparable": len(compared),
                "coverage_v0": sum(row["v0_ok"] for row in subset) / len(subset),
                "coverage_v1": sum(row["v1_ok"] for row in subset) / len(subset),
                "v0": _metrics(compared, "v0"),
                "v1": _metrics(compared, "v1"),
            }
        )
    return table


def _team_state(matches: list[Match], cutoffs: list[date]) -> dict[date, dict[str, set[str]]]:
    ordered = sorted(eligible_matches(matches), key=lambda match: match.date)
    state: dict[str, set[str]] = defaultdict(set)
    out = {}
    index = 0
    for cutoff in sorted(cutoffs):
        while index < len(ordered) and ordered[index].date < cutoff:
            match = ordered[index]
            state[match.home_team].add(match.competition)
            state[match.away_team].add(match.competition)
            index += 1
        out[cutoff] = {team: set(comps) for team, comps in state.items()}
    return out


def _loss(row: dict, prefix: str, market: str) -> float:
    if market == "1x2":
        probs = [row[f"p_home_{prefix}"], row[f"p_draw_{prefix}"], row[f"p_away_{prefix}"]]
        actual = _outcome_index(row["home_goals"], row["away_goals"])
        return -math.log(max(probs[actual], PROB_FLOOR))
    if market == "ou":
        over = 1.0 if row["home_goals"] + row["away_goals"] >= 3 else 0.0
        prob = row[f"p_over_{prefix}"]
        return -(over * math.log(max(prob, PROB_FLOOR)) + (1.0 - over) * math.log(max(1.0 - prob, PROB_FLOOR)))
    both = 1.0 if row["home_goals"] >= 1 and row["away_goals"] >= 1 else 0.0
    prob = row[f"p_btts_{prefix}"]
    return -(both * math.log(max(prob, PROB_FLOOR)) + (1.0 - both) * math.log(max(1.0 - prob, PROB_FLOOR)))


def block_bootstrap(rows: list[dict], block, n_boot: int = 2000, seed: int = 20261022) -> dict:
    """Mean paired loss V1 minus V0, with a percentile interval over resampled blocks."""
    if not rows:
        return {"n": 0, "n_blocks": 0, "n_boot": n_boot, "seed": seed, "markets": {}}
    groups: dict[tuple, list[tuple[float, float, float]]] = defaultdict(list)
    point = np.zeros(3)
    for row in rows:
        diff = (
            _loss(row, "v1", "1x2") - _loss(row, "v0", "1x2"),
            _loss(row, "v1", "ou") - _loss(row, "v0", "ou"),
            _loss(row, "v1", "btts") - _loss(row, "v0", "btts"),
        )
        groups[block(row)].append(diff)
        point += diff
    point /= max(len(rows), 1)
    keys = list(groups)
    draws = np.zeros((n_boot, 3))
    rng = np.random.default_rng(seed)
    for draw in range(n_boot):
        chosen = rng.integers(0, len(keys), len(keys))
        total = np.zeros(3)
        count = 0
        for index in chosen:
            chunk = groups[keys[index]]
            total += np.sum(chunk, axis=0)
            count += len(chunk)
        draws[draw] = total / count
    low = np.quantile(draws, 0.025, axis=0)
    high = np.quantile(draws, 0.975, axis=0)
    names = ("1x2", "ou25", "btts")
    return {
        "n": len(rows),
        "n_blocks": len(keys),
        "n_boot": n_boot,
        "seed": seed,
        "markets": {
            name: {"mean_v1_minus_v0": float(point[index]), "ci95": [float(low[index]), float(high[index])]}
            for index, name in enumerate(names)
        },
    }


def _reliability(probs: np.ndarray, outcomes: np.ndarray, bins: int = 10) -> list[dict]:
    edges = np.linspace(0.0, 1.0, bins + 1)
    points = []
    for index in range(bins):
        left, right = float(edges[index]), float(edges[index + 1])
        if index == bins - 1:
            mask = (probs >= left) & (probs <= right)
        else:
            mask = (probs >= left) & (probs < right)
        count = int(mask.sum())
        points.append(
            {
                "lo": left,
                "hi": right,
                "n": count,
                "mean_p": None if count == 0 else float(probs[mask].mean()),
                "freq": None if count == 0 else float(outcomes[mask].mean()),
            }
        )
    return points


def _calibration(rows: list[dict]) -> dict[str, list[dict]]:
    home = np.array([row["home_goals"] > row["away_goals"] for row in rows], dtype=float)
    draw = np.array([row["home_goals"] == row["away_goals"] for row in rows], dtype=float)
    away = np.array([row["home_goals"] < row["away_goals"] for row in rows], dtype=float)
    over = np.array([row["home_goals"] + row["away_goals"] >= 3 for row in rows], dtype=float)
    both = np.array([row["home_goals"] >= 1 and row["away_goals"] >= 1 for row in rows], dtype=float)
    return {
        "home": _reliability(np.array([row["p_home_v1"] for row in rows]), home),
        "draw": _reliability(np.array([row["p_draw_v1"] for row in rows]), draw),
        "away": _reliability(np.array([row["p_away_v1"] for row in rows]), away),
        "over_25": _reliability(np.array([row["p_over_v1"] for row in rows]), over),
        "btts": _reliability(np.array([row["p_btts_v1"] for row in rows]), both),
    }


def _svg(curves: dict[str, list[dict]]) -> str:
    panels = list(curves)
    width, height, left, top = 140, 120, 28, 16
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width * len(panels)}" height="{height + 28}">',
        "<style>text{font:11px sans-serif;fill:#222}</style>",
    ]
    for panel, name in enumerate(panels):
        origin_x = panel * width
        parts.append(f'<text x="{origin_x + left}" y="12">{name}</text>')
        x0, y0 = origin_x + left, top + height - 20
        parts.append(f'<line x1="{x0}" y1="{y0}" x2="{x0 + 80}" y2="{y0 - 80}" stroke="#bbb"/>')
        for point in curves[name]:
            if not point["n"] or point["mean_p"] is None:
                continue
            cx = x0 + 80 * point["mean_p"]
            cy = y0 - 80 * point["freq"]
            radius = 2 + min(point["n"], 400) / 100
            parts.append(f'<circle cx="{cx:.1f}" cy="{cy:.1f}" r="{radius:.1f}" fill="#1d4e89"/>')
    parts.append("</svg>")
    return "\n".join(parts)


def _fallback(rows: list[dict]) -> dict:
    used_v1 = used_v0 = 0
    scored = []
    for row in rows:
        prefix = "v1" if row["v1_ok"] else "v0" if row["v0_ok"] else ""
        if prefix == "v1":
            used_v1 += 1
        elif prefix == "v0":
            used_v0 += 1
        else:
            continue
        copied = dict(row)
        for market in ("home", "draw", "away", "over", "btts"):
            copied[f"p_{market}_fb"] = row[f"p_{market}_{prefix}"]
        scored.append(copied)
    v0_rows = [row for row in rows if row["v0_ok"]]
    return {
        "n_candidates": len(rows),
        "n_scored": len(scored),
        "coverage": len(scored) / len(rows) if rows else 0.0,
        "used_v1": used_v1,
        "used_v0_fallback": used_v0,
        "fallback": _metrics(scored, "fb"),
        "v0_on_v0_coverage": _metrics(v0_rows, "v0"),
    }


def _abstentions(rows: list[dict], states: dict[date, dict[str, set[str]]]) -> dict:
    reasons: Counter[str] = Counter()
    examples: dict[str, list[str]] = defaultdict(list)
    by_competition: Counter[str] = Counter()
    for row in rows:
        if row["v1_ok"]:
            continue
        comps = states[row["cutoff_obj"]]
        home_known = row["home_team"] in comps
        away_known = row["away_team"] in comps
        if not home_known or not away_known:
            reason = "unseen_team"
        else:
            reason = "seen_but_no_probability"
        reasons[reason] += 1
        by_competition[_group(row["competition"])] += 1
        if len(examples[reason]) < 5:
            missing = ",".join(name for name, known in ((row["home_team"], home_known), (row["away_team"], away_known)) if not known)
            examples[reason].append(f"{row['date']} {row['home_team']} vs {row['away_team']} missing={missing or 'none'}")
    return {"n": sum(reasons.values()), "reasons": dict(reasons), "by_competition": dict(by_competition), "examples": dict(examples)}


def _flags(rows: list[dict], states: dict[date, dict[str, set[str]]]) -> dict:
    stored = sum("cross_league_strength" in row["v1_flags"] for row in rows if row["v1_ok"])
    no_shared = cross_domestic = both = domestic_only = 0
    for row in rows:
        if not row["v1_ok"]:
            continue
        comps = states[row["cutoff_obj"]]
        flags = competition_flags(comps.get(row["home_team"], set()), comps.get(row["away_team"], set()), 5, 5)
        shared = "cross_league_strength" in flags
        domestic = "cross_domestic_league" in flags
        no_shared += shared
        cross_domestic += domestic
        both += shared and domestic
        domestic_only += domestic and not shared
    return {
        "stored_no_shared_competition": stored,
        "recomputed_no_shared_competition": no_shared,
        "cross_domestic_league": cross_domestic,
        "both_flags": both,
        "cross_domestic_but_shared_a_competition": domestic_only,
    }


def _grid(metrics: dict) -> dict:
    grid = metrics["validation_grid"]
    counts = [entry["n"] for entry in grid]
    ineligible = [
        {"decay": entry["decay"], "l2": entry["l2"], "n": entry["n"], "failed_months": [item["cutoff"] for item in entry["failed_fits"]]}
        for entry in grid
        if not entry["fits_converged"]
    ]
    return {
        "comparable_n_by_candidate": counts,
        "same_comparable_n": len(set(counts)) == 1,
        "ineligible": ineligible,
        "chosen": {"decay": metrics["chosen"]["decay"], "l2": metrics["chosen"]["l2"]},
        "chosen_matches_frozen": metrics["chosen"]["decay"] == FROZEN_DECAY and metrics["chosen"]["l2"] == FROZEN_L2,
        "note": (
            "Ineligible candidates keep a full-month log loss in metrics.json. "
            "Their n matches the eligible candidates, so failed months were not dropped before scoring. "
            "Selection used only candidates with fits_converged true."
        ),
    }


def _close(recomputed: dict, stored: dict) -> bool:
    if recomputed.get("n") != stored.get("n"):
        return False
    for key, value in stored.items():
        if key == "n":
            continue
        if abs(float(recomputed[key]) - float(value)) > 1e-9:
            return False
    return True


def audit_folder(folder: Path, history: list[Match]) -> dict:
    metrics = json.loads((folder / "metrics.json").read_text(encoding="utf-8"))
    validation = load_prediction_rows(folder / "predictions_validation.csv")
    test = load_prediction_rows(folder / "predictions_test.csv")
    problems = [f"validation: {item}" for item in leakage_problems(validation, "2024-25")]
    problems += [f"test: {item}" for item in leakage_problems(test, "2025-26")]
    compared = [row for row in test if row["v0_ok"] and row["v1_ok"]]
    validation_compared = [row for row in validation if row["v0_ok"] and row["v1_ok"]]
    recomputed_test = {
        "v0": _metrics(compared, "v0"),
        "v1": _metrics(compared, "v1"),
        "frequency_baseline": _metrics(compared, "base"),
    }
    for name in recomputed_test:
        if not _close(recomputed_test[name], metrics["test"][name]):
            problems.append(f"recomputed {name} does not match metrics.json")
    if not _close(_metrics(validation_compared, "v1"), metrics["chosen"]["validation"]):
        problems.append("recomputed validation V1 does not match the chosen metrics")
    states = _team_state(history, sorted({row["cutoff_obj"] for row in test}))
    report = {
        "folder": str(folder),
        "leakage_problems": problems,
        "metrics_match_saved_file": not any("does not match" in item for item in problems),
        "grid": _grid(metrics),
        "test_by_competition": _by_competition(test),
        "flags": _flags(test, states),
        "bootstrap_week": block_bootstrap(compared, lambda row: row["date_obj"].isocalendar()[:2]),
        "bootstrap_date": block_bootstrap(compared, lambda row: row["date_obj"]),
        "bootstrap_ucl_main_week": block_bootstrap(
            [row for row in compared if row["competition"] == "UEFA Champions League"],
            lambda row: row["date_obj"].isocalendar()[:2],
        ),
        "bootstrap_ucl_qualifying_week": block_bootstrap(
            [row for row in compared if row["competition"] == "UEFA Champions League Qualifying"],
            lambda row: row["date_obj"].isocalendar()[:2],
        ),
        "calibration": _calibration(compared),
        "abstentions": _abstentions(test, states),
        "fallback": _fallback(test),
        "calibrator_fit_on_test": False,
    }
    return report


def write_audit(folder: Path, history: list[Match]) -> Path:
    report = audit_folder(folder, history)
    (folder / "audit.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    compared = [row for row in load_prediction_rows(folder / "predictions_test.csv") if row["v0_ok"] and row["v1_ok"]]
    (folder / "calibration.svg").write_text(_svg(_calibration(compared)), encoding="utf-8")
    return folder / "audit.json"
