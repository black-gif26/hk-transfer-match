"""Parser for openfootball football.txt Champions League files."""

from __future__ import annotations

import re
from datetime import date

from ucl_pipeline.models import SOURCE_PRIORITY, Match
from ucl_pipeline.normalize import normalize_team, season_key
from ucl_pipeline.scores import parse_score

_MONTHS = {
    "Jan": 1,
    "Feb": 2,
    "Mar": 3,
    "Apr": 4,
    "May": 5,
    "Jun": 6,
    "Jul": 7,
    "Aug": 8,
    "Sep": 9,
    "Oct": 10,
    "Nov": 11,
    "Dec": 12,
}
_DATE_LINE = re.compile(
    r"^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+"
    r"([A-Za-z]{3})\s+(\d{1,2})(?:\s+(20\d{2}))?$"
)
_WITH_COUNTRY = re.compile(
    r"^(?P<home>.+?)\s+\((?P<hc>[A-Z]{3})\)\s+v\s+"
    r"(?P<away>.+?)\s+\((?P<ac>[A-Z]{3})\)\s*(?P<rest>.*)$"
)
_PLAIN = re.compile(r"^(?P<home>.+?)\s+v\s+(?P<away>.+?)\s+(?P<rest>\d.*)$")
_TIME = re.compile(r"^\d{1,2}:\d{2}\s+")
_SEASON_IN_TEXT = re.compile(r"20\d{2}\s*/\s*\d{2,4}")
_SKIP_TAG = re.compile(r"\[(cancelled|canceled|postponed|abandoned)\]", re.I)


def parse_fb_date(text: str, previous: date | None, season: str) -> date:
    """Resolve a football.txt date inside a season.

    Group files restart at September after December, so a backwards month
    is not a new year. July–December belong to the season start year and
    January–June to the following year unless the line itself carries a year.
    ``previous`` is accepted for callers that track context and is not used.
    """
    del previous
    match = _DATE_LINE.match(text.strip())
    if not match:
        raise ValueError(f"not a football.txt date: {text!r}")
    month = _MONTHS[match.group(1)]
    day = int(match.group(2))
    if match.group(3):
        year = int(match.group(3))
    else:
        start = int(season[:4])
        year = start if month >= 7 else start + 1
    return date(year, month, day)


def parse_champions_league_text(
    text: str,
    *,
    path_season: str,
    qualifying: bool,
) -> tuple[list[Match], dict[str, int]]:
    season = path_season
    stage = "Qualifying" if qualifying else ""
    competition = (
        "UEFA Champions League Qualifying" if qualifying else "UEFA Champions League"
    )
    current: date | None = None
    matches: list[Match] = []
    stats = {
        "fixtures_without_score": 0,
        "skipped_tagged": 0,
        "ambiguous": 0,
        "parsed": 0,
    }
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("="):
            found = _SEASON_IN_TEXT.search(line)
            if found:
                season = season_key(found.group(0))
            continue
        if line.startswith("▪"):
            stage = line.lstrip("▪").strip()
            continue
        if _DATE_LINE.match(line):
            current = parse_fb_date(line, current, season)
            continue
        if " v " not in line or current is None:
            continue
        body = _TIME.sub("", line)
        body = re.sub(r"\s+#.*$", "", body).strip()
        if _SKIP_TAG.search(body):
            stats["skipped_tagged"] += 1
            continue
        parsed = _WITH_COUNTRY.match(body) or _PLAIN.match(body)
        if not parsed:
            stats["fixtures_without_score"] += 1
            continue
        score = parse_score(parsed.group("rest") or "")
        if score.reason == "unplayed":
            stats["fixtures_without_score"] += 1
            continue
        if score.ambiguous:
            stats["ambiguous"] += 1
        else:
            stats["parsed"] += 1
        matches.append(
            Match(
                date=current,
                season=season,
                competition=competition,
                stage=stage,
                home_team=normalize_team(parsed.group("home")),
                away_team=normalize_team(parsed.group("away")),
                home_goals=score.home_goals,
                away_goals=score.away_goals,
                source="openfootball-cl",
                priority=SOURCE_PRIORITY["openfootball-cl"],
                score_ambiguous=score.ambiguous,
                ambiguous_reason=score.reason,
            )
        )
    return matches, stats
