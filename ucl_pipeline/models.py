"""Shared match record."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date


@dataclass
class Match:
    date: date
    season: str
    competition: str
    stage: str
    home_team: str
    away_team: str
    home_goals: int | None
    away_goals: int | None
    source: str
    priority: int
    score_ambiguous: bool = False
    ambiguous_reason: str = ""
    date_imputed: bool = False
    kickoff: str = ""

    def goals_pair(self) -> tuple[int, int] | None:
        if self.home_goals is None or self.away_goals is None:
            return None
        return (self.home_goals, self.away_goals)


# Lower number wins when two sources describe the same fixture.
# openfootball text keeps the 90-minute score separate from extra time.
# football.json `ft` is the 90-minute score. Masryo fulltime matches that
# for 2024-25 and carries the AWARDED flag. PaperFox CSVs reuse the first
# score token, so extra-time scores can land in the 90-minute columns.
SOURCE_PRIORITY = {
    "openfootball-cl": 1,
    "football.json": 2,
    "tarekmasryo": 3,
    "paperfox": 4,
}
