"""Fixtures that are not in the training files.

2026-10-21 Champions League league-phase matchday 3, taken from BBC Sport
and FBref. Kickoff times are UK time. Home and away follow those pages.
"""

from __future__ import annotations

from datetime import date

from ucl_pipeline.models import Match

UCL_2026_10_21 = (
    ("17:45 UK", "Como 1907", "Manchester United FC"),
    ("17:45 UK", "Lille OSC", "Galatasaray SK"),
    ("20:00 UK", "Aston Villa FC", "Viking FK"),
    ("20:00 UK", "FC Bayern München", "Arsenal FC"),
    ("20:00 UK", "Club Brugge KV", "Racing Club de Lens"),
    ("20:00 UK", "FC Internazionale Milano", "FK Shakhtar Donetsk"),
    ("20:00 UK", "Real Betis Balompié", "Feyenoord Rotterdam"),
    ("20:00 UK", "Real Madrid CF", "RB Leipzig"),
    ("20:00 UK", "Sporting Clube de Portugal", "LASK"),
)


def web_fixtures_on(on: date) -> list[Match]:
    if on != date(2026, 10, 21):
        return []
    return [
        Match(
            date=on,
            season="2026-27",
            competition="UEFA Champions League",
            stage="League phase Matchday 3",
            home_team=home,
            away_team=away,
            home_goals=None,
            away_goals=None,
            source="bbc-fbref",
            priority=9,
            kickoff=kickoff,
        )
        for kickoff, home, away in UCL_2026_10_21
    ]
