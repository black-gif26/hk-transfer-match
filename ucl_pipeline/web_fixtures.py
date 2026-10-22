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
# HKJC coupon names (FB code, home, away) are the 23 October 2026 football board.
# The same pairings appear on the public HKJC-number boards at data4mula.com and aupong.hk.
# These names are display only. Canonical English names stay the model keys.
HKJC_EL_2026_10_22 = {
    ("FC Ararat-Armenia", "AZ"): ("FB7347", "艾拉華特阿美尼亞", "阿爾克馬爾"),
    ("Ferencvárosi TC", "SCU Torreense"): ("FB7333", "費倫斯華路士", "杜連斯"),
    ("GNK Dinamo Zagreb", "NEC"): ("FB7331", "薩格勒布戴拿模", "奈梅亨"),
    ("Juventus FC", "Stade Rennais FC 1901"): ("FB7332", "祖雲達斯", "雷恩"),
    ("Lech Poznań", "Sunderland AFC"): ("FB7330", "列治普斯納", "新特蘭"),
    ("OFI Heraklion", "Bayer 04 Leverkusen"): ("FB7343", "克里特", "利華古遜"),
    ("Union Saint-Gilloise", "Hapoel Be'er Sheva"): ("FB7353", "聖基萊斯聯", "比亞斯華夏普爾"),
    ("SK Sturm Graz", "Olympique de Marseille"): ("FB7354", "格拉茨", "馬賽"),
    ("AFC Bournemouth", "AC Milan"): ("FB7338", "般尼茅夫", "AC米蘭"),
    ("Beşiktaş", "Crystal Palace FC"): ("FB7339", "比錫達斯", "水晶宮"),
    ("Celtic FC", "RC Celta de Vigo"): ("FB7336", "些路迪", "切爾達"),
    ("Viktoria Plzeň", "PFC Levski Sofia"): ("FB7337", "柏辛域陀尼亞", "索菲亞利夫斯基"),
    ("Jagiellonia Białystok", "RSC Anderlecht"): ("FB7334", "積基朗尼亞", "安德列治"),
    ("Lillestrøm SK", "Real Sociedad de Fútbol"): ("FB7346", "利尼史特朗", "皇家蘇斯達"),
    ("NK Celje", "FC Red Bull Salzburg"): ("FB7355", "施捷", "薩爾斯堡"),
    ("Olympiakos Piraeus", "AC Sparta Praha"): ("FB7342", "奧林比亞高斯", "布拉格斯巴達"),
    ("AC Omonia", "Sport Lisboa e Benfica"): ("FB7341", "奧摩尼亞", "賓菲加"),
    ("TSG 1899 Hoffenheim", "Olympique Lyonnais"): ("FB7335", "賀芬咸", "里昂"),
}
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


def hkjc_label(home: str, away: str) -> tuple[str, str, str]:
    """Return HKJC code and Chinese names. Empty strings when this fixture has none."""
    code, home_zh, away_zh = HKJC_EL_2026_10_22.get((home, away), ("", "", ""))
    return code, home_zh, away_zh


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
