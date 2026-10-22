"""Command line entry point."""

from __future__ import annotations

import argparse
import sys
from datetime import date
from pathlib import Path

from ucl_pipeline.pipeline import run
from ucl_pipeline.poisson_v1 import load_history, run_v1
from ucl_pipeline.predict import predict_date
from ucl_pipeline.shadow import run_shadow
from ucl_pipeline.v1_audit import write_audit


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


def predict_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Calculate baseline probabilities for unscored league fixtures and optionally push them to Telegram."
    )
    parser.add_argument("--date", default=date.today().isoformat(), help="fixture date YYYY-MM-DD")
    parser.add_argument("--output", type=Path, default=Path("output"))
    parser.add_argument("--cache", type=Path, default=Path("cache"))
    parser.add_argument("--refresh", action="store_true")
    parser.add_argument("--no-telegram", action="store_true", help="do not call the Telegram API")
    return parser


def v1_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Fit Poisson V1 with chronological validation. "
            "Does not change the default predict command or Telegram output."
        )
    )
    parser.add_argument("--output", type=Path, default=Path("output"))
    parser.add_argument("--cache", type=Path, default=Path("cache"))
    parser.add_argument("--refresh", action="store_true")
    return parser


def shadow_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Write local V0 and frozen V1 predictions. Does not call Telegram."
    )
    parser.add_argument("--date", required=True, help="prediction cutoff YYYY-MM-DD; matches on that day stay out")
    parser.add_argument("--output", type=Path, default=Path("output"))
    parser.add_argument("--cache", type=Path, default=Path("cache"))
    parser.add_argument("--refresh", action="store_true", help="redownload 2026-27 football.json before the fit")
    parser.add_argument("--chat-id", default="", help="stored for a later approved send; this command does not send")
    return parser


def audit_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Audit a saved V1 walk-forward folder without refitting the grid.")
    parser.add_argument("--folder", type=Path, required=True)
    parser.add_argument("--cache", type=Path, default=Path("cache"))
    return parser


def main(argv: list[str] | None = None) -> None:
    args_list = list(sys.argv[1:] if argv is None else argv)
    if args_list and args_list[0] == "shadow":
        args = shadow_parser().parse_args(args_list[1:])
        folder = run_shadow(
            args.cache,
            args.output,
            date.fromisoformat(args.date),
            refresh=args.refresh,
            chat_id=args.chat_id,
        )
        print(f"wrote {folder.resolve()}")
        return
    if args_list and args_list[0] == "v1-audit":
        args = audit_parser().parse_args(args_list[1:])
        path = write_audit(args.folder, load_history(args.cache))
        print(f"wrote {path.resolve()}")
        return
    if args_list and args_list[0] == "v1":
        args = v1_parser().parse_args(args_list[1:])
        folder = run_v1(args.cache, args.output, refresh=args.refresh)
        print(f"wrote {folder.resolve()}")
        return
    if args_list and args_list[0] == "predict":
        args = predict_parser().parse_args(args_list[1:])
        result = predict_date(
            date.fromisoformat(args.date),
            args.cache,
            args.output,
            refresh=args.refresh,
            push=not args.no_telegram,
        )
        print(result["message"])
        telegram = result["telegram"]
        print(f"telegram_sent={telegram['sent']} reason={telegram['reason']}")
        print(f"wrote {args.output.resolve() / 'predictions.csv'}")
        return
    args = build_parser().parse_args(args_list)
    report = run(args.output, args.cache, refresh=args.refresh)
    print(
        f"matches={report['match_rows']} features={report['feature_rows']} "
        f"score_conflicts={report['score_conflicts']} ambiguous={report['ambiguous_rows']}"
    )
    print(f"wrote {args.output.resolve()}")
