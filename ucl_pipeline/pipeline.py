"""Write matches.csv, features.csv, and the coverage report."""

from __future__ import annotations

import csv
from pathlib import Path

from ucl_pipeline.dedupe import dedupe
from ucl_pipeline.features import FEATURE_FIELDS, build_features
from ucl_pipeline.report import build_report, dump_report
from ucl_pipeline.sources import load_all

MATCH_FIELDS = [
    "date",
    "season",
    "competition",
    "stage",
    "home_team",
    "away_team",
    "home_goals",
    "away_goals",
    "source",
]

CONFLICT_FIELDS = [
    "reason",
    "season",
    "competition",
    "date",
    "home_team",
    "away_team",
    "kept_source",
    "kept_home_goals",
    "kept_away_goals",
    "other_source",
    "other_date",
    "other_home_goals",
    "other_away_goals",
]

AMBIGUOUS_FIELDS = [
    "date",
    "season",
    "competition",
    "stage",
    "home_team",
    "away_team",
    "source",
    "home_goals",
    "away_goals",
    "reason",
]


def _write_csv(path: Path, fields: list[str], rows: list[dict]) -> None:
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        for row in rows:
            writer.writerow(row)


def run(output_dir: Path, cache_dir: Path, *, refresh: bool = False) -> dict:
    output_dir.mkdir(parents=True, exist_ok=True)
    raw, notes = load_all(cache_dir, refresh=refresh)
    matches, conflicts, ambiguous = dedupe(raw)
    features = build_features(matches)
    match_rows = [
        {
            "date": match.date.isoformat(),
            "season": match.season,
            "competition": match.competition,
            "stage": match.stage,
            "home_team": match.home_team,
            "away_team": match.away_team,
            "home_goals": match.home_goals,
            "away_goals": match.away_goals,
            "source": match.source,
        }
        for match in matches
    ]
    _write_csv(output_dir / "matches.csv", MATCH_FIELDS, match_rows)
    _write_csv(output_dir / "features.csv", FEATURE_FIELDS, features)
    _write_csv(output_dir / "conflicts.csv", CONFLICT_FIELDS, conflicts)
    _write_csv(output_dir / "ambiguous.csv", AMBIGUOUS_FIELDS, ambiguous)
    report = build_report(matches, conflicts, ambiguous, features, notes)
    dump_report(report, output_dir / "coverage_report.json", output_dir / "coverage_report.md")
    return report
