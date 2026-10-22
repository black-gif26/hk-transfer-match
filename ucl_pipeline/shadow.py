"""Local V0/V1 shadow predictions. Does not call Telegram."""

from __future__ import annotations

import csv
import hashlib
import json
from datetime import date, datetime, timezone
from pathlib import Path

from ucl_pipeline import __version__
from ucl_pipeline.models import Match
from ucl_pipeline.poisson_v1 import (
    FROZEN_DECAY,
    FROZEN_L2,
    V1Config,
    _v0_by_fixture,
    eligible_matches,
    fit_poisson,
    predict_rates,
)
from ucl_pipeline.predict import _merge_fixtures, fixtures_for, load_prediction_matches
from ucl_pipeline.web_fixtures import web_fixtures_on

MODEL_VERSION = f"poisson-v1/{__version__}/decay={FROZEN_DECAY}/l2={FROZEN_L2}"


def data_version(matches: list[Match], cutoff: date) -> dict:
    rows = [match for match in eligible_matches(matches) if match.date < cutoff]
    digest = hashlib.sha256()
    ordered = sorted(rows, key=lambda match: (match.date, match.competition, match.home_team, match.away_team))
    for match in ordered:
        digest.update(
            f"{match.date.isoformat()}|{match.competition}|{match.home_team}|{match.away_team}|"
            f"{match.home_goals}|{match.away_goals}\n".encode()
        )
    return {
        "sha256_12": digest.hexdigest()[:12],
        "n_matches": len(rows),
        "max_date": ordered[-1].date.isoformat() if ordered else None,
    }


def shadow_rows(history: list[Match], fixtures: list[Match], on: date) -> tuple[dict, list[dict]]:
    """Refit frozen V1 on matches dated before `on`. Same-day rows stay out."""
    version = data_version(history, on)
    fit = fit_poisson(history, on, FROZEN_DECAY, FROZEN_L2, V1Config())
    v0 = _v0_by_fixture(history, fixtures) if fixtures else {}
    rows = []
    for fixture in fixtures:
        v0_row = v0[(fixture.date, fixture.home_team, fixture.away_team)]
        v1 = predict_rates(fit, fixture.home_team, fixture.away_team, fixture.competition)
        row = {
            "date": fixture.date.isoformat(),
            "competition": fixture.competition,
            "home_team": fixture.home_team,
            "away_team": fixture.away_team,
            "model_version": MODEL_VERSION,
            "data_version": version["sha256_12"],
            "fit_cutoff": on.isoformat(),
            "fit_converged": int(fit.converged),
            "grad_inf": fit.grad_inf,
            "v1_flags": ",".join(v1.get("flags", [])),
            "v1_reason": v1.get("reason", ""),
            "home_xg_v0": v0_row.get("home_xg", ""),
            "away_xg_v0": v0_row.get("away_xg", ""),
            "p_home_v0": v0_row.get("p_home", ""),
            "p_draw_v0": v0_row.get("p_draw", ""),
            "p_away_v0": v0_row.get("p_away", ""),
            "p_over_v0": v0_row.get("p_over_25", ""),
            "p_btts_v0": v0_row.get("p_btts", ""),
            "home_xg_v1": "" if v1["abstain"] else v1["home_xg"],
            "away_xg_v1": "" if v1["abstain"] else v1["away_xg"],
            "p_home_v1": "" if v1["abstain"] else v1["p_home"],
            "p_draw_v1": "" if v1["abstain"] else v1["p_draw"],
            "p_away_v1": "" if v1["abstain"] else v1["p_away"],
            "p_over_v1": "" if v1["abstain"] else v1["p_over_25"],
            "p_btts_v1": "" if v1["abstain"] else v1["p_btts"],
        }
        rows.append(row)
    meta = {
        "model_version": MODEL_VERSION,
        "frozen_decay": FROZEN_DECAY,
        "frozen_l2": FROZEN_L2,
        "selection": "2024-25 validation 1X2 log loss; 2025-26 was not used to choose decay or L2",
        "prediction_cutoff": on.isoformat(),
        "data_version": version,
        "fit": {
            "cutoff": fit.cutoff.isoformat(),
            "converged": fit.converged,
            "status": fit.status,
            "message": fit.message,
            "iterations": fit.iterations,
            "objective": fit.objective,
            "grad_inf": fit.grad_inf,
            "runtime_seconds": fit.runtime_seconds,
            "n_matches": fit.n_matches,
            "n_components": fit.n_components,
            "bound_hits": fit.bound_hits,
            "prediction_guard_hits": fit.clip_hits,
        },
        "telegram": False,
    }
    return meta, rows


def write_shadow(history: list[Match], fixtures: list[Match], on: date, output_dir: Path, stamp: str | None = None) -> Path:
    meta, rows = shadow_rows(history, fixtures, on)
    stamp = stamp or datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    folder = output_dir / "shadow" / stamp
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "fit.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
    fields = list(rows[0]) if rows else [
        "date", "competition", "home_team", "away_team", "model_version", "data_version",
        "fit_cutoff", "fit_converged", "grad_inf", "v1_flags", "v1_reason",
    ]
    with (folder / "predictions.csv").open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        writer.writerows(rows)
    return folder


def run_shadow(cache_dir: Path, output_dir: Path, on: date) -> Path:
    history, unplayed, _notes = load_prediction_matches(cache_dir, refresh=False)
    fixtures = _merge_fixtures(fixtures_for(unplayed, on), web_fixtures_on(on))
    return write_shadow(history, fixtures, on, output_dir)
