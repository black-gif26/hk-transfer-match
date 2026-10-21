"""Football.TXT score grammar (sportdb score-formats).

`5-1 pen. 2-2 a.e.t. (1-1, 1-0)` means penalties 5-1, score after extra
time 2-2, 90-minute score 1-1, half-time 1-0. Exported goals are the
90-minute pair only.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

_P = r"(?:p|pen\.?|pso)"
_ET = r"(?:aet|a\.e\.t\.?)"

# Optional penalties, extra-time score, then (90-minute, optional half-time).
_P_ET_FT = re.compile(
    rf"^(?:(?P<ph>\d{{1,2}})\s*-\s*(?P<pa>\d{{1,2}})\s+{_P}\s+)?"
    rf"(?P<eth>\d{{1,2}})\s*-\s*(?P<eta>\d{{1,2}})\s+{_ET}\s*"
    rf"\(\s*(?P<fth>\d{{1,2}})\s*-\s*(?P<fta>\d{{1,2}})"
    rf"(?:\s*,\s*(?:(?P<hth>\d{{1,2}})\s*-\s*(?P<hta>\d{{1,2}}))?[^)]*)?\)\s*$",
    re.IGNORECASE,
)
# Penalties and (90-minute, optional half-time), no extra time.
_P_FT = re.compile(
    rf"^(?P<ph>\d{{1,2}})\s*-\s*(?P<pa>\d{{1,2}})\s+{_P}\s*"
    rf"\(\s*(?P<fth>\d{{1,2}})\s*-\s*(?P<fta>\d{{1,2}})"
    rf"(?:\s*,\s*(?:(?P<hth>\d{{1,2}})\s*-\s*(?P<hta>\d{{1,2}}))?[^)]*)?\)\s*$",
    re.IGNORECASE,
)
# Extra time or penalties without a parenthetical 90-minute score.
_ET_OR_PEN_ONLY = re.compile(
    rf"^(?:(?P<ph>\d{{1,2}})\s*-\s*(?P<pa>\d{{1,2}})\s+{_P}\s+)?"
    rf"(?:(?P<eth>\d{{1,2}})\s*-\s*(?P<eta>\d{{1,2}})\s+{_ET})?\s*$",
    re.IGNORECASE,
)
_FT = re.compile(
    r"^(?P<fth>\d{1,2})\s*-\s*(?P<fta>\d{1,2})"
    r"(?:\s*\(\s*(?P<hth>\d{1,2})\s*-\s*(?P<hta>\d{1,2})\s*\))?\s*$"
)


@dataclass(frozen=True)
class ParsedScore:
    home_goals: int | None
    away_goals: int | None
    ambiguous: bool
    reason: str


def parse_score(text: str) -> ParsedScore:
    raw = text.strip()
    if not raw:
        return ParsedScore(None, None, False, "unplayed")
    match = _P_ET_FT.match(raw)
    if match and match.group("fth") is not None:
        return ParsedScore(int(match.group("fth")), int(match.group("fta")), False, "")
    match = _P_FT.match(raw)
    if match:
        return ParsedScore(int(match.group("fth")), int(match.group("fta")), False, "")
    if _ET_OR_PEN_ONLY.match(raw) and re.search(rf"{_ET}|{_P}", raw, re.I):
        return ParsedScore(None, None, True, "extra_time_or_penalties_without_90_minute_score")
    match = _FT.match(raw)
    if match:
        return ParsedScore(int(match.group("fth")), int(match.group("fta")), False, "")
    return ParsedScore(None, None, True, "unparsed_score")
