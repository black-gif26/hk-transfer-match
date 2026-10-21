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


# UEFA Europa League league phase matchday 3, Thursday 22 October 2026.
# Times are Hong Kong time on 23 October. Home and away follow the UEFA fixture list.
# https://www.uefa.com/uefaeuropaleague/news/02a8-2174cafa5bb6-82bbc20c9b92-1000--2026-27-europa-league-all-the-league-phase-fixtures-and-re/
EL_2026_10_22 = (
    ("00:45 HK", "FC Ararat-Armenia", "AZ"),
    ("00:45 HK", "Ferencvárosi TC", "SCU Torreense"),
    ("00:45 HK", "GNK Dinamo Zagreb", "NEC"),
    ("00:45 HK", "Juventus FC", "Stade Rennais FC 1901"),
    ("00:45 HK", "Lech Poznań", "Sunderland AFC"),
    ("00:45 HK", "OFI Heraklion", "Bayer 04 Leverkusen"),
    ("00:45 HK", "Union Saint-Gilloise", "Hapoel Be'er Sheva"),
    ("00:45 HK", "SK Sturm Graz", "Olympique de Marseille"),
    ("03:00 HK", "AFC Bournemouth", "AC Milan"),
    ("03:00 HK", "Beşiktaş", "Crystal Palace FC"),
    ("03:00 HK", "Celtic FC", "RC Celta de Vigo"),
    ("03:00 HK", "Viktoria Plzeň", "PFC Levski Sofia"),
    ("03:00 HK", "Jagiellonia Białystok", "RSC Anderlecht"),
    ("03:00 HK", "Lillestrøm SK", "Real Sociedad de Fútbol"),
    ("03:00 HK", "NK Celje", "FC Red Bull Salzburg"),
    ("03:00 HK", "Olympiakos Piraeus", "AC Sparta Praha"),
    ("03:00 HK", "AC Omonia", "Sport Lisboa e Benfica"),
    ("03:00 HK", "TSG 1899 Hoffenheim", "Olympique Lyonnais"),
)


def web_fixtures_on(on: date) -> list[Match]:
    if on == date(2026, 10, 21):
        rows = UCL_2026_10_21
        competition = "UEFA Champions League"
        stage = "League phase Matchday 3"
    elif on == date(2026, 10, 22):
        rows = EL_2026_10_22
        competition = "UEFA Europa League"
        stage = "League phase Matchday 3"
    else:
        return []
    return [
        Match(
            date=on,
            season="2026-27",
            competition=competition,
            stage=stage,
            home_team=home,
            away_team=away,
            home_goals=None,
            away_goals=None,
            source="uefa.com",
            priority=9,
            kickoff=kickoff,
        )
        for kickoff, home, away in rows
    ]
