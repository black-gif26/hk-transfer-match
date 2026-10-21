"""Coverage and license report from files this run actually fetched."""

from __future__ import annotations

import json
from collections import Counter

from ucl_pipeline.models import Match
from ucl_pipeline.normalize import DOMESTIC_CODES, TARGET_SEASONS

LICENSES = [
    {
        "source": "tarekmasryo/football-matches-2025-dataset",
        "id": "tarekmasryo",
        "license": "CC BY 4.0",
        "license_file": "LICENSE",
        "clarity": "repo license is explicit; upstream API terms are not",
        "notes": (
            "Repository LICENSE is Creative Commons Attribution 4.0 International. "
            "README and football-data.org.txt require the attribution "
            "'Football data provided by the Football-Data.org API' and tell users to "
            "review football-data.org terms. Those terms are not included in the repo, "
            "so extra upstream restrictions are unclear. Coverage inspected: only "
            "data/football_matches_2024_2025.csv (2024-25 Premier League, La Liga, "
            "Serie A, Bundesliga, Ligue 1, Champions League)."
        ),
    },
    {
        "source": "PaperFox56/champions-league",
        "id": "paperfox",
        "license": "UNCLEAR",
        "license_file": None,
        "clarity": "unclear",
        "notes": (
            "No LICENSE file was present at the repository root. The CSV files are a "
            "conversion of football.txt (see parser.ipynb) and several .txt files match "
            "openfootball/champions-league, which is CC0, but this repository does not "
            "state that license. Dates without a year are written as 1900, and the "
            "parser stores the first score token, so an a.e.t. score can replace the "
            "90-minute score. Treated as the lowest-priority source."
        ),
    },
    {
        "source": "openfootball/football.json",
        "id": "football.json",
        "license": "CC0 1.0",
        "license_file": "LICENSE.md",
        "clarity": "explicit",
        "notes": (
            "LICENSE.md is CC0 1.0 Universal. README states the schema, data, and "
            "scripts are public domain. Domestic files used are top-division "
            "*.1.json (en, es, de, it, fr, nl, pt, at, and be, tr, sco, gr where the "
            "season directory actually contains them) plus uefa.cl.json when present. "
            "Second divisions and *-full.json duplicates are not ingested. "
            "score.ft is the 90-minute score; score.et and score.p are not copied "
            "into goals. Empty score objects are unplayed fixtures and are omitted."
        ),
    },
    {
        "source": "openfootball/champions-league",
        "id": "openfootball-cl",
        "license": "CC0 1.0",
        "license_file": "LICENSE.md",
        "clarity": "explicit",
        "notes": (
            "LICENSE.md is CC0 1.0 Universal. README describes the datasets as public "
            "domain. cl.txt and clq.txt are parsed with the sportdb score grammar so "
            "goals are the 90-minute score inside parentheses when the line has "
            "a.e.t. or pen. A line with extra time and no 90-minute score is omitted "
            "from matches.csv and listed in ambiguous.csv. Europa League and Conference "
            "League files in the same season directories are not used."
        ),
    },
]


def build_report(
    matches: list[Match],
    conflicts: list[dict],
    ambiguous: list[dict],
    features: list[dict],
    notes: list[dict],
) -> dict:
    by_season_comp = Counter((row.season, row.competition) for row in matches)
    by_source = Counter(row.source for row in matches)
    file_status = [
        {"source": note.get("source"), "url": note.get("url"), "status": note.get("status"), "season": note.get("season")}
        for note in notes
        if "url" in note and "status" in note
    ]
    missing_files = [row for row in file_status if row["status"] != 200]
    domestic_gaps = []
    for note in notes:
        if note.get("source") == "football.json" and "files_used" in note:
            used = {name.replace(".json", "") for name in note["files_used"]}
            absent = [code for code in DOMESTIC_CODES if code not in used]
            domestic_gaps.append({"season": note["season"], "listing": note.get("listing"), "absent_top_divisions": absent, "files_used": note["files_used"]})
    cl_files = []
    for note in notes:
        if note.get("source") == "openfootball-cl" and "files_used" in note:
            cl_files.append(
                {
                    "season": note["season"],
                    "listing": note.get("listing"),
                    "files_used": note["files_used"],
                    "files_present": note.get("files_present"),
                    "qualifying_file": "clq.txt" in note["files_used"],
                }
            )
    insufficient = sum(1 for row in features if row["home_insufficient_history"] or row["away_insufficient_history"])
    return {
        "target_seasons": list(TARGET_SEASONS),
        "licenses": LICENSES,
        "match_rows": len(matches),
        "matches_by_source": dict(by_source),
        "matches_by_season_competition": [
            {"season": season, "competition": competition, "matches": count}
            for (season, competition), count in sorted(by_season_comp.items())
        ],
        "missing_downloads": missing_files,
        "domestic_gaps": domestic_gaps,
        "champions_league_files": cl_files,
        "score_conflicts": sum(1 for row in conflicts if row["reason"] == "score_conflict"),
        "date_disagreements": sum(1 for row in conflicts if row["reason"] == "date_disagreement"),
        "ambiguous_rows": len(ambiguous),
        "unplayed_omitted": [
            {
                "source": note.get("source"),
                "season": note.get("season"),
                "file": note.get("file") or note.get("url"),
                "unplayed_omitted": note.get("unplayed_omitted", note.get("parse", {}).get("fixtures_without_score")),
            }
            for note in notes
            if note.get("unplayed_omitted") or (note.get("parse") or {}).get("fixtures_without_score")
        ],
        "feature_rows": len(features),
        "feature_rows_with_insufficient_history": insufficient,
        "kept_date_imputed": sum(1 for row in matches if row.date_imputed),
        "fetch_log": notes,
    }


def render_markdown(report: dict) -> str:
    lines = [
        "# UCL pipeline coverage and license report",
        "",
        "Target seasons: " + ", ".join(report["target_seasons"]) + ".",
        "Seasons or files that were not in the upstream repositories are listed below and were not filled in.",
        "",
        "## Licenses",
        "",
    ]
    for item in report["licenses"]:
        lines.append(f"### {item['source']}")
        lines.append("")
        lines.append(f"- License: **{item['license']}** ({item['clarity']})")
        lines.append(f"- License file: {item['license_file'] or 'none found'}")
        lines.append(f"- {item['notes']}")
        lines.append("")
    lines.append("## Match counts")
    lines.append("")
    lines.append(f"Deduplicated matches with a 90-minute score: {report['match_rows']}.")
    lines.append("")
    lines.append("| season | competition | matches |")
    lines.append("| --- | --- | ---: |")
    for row in report["matches_by_season_competition"]:
        lines.append(f"| {row['season']} | {row['competition']} | {row['matches']} |")
    lines.append("")
    lines.append("Rows kept by winning source:")
    lines.append("")
    for source, count in sorted(report["matches_by_source"].items()):
        lines.append(f"- {source}: {count}")
    lines.append("")
    lines.append("## Gaps")
    lines.append("")
    lines.append(
        "tarekmasryo publishes one season file (2024-25). "
        "2021-22, 2022-23, 2023-24, and 2025-26 are absent from that repository."
    )
    lines.append("")
    lines.append("Domestic top divisions not present in the football.json season directory:")
    lines.append("")
    for gap in report["domestic_gaps"]:
        absent = ", ".join(gap["absent_top_divisions"]) or "none"
        lines.append(f"- {gap['season']} ({gap['listing']}): {absent}")
    lines.append("")
    lines.append("Champions League files used:")
    lines.append("")
    for row in report["champions_league_files"]:
        quali = "clq.txt present" if row["qualifying_file"] else "clq.txt absent (qualifying not in this season directory)"
        lines.append(f"- {row['season']}: {', '.join(row['files_used']) or 'none'}; {quali}")
    if report["missing_downloads"]:
        lines.append("")
        lines.append("Downloads that did not return HTTP 200:")
        lines.append("")
        for row in report["missing_downloads"]:
            lines.append(f"- {row['status']} {row['url']}")
    lines.append("")
    lines.append("## Conflicts and ambiguous scores")
    lines.append("")
    lines.append(f"- Score conflicts (higher-priority 90-minute score kept): {report['score_conflicts']}")
    lines.append(f"- Date disagreements inside a merged fixture: {report['date_disagreements']}")
    lines.append(f"- Ambiguous or non-90-minute rows recorded separately: {report['ambiguous_rows']}")
    lines.append(f"- Kept rows whose date was imputed from a 1900 PaperFox year: {report['kept_date_imputed']}")
    lines.append("")
    if report["unplayed_omitted"]:
        lines.append(
            "Fixtures in a source file with no score were skipped for that file. "
            "Another source can still supply the same match."
        )
        lines.append("")
        for row in report["unplayed_omitted"]:
            lines.append(
                f"- {row['season']} {row['file']}: {row['unplayed_omitted']} ({row['source']})"
            )
        lines.append("")
    lines.append("## Features")
    lines.append("")
    lines.append(f"UCL feature rows: {report['feature_rows']}.")
    lines.append(
        f"Rows where home or away has fewer than 5 prior domestic/UCL matches: "
        f"{report['feature_rows_with_insufficient_history']}."
    )
    lines.append("")
    lines.append(
        "History uses matches strictly before the fixture date. "
        "Same-calendar-day matches are excluded. "
        "Ambiguous scores are excluded from W/D/L, goals, and rest days. "
        "last-5 and last-10 counts are partial when the team has fewer matches; "
        "insufficient_history is 1 when prior matches are below 5."
    )
    lines.append("")
    return "\n".join(lines)


def dump_report(report: dict, json_path, markdown_path) -> None:
    # fetch_log is useful but large; keep it in JSON only.
    json_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    public = {key: value for key, value in report.items() if key != "fetch_log"}
    markdown_path.write_text(render_markdown(public), encoding="utf-8")
