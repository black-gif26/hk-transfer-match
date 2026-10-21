"""Collapse the same fixture across sources and record score conflicts."""

from __future__ import annotations

from collections import defaultdict
from dataclasses import replace

from ucl_pipeline.models import Match


def _cluster(items: list[Match]) -> list[list[Match]]:
    clusters: list[list[Match]] = []
    for match in sorted(items, key=lambda row: (row.date, row.priority)):
        if clusters and abs((match.date - clusters[-1][0].date).days) <= 1:
            clusters[-1].append(match)
            continue
        clusters.append([match])
    return clusters


def dedupe(matches: list[Match]) -> tuple[list[Match], list[dict], list[dict]]:
    buckets: dict[tuple[str, str, str, str], list[Match]] = defaultdict(list)
    for match in matches:
        if not match.home_team or not match.away_team:
            continue
        buckets[(match.season, match.competition, match.home_team, match.away_team)].append(match)

    kept: list[Match] = []
    conflicts: list[dict] = []
    ambiguous: list[dict] = []
    for items in buckets.values():
        clusters = _cluster(items)
        for cluster in clusters:
            winner = min(cluster, key=lambda row: (row.priority, row.date.isoformat()))
            ambiguous_reason = winner.ambiguous_reason
            ambiguous_flag = winner.score_ambiguous
            for other in cluster:
                if other is winner:
                    continue
                if other.date != winner.date:
                    conflicts.append(_conflict("date_disagreement", winner, other))
                if (
                    winner.goals_pair() is not None
                    and other.goals_pair() is not None
                    and winner.goals_pair() != other.goals_pair()
                ):
                    conflicts.append(_conflict("score_conflict", winner, other))
                elif (
                    not ambiguous_flag
                    and other.score_ambiguous
                    and other.goals_pair() == winner.goals_pair()
                    and winner.goals_pair() is not None
                ):
                    ambiguous_flag = True
                    ambiguous_reason = other.ambiguous_reason or ambiguous_reason
            winner = replace(
                winner,
                score_ambiguous=ambiguous_flag,
                ambiguous_reason=ambiguous_reason,
            )
            if winner.score_ambiguous or winner.goals_pair() is None:
                ambiguous.append(
                    {
                        "date": winner.date.isoformat(),
                        "season": winner.season,
                        "competition": winner.competition,
                        "stage": winner.stage,
                        "home_team": winner.home_team,
                        "away_team": winner.away_team,
                        "source": winner.source,
                        "home_goals": "" if winner.home_goals is None else winner.home_goals,
                        "away_goals": "" if winner.away_goals is None else winner.away_goals,
                        "reason": winner.ambiguous_reason or "ambiguous",
                    }
                )
            if winner.goals_pair() is None:
                continue
            kept.append(winner)
    kept.sort(key=lambda row: (row.date, row.competition, row.home_team, row.away_team))
    return kept, conflicts, ambiguous


def _conflict(reason: str, winner: Match, other: Match) -> dict:
    return {
        "reason": reason,
        "season": winner.season,
        "competition": winner.competition,
        "date": winner.date.isoformat(),
        "home_team": winner.home_team,
        "away_team": winner.away_team,
        "kept_source": winner.source,
        "kept_home_goals": "" if winner.home_goals is None else winner.home_goals,
        "kept_away_goals": "" if winner.away_goals is None else winner.away_goals,
        "other_source": other.source,
        "other_date": other.date.isoformat(),
        "other_home_goals": "" if other.home_goals is None else other.home_goals,
        "other_away_goals": "" if other.away_goals is None else other.away_goals,
    }
