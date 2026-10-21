"""Command line entry point."""

from __future__ import annotations

import argparse
from pathlib import Path

from ucl_pipeline.pipeline import run


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Download cached football sources, export 90-minute matches.csv, "
            "UCL prior-form features.csv, and a coverage/license report."
        )
    )
    parser.add_argument("--output", type=Path, default=Path("output"), help="directory for CSV and report files")
    parser.add_argument("--cache", type=Path, default=Path("cache"), help="directory for raw downloaded files")
    parser.add_argument("--refresh", action="store_true", help="redownload files already in the cache")
    return parser


def main(argv: list[str] | None = None) -> None:
    args = build_parser().parse_args(argv)
    report = run(args.output, args.cache, refresh=args.refresh)
    print(
        f"matches={report['match_rows']} features={report['feature_rows']} "
        f"score_conflicts={report['score_conflicts']} ambiguous={report['ambiguous_rows']}"
    )
    print(f"wrote {args.output.resolve()}")
