"""Load the four upstream repositories that were actually inspected.

Paths are discovered from each season directory at runtime. A 404 is recorded
as missing. Nothing is synthesized for a season the upstream repo does not ship.
"""

from __future__ import annotations

import csv
import io
import json
from datetime import date
from pathlib import Path

from ucl_pipeline.cache import fetch, fetch_json
from ucl_pipeline.fbtxt import parse_champions_league_text
from ucl_pipeline.models import SOURCE_PRIORITY, Match
from ucl_pipeline.normalize import (
    COMPETITION_BY_CODE,
    DOMESTIC_CODES,
    MASRYO_COMPETITIONS,
    TARGET_SEASONS,
    normalize_team,
    season_key,
)

MASRYO_CSV = (
    "https://raw.githubusercontent.com/tarekmasryo/"
    "football-matches-2025-dataset/main/data/football_matches_2024_2025.csv"
)
FOOTBALL_JSON_API = "https://api.github.com/repos/openfootball/football.json/contents/{season}"
FOOTBALL_JSON_RAW = "https://raw.githubusercontent.com/openfootball/football.json/master/{season}/{name}"
CL_API = "https://api.github.com/repos/openfootball/champions-league/contents/{season}"
CL_RAW = "https://raw.githubusercontent.com/openfootball/champions-league/master/{season}/{name}"
PAPERFOX_API = "https://api.github.com/repos/PaperFox56/champions-league/contents/champions-league/{season}"
PAPERFOX_RAW = (
    "https://raw.githubusercontent.com/PaperFox56/champions-league/master/"
    "champions-league/{season}/{name}"
)

# Used only when the GitHub contents API is unavailable. These names were
# listed from the repositories on inspection; a live 404 still wins.
FALLBACK_FOOTBALL_JSON = {
    "2021-22": ["at.1.json", "de.1.json", "en.1.json", "es.1.json", "fr.1.json", "it.1.json", "nl.1.json", "pt.1.json"],
    "2022-23": ["at.1.json", "de.1.json", "en.1.json", "es.1.json", "fr.1.json", "it.1.json", "nl.1.json", "pt.1.json"],
    "2023-24": ["at.1.json", "de.1.json", "en.1.json", "es.1.json", "fr.1.json", "it.1.json", "nl.1.json", "pt.1.json"],
    "2024-25": [
        "at.1.json", "be.1.json", "de.1.json", "en.1.json", "es.1.json", "fr.1.json",
        "gr.1.json", "it.1.json", "nl.1.json", "pt.1.json", "sco.1.json", "tr.1.json", "uefa.cl.json",
    ],
    "2025-26": [
        "at.1.json", "be.1.json", "de.1.json", "en.1.json", "es.1.json", "fr.1.json",
        "gr.1.json", "it.1.json", "nl.1.json", "pt.1.json", "sco.1.json", "tr.1.json",
    ],
}
FALLBACK_CL = {
    "2021-22": ["cl.txt"],
    "2022-23": ["cl.txt"],
    "2023-24": ["cl.txt"],
    "2024-25": ["cl.txt", "clq.txt"],
    "2025-26": ["cl.txt", "clq.txt"],
}
FALLBACK_PAPERFOX = {
    "2021-22": ["cl.csv"],
    "2022-23": ["cl.csv"],
    "2023-24": ["cl.csv"],
    "2024-25": ["cl.csv", "clq.csv"],
    "2025-26": ["cl.csv", "clq.csv"],
}


def _dir_names(url: str, cache_dir: Path, refresh: bool) -> tuple[str, list[str]]:
    status, payload = fetch_json(url, cache_dir, refresh=refresh)
    if status != 200 or not isinstance(payload, list):
        return f"http_{status}", []
    names = sorted(entry["name"] for entry in payload if isinstance(entry, dict) and entry.get("type") == "file")
    return "listed", names


def _wanted_json(names: list[str]) -> list[str]:
    wanted = []
    for name in names:
        if not name.endswith(".json") or name.endswith("-full.json"):
            continue
        stem = name[:-5]
        if stem in DOMESTIC_CODES or stem == "uefa.cl":
            wanted.append(name)
    return wanted


def load_masryo(cache_dir: Path, refresh: bool, notes: list[dict]) -> list[Match]:
    status, body = fetch(MASRYO_CSV, cache_dir, refresh=refresh)
    notes.append({"source": "tarekmasryo", "url": MASRYO_CSV, "status": status})
    if status != 200:
        return []
    rows = csv.DictReader(io.StringIO(body.decode("utf-8")))
    matches: list[Match] = []
    for row in rows:
        code = row.get("competition_code", "")
        competition = MASRYO_COMPETITIONS.get(code)
        if competition is None:
            continue
        status_name = (row.get("status") or "").upper()
        if status_name not in {"FINISHED", "AWARDED"}:
            continue
        home_raw, away_raw = row.get("fulltime_home", ""), row.get("fulltime_away", "")
        if home_raw == "" or away_raw == "":
            continue
        when = date.fromisoformat(row["date_utc"][:10])
        ambiguous = status_name == "AWARDED"
        matches.append(
            Match(
                date=when,
                season=season_key(row["season"]),
                competition=competition,
                stage=(row.get("stage") or "").strip(),
                home_team=normalize_team(row["home_team"]),
                away_team=normalize_team(row["away_team"]),
                home_goals=int(home_raw),
                away_goals=int(away_raw),
                source="tarekmasryo",
                priority=SOURCE_PRIORITY["tarekmasryo"],
                score_ambiguous=ambiguous,
                ambiguous_reason="awarded" if ambiguous else "",
            )
        )
    return matches


def _json_goals(score: object) -> tuple[int | None, int | None, bool, str, str]:
    """Return goals, ambiguous, reason, disposition.

    disposition is played, unplayed, or ambiguous.
    """
    if score is None or score == {} or score == []:
        return None, None, False, "", "unplayed"
    if isinstance(score, list) and len(score) == 2:
        return int(score[0]), int(score[1]), False, "", "played"
    if isinstance(score, dict):
        fulltime = score.get("ft")
        if isinstance(fulltime, list) and len(fulltime) == 2:
            return int(fulltime[0]), int(fulltime[1]), False, "", "played"
        if score.keys() <= {"ht", "et", "p"}:
            return None, None, True, "json_score_without_ft", "ambiguous"
    return None, None, True, "unparsed_json_score", "ambiguous"


def load_football_json(
    cache_dir: Path,
    refresh: bool,
    notes: list[dict],
    seasons: tuple[str, ...] | None = None,
    keep_unplayed: bool = False,
) -> list[Match]:
    matches: list[Match] = []
    for season in seasons or TARGET_SEASONS:
        mode, names = _dir_names(FOOTBALL_JSON_API.format(season=season), cache_dir, refresh)
        if mode != "listed":
            names = list(FALLBACK_FOOTBALL_JSON.get(season, []))
            listing = f"fallback_after_{mode}"
        else:
            listing = "api"
        wanted = _wanted_json(names) if listing == "api" else list(names)
        skipped = [name for name in names if name.endswith(".json") and name not in wanted]
        notes.append(
            {
                "source": "football.json",
                "season": season,
                "listing": listing,
                "files_used": wanted,
                "json_files_not_used": skipped,
            }
        )
        for name in wanted:
            url = FOOTBALL_JSON_RAW.format(season=season, name=name)
            status, body = fetch(url, cache_dir, refresh=refresh)
            notes.append({"source": "football.json", "url": url, "status": status})
            if status != 200:
                continue
            payload = json.loads(body.decode("utf-8"))
            stem = name[:-5]
            competition = COMPETITION_BY_CODE[stem]
            unplayed = 0
            for row in payload.get("matches") or []:
                when_text = row.get("date")
                if not when_text:
                    continue
                home, away, ambiguous, reason, disposition = _json_goals(row.get("score"))
                if disposition == "unplayed":
                    unplayed += 1
                    if not keep_unplayed:
                        continue
                    home = away = None
                    ambiguous = False
                    reason = "unplayed"
                matches.append(
                    Match(
                        date=date.fromisoformat(when_text),
                        season=season,
                        competition=competition,
                        stage=str(row.get("round") or ""),
                        home_team=normalize_team(row.get("team1") or ""),
                        away_team=normalize_team(row.get("team2") or ""),
                        home_goals=home,
                        away_goals=away,
                        source="football.json",
                        priority=SOURCE_PRIORITY["football.json"],
                        score_ambiguous=ambiguous,
                        ambiguous_reason=reason,
                        kickoff=str(row.get("time") or ""),
                    )
                )
            if unplayed:
                notes.append(
                    {
                        "source": "football.json",
                        "season": season,
                        "file": name,
                        "unplayed_omitted": unplayed,
                    }
                )
    return matches


def load_openfootball_cl(cache_dir: Path, refresh: bool, notes: list[dict]) -> list[Match]:
    matches: list[Match] = []
    for season in TARGET_SEASONS:
        mode, names = _dir_names(CL_API.format(season=season), cache_dir, refresh)
        if mode != "listed":
            names = list(FALLBACK_CL.get(season, []))
            listing = f"fallback_after_{mode}"
        else:
            listing = "api"
        wanted = [name for name in names if name in {"cl.txt", "clq.txt"}]
        if listing != "api":
            wanted = list(names)
        notes.append(
            {
                "source": "openfootball-cl",
                "season": season,
                "listing": listing,
                "files_present": names,
                "files_used": wanted,
                "files_not_used": [name for name in names if name not in wanted],
            }
        )
        for name in wanted:
            url = CL_RAW.format(season=season, name=name)
            status, body = fetch(url, cache_dir, refresh=refresh)
            notes.append({"source": "openfootball-cl", "url": url, "status": status, "season": season})
            if status != 200:
                continue
            parsed, stats = parse_champions_league_text(
                body.decode("utf-8"),
                path_season=season,
                qualifying=name.startswith("clq"),
            )
            notes.append({"source": "openfootball-cl", "url": url, "parse": stats})
            matches.extend(parsed)
    return matches


def _impute_paperfox_date(raw: str, season: str) -> tuple[date | None, bool]:
    try:
        when = date.fromisoformat(raw[:10])
    except ValueError:
        return None, False
    if when.year != 1900:
        return when, False
    start = int(season[:4])
    year = start if when.month >= 7 else start + 1
    return date(year, when.month, when.day), True


def load_paperfox(cache_dir: Path, refresh: bool, notes: list[dict]) -> list[Match]:
    matches: list[Match] = []
    for season in TARGET_SEASONS:
        mode, names = _dir_names(PAPERFOX_API.format(season=season), cache_dir, refresh)
        if mode != "listed":
            names = list(FALLBACK_PAPERFOX.get(season, []))
            listing = f"fallback_after_{mode}"
        else:
            listing = "api"
        wanted = [name for name in names if name in {"cl.csv", "clq.csv"}]
        if listing != "api":
            wanted = list(names)
        notes.append(
            {
                "source": "paperfox",
                "season": season,
                "listing": listing,
                "files_present": names,
                "files_used": wanted,
                "files_not_used": [name for name in names if name not in wanted],
            }
        )
        for name in wanted:
            url = PAPERFOX_RAW.format(season=season, name=name)
            status, body = fetch(url, cache_dir, refresh=refresh)
            notes.append({"source": "paperfox", "url": url, "status": status, "season": season})
            if status != 200:
                continue
            qualifying = name.startswith("clq")
            competition = (
                "UEFA Champions League Qualifying" if qualifying else "UEFA Champions League"
            )
            for row in csv.DictReader(io.StringIO(body.decode("utf-8"))):
                when, imputed = _impute_paperfox_date(row.get("date") or "", season)
                if when is None:
                    continue
                home_raw, away_raw = row.get("home_score", ""), row.get("away_score", "")
                if home_raw == "" or away_raw == "":
                    continue
                matches.append(
                    Match(
                        date=when,
                        season=season,
                        competition=competition,
                        stage=(row.get("phase") or "").strip(),
                        home_team=normalize_team(row.get("home_team") or ""),
                        away_team=normalize_team(row.get("away_team") or ""),
                        home_goals=int(home_raw),
                        away_goals=int(away_raw),
                        source="paperfox",
                        priority=SOURCE_PRIORITY["paperfox"],
                        date_imputed=imputed,
                    )
                )
    return matches


def load_all(cache_dir: Path, refresh: bool = False) -> tuple[list[Match], list[dict]]:
    notes: list[dict] = []
    matches: list[Match] = []
    matches.extend(load_openfootball_cl(cache_dir, refresh, notes))
    matches.extend(load_football_json(cache_dir, refresh, notes))
    matches.extend(load_masryo(cache_dir, refresh, notes))
    matches.extend(load_paperfox(cache_dir, refresh, notes))
    return matches, notes
