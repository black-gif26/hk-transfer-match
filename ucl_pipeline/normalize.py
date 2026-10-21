"""Team, season, and competition normalization."""

from __future__ import annotations

import re
import unicodedata

# Exact renames seen across openfootball seasons and football.json top flights.
# Only pairs confirmed while inspecting 2021-22..2025-26 files. Longer 2024-25
# spellings are the canonical form. Distinct clubs are not folded together.
TEAM_ALIASES = {
    "AZ Alkmaar": "AZ",
    "AS Monaco": "AS Monaco FC",
    "Bayer Leverkusen": "Bayer 04 Leverkusen",
    "Dinamo Zagreb": "GNK Dinamo Zagreb",
    "NEC Nijmegen": "NEC",
    "PAE Olympiakos SFP": "Olympiakos Piraeus",
    "Royale Union Saint-Gilloise": "Union Saint-Gilloise",
    "Stade Rennais": "Stade Rennais FC 1901",
    "Atalanta": "Atalanta BC",
    "Atlético Madrid": "Club Atlético de Madrid",
    "Bayern München": "FC Bayern München",
    "Crvena Zvezda": "FK Crvena Zvezda",
    "Feyenoord": "Feyenoord Rotterdam",
    "Galatasaray": "Galatasaray SK",
    "Inter": "FC Internazionale Milano",
    "Juventus": "Juventus FC",
    "Manchester City": "Manchester City FC",
    "Manchester United": "Manchester United FC",
    "Olympique Marseille": "Olympique de Marseille",
    "Paris Saint-Germain": "Paris Saint-Germain FC",
    "PSV Eindhoven": "PSV",
    "RB Salzburg": "FC Red Bull Salzburg",
    "RC Lens": "Racing Club de Lens",
    "Real Madrid": "Real Madrid CF",
    "Shakhtar Donetsk": "FK Shakhtar Donetsk",
    "SK Sturm Graz": "SK Sturm Graz",
    "SL Benfica": "Sport Lisboa e Benfica",
    "Slavia Praha": "SK Slavia Praha",
    "Slovan Bratislava": "ŠK Slovan Bratislava",
    "Sporting Braga": "Sporting Clube de Braga",
    "Sporting CP": "Sporting Clube de Portugal",
    "Sturm Graz": "SK Sturm Graz",
    "Tottenham Hotspur": "Tottenham Hotspur FC",
}

_COUNTRY_SUFFIX = re.compile(r"\s+\([A-Z]{3}\)\s*$")
_WS = re.compile(r"\s+")


def normalize_team(name: str) -> str:
    text = unicodedata.normalize("NFKC", name or "")
    text = _COUNTRY_SUFFIX.sub("", text.strip())
    text = _WS.sub(" ", text).strip()
    return TEAM_ALIASES.get(text, text)


def season_key(text: str) -> str:
    """Normalize 2024/25, 2024/2025, and 2024-25 to 2024-25."""
    raw = text.strip()
    match = re.search(r"(20\d{2})\s*[/\-]\s*(\d{2,4})", raw)
    if not match:
        raise ValueError(f"unrecognized season: {text!r}")
    start = int(match.group(1))
    end = match.group(2)
    end_yy = int(end[-2:])
    if end_yy != (start + 1) % 100:
        raise ValueError(f"season years are not consecutive: {text!r}")
    return f"{start}-{end_yy:02d}"


COMPETITION_BY_CODE = {
    "en.1": "English Premier League",
    "es.1": "La Liga",
    "de.1": "Bundesliga",
    "it.1": "Serie A",
    "fr.1": "Ligue 1",
    "nl.1": "Eredivisie",
    "pt.1": "Primeira Liga",
    "at.1": "Austrian Bundesliga",
    "be.1": "Belgian Pro League",
    "tr.1": "Süper Lig",
    "sco.1": "Scottish Premiership",
    "gr.1": "Greek Super League",
    "uefa.cl": "UEFA Champions League",
}

MASRYO_COMPETITIONS = {
    "PL": "English Premier League",
    "PD": "La Liga",
    "BL1": "Bundesliga",
    "SA": "Serie A",
    "FL1": "Ligue 1",
    "CL": "UEFA Champions League",
}

TARGET_SEASONS = ("2021-22", "2022-23", "2023-24", "2024-25", "2025-26")

# Top divisions inspected in football.json. uefa.cl.json is optional per season.
DOMESTIC_CODES = (
    "en.1",
    "es.1",
    "de.1",
    "it.1",
    "fr.1",
    "nl.1",
    "pt.1",
    "at.1",
    "be.1",
    "tr.1",
    "sco.1",
    "gr.1",
)
