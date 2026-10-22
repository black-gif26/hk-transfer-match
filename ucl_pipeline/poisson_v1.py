"""Trained Poisson scoring model (V1).

V0 in predict.py stays the default production calculation. This module fits

    log λ_home = intercept + home_advantage + attack_home + defence_away + competition
    log λ_away = intercept + attack_away + defence_home + competition

Defence is a conceding effect: a higher value raises the opponent's expected goals.
Attack and defence are centered at zero, and the most common competition in the
fit is the reference level. Teams are shrunk toward those zeros with an L2 penalty.
Matches on or after the cutoff are excluded, including same-day matches.
"""

from __future__ import annotations

import csv
import json
import math
from collections import defaultdict
from dataclasses import dataclass
from datetime import date, datetime, timezone
from pathlib import Path

from ucl_pipeline.dedupe import dedupe
from ucl_pipeline.features import build_features
from ucl_pipeline.models import Match
from ucl_pipeline.predict import (
    league_edge,
    poisson_pmf,
    predict_fixture,
    score_markets,
    training_seasons,
)
from ucl_pipeline.sources import load_all

LOW_HISTORY = 5
ETA_MIN = -6.0
ETA_MAX = 2.5
PROB_FLOOR = 1e-15


@dataclass(frozen=True)
class V1Config:
    decays: tuple[float, ...] = (0.0, 0.0015, 0.004)
    l2_grid: tuple[float, ...] = (1.0, 4.0)
    max_iter: int = 200
    tol: float = 1e-5
    goal_limit: int = 10
    validation_season: str = "2024-25"
    test_season: str = "2025-26"


@dataclass
class PoissonFit:
    cutoff: date
    decay: float
    l2: float
    intercept: float
    home_advantage: float
    attack: dict[str, float]
    defence: dict[str, float]
    competition: dict[str, float]
    reference_competition: str
    team_counts: dict[str, int]
    team_competitions: dict[str, set[str]]
    n_matches: int
    iterations: int
    converged: bool
    max_abs_step: float
    weights_sum: float


def eligible_matches(matches: list[Match]) -> list[Match]:
    """Scored, undisputed 90-minute matches. Extra-time rows are already excluded upstream."""
    return [
        match
        for match in matches
        if match.goals_pair() is not None and not match.score_ambiguous and match.home_team and match.away_team
    ]


def time_weight(match_date: date, cutoff: date, decay: float) -> float:
    days = (cutoff - match_date).days
    if days <= 0:
        return 0.0
    if decay == 0:
        return 1.0
    return math.exp(-decay * days)


def _clamp_eta(value: float) -> float:
    if value > ETA_MAX:
        return ETA_MAX
    if value < ETA_MIN:
        return ETA_MIN
    return value


def fit_poisson(matches: list[Match], cutoff: date, decay: float, l2: float, config: V1Config) -> PoissonFit:
    """Weighted penalised Poisson scoring, using only matches dated before cutoff."""
    rows = [match for match in eligible_matches(matches) if match.date < cutoff]
    if not rows:
        raise ValueError(f"no eligible matches before {cutoff.isoformat()}")
    team_counts: dict[str, int] = defaultdict(int)
    comp_counts: dict[str, int] = defaultdict(int)
    team_comps: dict[str, set[str]] = defaultdict(set)
    for match in rows:
        team_counts[match.home_team] += 1
        team_counts[match.away_team] += 1
        comp_counts[match.competition] += 1
        team_comps[match.home_team].add(match.competition)
        team_comps[match.away_team].add(match.competition)
    teams = sorted(team_counts)
    competitions = sorted(comp_counts, key=lambda name: (-comp_counts[name], name))
    team_index = {name: index for index, name in enumerate(teams)}
    comp_index = {name: index for index, name in enumerate(competitions)}
    home_ix = [team_index[match.home_team] for match in rows]
    away_ix = [team_index[match.away_team] for match in rows]
    comp_ix = [comp_index[match.competition] for match in rows]
    yh = [match.home_goals or 0 for match in rows]
    ya = [match.away_goals or 0 for match in rows]
    weights = [time_weight(match.date, cutoff, decay) for match in rows]
    n_teams = len(teams)
    n_comps = len(competitions)
    attack = [0.0] * n_teams
    defence = [0.0] * n_teams
    comp = [0.0] * n_comps
    weight_sum = sum(weights)
    goal_sum = sum(weights[i] * (yh[i] + ya[i]) for i in range(len(rows)))
    intercept = math.log(max(goal_sum / (2.0 * weight_sum), 0.05))
    home_adv = 0.0

    def _project(attack_now: list[float], defence_now: list[float], comp_now: list[float]) -> tuple[list[float], list[float], list[float]]:
        mean_attack = sum(attack_now) / n_teams
        mean_defence = sum(defence_now) / n_teams
        projected_comp = comp_now[:]
        projected_comp[0] = 0.0
        return (
            [value - mean_attack for value in attack_now],
            [value - mean_defence for value in defence_now],
            projected_comp,
        )

    def _loss(intercept_now: float, home_now: float, attack_now: list[float], defence_now: list[float], comp_now: list[float]) -> float:
        total = 0.5 * l2 * home_now * home_now
        total += 0.5 * l2 * sum(value * value for value in attack_now)
        total += 0.5 * l2 * sum(value * value for value in defence_now)
        total += 0.5 * l2 * sum(value * value for value in comp_now[1:])
        for i, weight in enumerate(weights):
            home = home_ix[i]
            away = away_ix[i]
            competition = comp_ix[i]
            eta_home = _clamp_eta(intercept_now + home_now + attack_now[home] + defence_now[away] + comp_now[competition])
            eta_away = _clamp_eta(intercept_now + attack_now[away] + defence_now[home] + comp_now[competition])
            total += weight * (
                math.exp(eta_home)
                - yh[i] * eta_home
                + math.exp(eta_away)
                - ya[i] * eta_away
            )
        return total

    attack, defence, comp = _project(attack, defence, comp)
    current_loss = _loss(intercept, home_adv, attack, defence, comp)
    converged = False
    max_step = 1.0
    iteration = 0
    for iteration in range(1, config.max_iter + 1):
        g_int = g_ha = h_int = h_ha = 0.0
        g_att = [0.0] * n_teams
        h_att = [l2] * n_teams
        g_def = [0.0] * n_teams
        h_def = [l2] * n_teams
        g_comp = [0.0] * n_comps
        h_comp = [l2] * n_comps
        for i, weight in enumerate(weights):
            home = home_ix[i]
            away = away_ix[i]
            competition = comp_ix[i]
            eta_home = _clamp_eta(intercept + home_adv + attack[home] + defence[away] + comp[competition])
            eta_away = _clamp_eta(intercept + attack[away] + defence[home] + comp[competition])
            lam_home = math.exp(eta_home)
            lam_away = math.exp(eta_away)
            grad_home = weight * (lam_home - yh[i])
            grad_away = weight * (lam_away - ya[i])
            hess_home = weight * lam_home
            hess_away = weight * lam_away
            g_int += grad_home + grad_away
            h_int += hess_home + hess_away
            g_ha += grad_home
            h_ha += hess_home
            g_att[home] += grad_home
            h_att[home] += hess_home
            g_att[away] += grad_away
            h_att[away] += hess_away
            g_def[away] += grad_home
            h_def[away] += hess_home
            g_def[home] += grad_away
            h_def[home] += hess_away
            g_comp[competition] += grad_home + grad_away
            h_comp[competition] += hess_home + hess_away
        g_ha += l2 * home_adv
        h_ha += l2
        for index in range(n_teams):
            g_att[index] += l2 * attack[index]
            g_def[index] += l2 * defence[index]
        for index in range(1, n_comps):
            g_comp[index] += l2 * comp[index]
        g_comp[0] = 0.0

        def _newton(grad: float, hess: float) -> float:
            if hess <= 1e-8:
                return 0.0
            return grad / hess

        step_int = _newton(g_int, h_int)
        step_ha = _newton(g_ha, h_ha)
        step_att = [_newton(g_att[index], h_att[index]) for index in range(n_teams)]
        step_def = [_newton(g_def[index], h_def[index]) for index in range(n_teams)]
        step_comp = [0.0] + [_newton(g_comp[index], h_comp[index]) for index in range(1, n_comps)]
        accepted = False
        alpha = 1.0
        max_step = 0.0
        for _attempt in range(8):
            trial_attack, trial_defence, trial_comp = _project(
                [attack[index] - alpha * step_att[index] for index in range(n_teams)],
                [defence[index] - alpha * step_def[index] for index in range(n_teams)],
                [comp[index] - alpha * step_comp[index] for index in range(n_comps)],
            )
            trial_intercept = intercept - alpha * step_int
            trial_home = home_adv - alpha * step_ha
            trial_loss = _loss(trial_intercept, trial_home, trial_attack, trial_defence, trial_comp)
            if trial_loss <= current_loss + 1e-9:
                max_step = abs(alpha * step_int)
                max_step = max(max_step, abs(alpha * step_ha))
                max_step = max(max_step, max(abs(alpha * value) for value in step_att))
                max_step = max(max_step, max(abs(alpha * value) for value in step_def))
                if n_comps > 1:
                    max_step = max(max_step, max(abs(alpha * value) for value in step_comp[1:]))
                intercept = trial_intercept
                home_adv = trial_home
                attack, defence, comp = trial_attack, trial_defence, trial_comp
                current_loss = trial_loss
                accepted = True
                break
            alpha *= 0.5
        if not accepted or max_step < config.tol:
            converged = accepted and max_step < config.tol
            break
    return PoissonFit(
        cutoff=cutoff,
        decay=decay,
        l2=l2,
        intercept=intercept,
        home_advantage=home_adv,
        attack=dict(zip(teams, attack)),
        defence=dict(zip(teams, defence)),
        competition=dict(zip(competitions, comp)),
        reference_competition=competitions[0],
        team_counts=dict(team_counts),
        team_competitions={team: set(comps) for team, comps in team_comps.items()},
        n_matches=len(rows),
        iterations=iteration,
        converged=converged,
        max_abs_step=max_step,
        weights_sum=weight_sum,
    )


def _tail(lam: float, limit: int) -> float:
    covered = sum(poisson_pmf(goals, lam) for goals in range(limit + 1))
    return max(0.0, 1.0 - covered)


def predict_rates(fit: PoissonFit, home: str, away: str, competition: str, limit: int = 10) -> dict:
    """Scoreline markets from the fitted rates. Unseen teams abstain."""
    if home not in fit.attack or away not in fit.attack:
        return {"abstain": 1, "reason": "unseen_team"}
    comp_level = fit.competition.get(competition)
    unseen_comp = comp_level is None
    if comp_level is None:
        comp_level = 0.0
    eta_home = _clamp_eta(
        fit.intercept + fit.home_advantage + fit.attack[home] + fit.defence[away] + comp_level
    )
    eta_away = _clamp_eta(fit.intercept + fit.attack[away] + fit.defence[home] + comp_level)
    lam_home = math.exp(eta_home)
    lam_away = math.exp(eta_away)
    if not math.isfinite(lam_home) or not math.isfinite(lam_away) or lam_home <= 0 or lam_away <= 0:
        return {"abstain": 1, "reason": "non_finite_rate"}
    use_limit = limit
    tail = max(_tail(lam_home, use_limit), _tail(lam_away, use_limit))
    if tail > 1e-6:
        use_limit = max(limit, 15)
        tail = max(_tail(lam_home, use_limit), _tail(lam_away, use_limit))
    markets = score_markets(lam_home, lam_away, use_limit)
    total_1x2 = markets["p_home"] + markets["p_draw"] + markets["p_away"]
    total_ou = markets["p_over_25"] + markets["p_under_25"]
    if abs(total_1x2 - 1.0) > 1e-6 or abs(total_ou - 1.0) > 1e-6 or not 0.0 <= markets["p_btts"] <= 1.0:
        return {"abstain": 1, "reason": "probability_sum"}
    home_comps = fit.team_competitions.get(home, set())
    away_comps = fit.team_competitions.get(away, set())
    flags = []
    if fit.team_counts.get(home, 0) < LOW_HISTORY or fit.team_counts.get(away, 0) < LOW_HISTORY:
        flags.append("low_history")
    if not home_comps & away_comps:
        flags.append("cross_league_strength")
    if unseen_comp:
        flags.append("unseen_competition_level")
    return {
        "abstain": 0,
        "reason": "",
        "home_xg": lam_home,
        "away_xg": lam_away,
        "tail": tail,
        "flags": flags,
        **markets,
    }


def _outcome_index(home_goals: int, away_goals: int) -> int:
    if home_goals > away_goals:
        return 0
    if home_goals == away_goals:
        return 1
    return 2


def _metrics(rows: list[dict], prefix: str) -> dict[str, float]:
    if not rows:
        return {"n": 0}
    log_loss = brier = correct = 0.0
    ou_log = ou_brier = btts_log = btts_brier = 0.0
    for row in rows:
        probs = [row[f"p_home_{prefix}"], row[f"p_draw_{prefix}"], row[f"p_away_{prefix}"]]
        actual = _outcome_index(row["home_goals"], row["away_goals"])
        log_loss += -math.log(max(probs[actual], PROB_FLOOR))
        brier += sum((probs[index] - (1.0 if index == actual else 0.0)) ** 2 for index in range(3))
        correct += 1.0 if max(range(3), key=probs.__getitem__) == actual else 0.0
        over = 1.0 if row["home_goals"] + row["away_goals"] >= 3 else 0.0
        p_over = row[f"p_over_{prefix}"]
        ou_log += -(over * math.log(max(p_over, PROB_FLOOR)) + (1.0 - over) * math.log(max(1.0 - p_over, PROB_FLOOR)))
        ou_brier += (p_over - over) ** 2
        btts = 1.0 if row["home_goals"] >= 1 and row["away_goals"] >= 1 else 0.0
        p_btts = row[f"p_btts_{prefix}"]
        btts_log += -(btts * math.log(max(p_btts, PROB_FLOOR)) + (1.0 - btts) * math.log(max(1.0 - p_btts, PROB_FLOOR)))
        btts_brier += (p_btts - btts) ** 2
    n = float(len(rows))
    return {
        "n": len(rows),
        "log_loss_1x2": log_loss / n,
        "brier_1x2": brier / n,
        "accuracy_1x2": correct / n,
        "log_loss_ou25": ou_log / n,
        "brier_ou25": ou_brier / n,
        "log_loss_btts": btts_log / n,
        "brier_btts": btts_brier / n,
    }


def _frequency_baseline(train: list[Match]) -> dict[str, float]:
    home = draw = away = over = btts = 0
    for match in train:
        pair = match.goals_pair()
        if pair is None:
            continue
        home_goals, away_goals = pair
        if home_goals > away_goals:
            home += 1
        elif home_goals == away_goals:
            draw += 1
        else:
            away += 1
        if home_goals + away_goals >= 3:
            over += 1
        if home_goals >= 1 and away_goals >= 1:
            btts += 1
    total = home + draw + away
    if total == 0:
        raise ValueError("frequency baseline has no matches")
    return {
        "p_home": home / total,
        "p_draw": draw / total,
        "p_away": away / total,
        "p_over": over / total,
        "p_btts": btts / total,
        "n": total,
    }


def _v0_by_fixture(history: list[Match], fixtures: list[Match]) -> dict[tuple, dict]:
    seasons = set(training_seasons(5))
    scoped = [
        match
        for match in eligible_matches(history)
        if match.season in seasons or match.season == "2026-27"
    ]
    ordered = sorted(fixtures, key=lambda match: (match.date, match.home_team, match.away_team))
    features = build_features(scoped, ordered)
    edge_rows = sorted((match for match in scoped if match.season in seasons), key=lambda match: match.date)
    sums: dict[str, list[float]] = defaultdict(lambda: [0.0, 0.0, 0.0])
    index = 0
    out: dict[tuple, dict] = {}
    for fixture, feature in zip(ordered, features):
        while index < len(edge_rows) and edge_rows[index].date < fixture.date:
            match = edge_rows[index]
            bucket = sums[match.competition]
            bucket[0] += match.home_goals or 0
            bucket[1] += match.away_goals or 0
            bucket[2] += 1
            index += 1
        bucket = sums[fixture.competition]
        edge = (bucket[0] / bucket[2], bucket[1] / bucket[2]) if bucket[2] else None
        out[(fixture.date, fixture.home_team, fixture.away_team)] = predict_fixture(feature, edge, form_n=10)
    return out


def _month_start(day: date) -> date:
    return date(day.year, day.month, 1)


def _score_period(
    history: list[Match],
    fixtures: list[Match],
    decay: float,
    l2: float,
    config: V1Config,
) -> list[dict]:
    by_cutoff: dict[date, list[Match]] = defaultdict(list)
    for fixture in fixtures:
        by_cutoff[_month_start(fixture.date)].append(fixture)
    v0 = _v0_by_fixture(history, fixtures)
    rows: list[dict] = []
    for cutoff in sorted(by_cutoff):
        fit = fit_poisson(history, cutoff, decay, l2, config)
        train = [match for match in eligible_matches(history) if match.date < cutoff]
        base = _frequency_baseline(train)
        for fixture in by_cutoff[cutoff]:
            key = (fixture.date, fixture.home_team, fixture.away_team)
            v0_row = v0[key]
            v1 = predict_rates(fit, fixture.home_team, fixture.away_team, fixture.competition, config.goal_limit)
            v0_ok = v0_row["p_home"] != ""
            row = {
                "date": fixture.date.isoformat(),
                "cutoff": cutoff.isoformat(),
                "season": fixture.season,
                "competition": fixture.competition,
                "home_team": fixture.home_team,
                "away_team": fixture.away_team,
                "home_goals": fixture.home_goals,
                "away_goals": fixture.away_goals,
                "v0_ok": int(v0_ok),
                "v1_ok": 0 if v1["abstain"] else 1,
                "v1_flags": ",".join(v1.get("flags", [])),
                "v1_tail": v1.get("tail", ""),
                "converged": int(fit.converged),
            }
            if v0_ok:
                row.update(
                    {
                        "p_home_v0": float(v0_row["p_home"]),
                        "p_draw_v0": float(v0_row["p_draw"]),
                        "p_away_v0": float(v0_row["p_away"]),
                        "p_over_v0": float(v0_row["p_over_25"]),
                        "p_btts_v0": float(v0_row["p_btts"]),
                        "home_xg_v0": float(v0_row["home_xg"]),
                        "away_xg_v0": float(v0_row["away_xg"]),
                    }
                )
            if not v1["abstain"]:
                row.update(
                    {
                        "p_home_v1": v1["p_home"],
                        "p_draw_v1": v1["p_draw"],
                        "p_away_v1": v1["p_away"],
                        "p_over_v1": v1["p_over_25"],
                        "p_btts_v1": v1["p_btts"],
                        "home_xg_v1": v1["home_xg"],
                        "away_xg_v1": v1["away_xg"],
                    }
                )
            row.update(
                {
                    "p_home_base": base["p_home"],
                    "p_draw_base": base["p_draw"],
                    "p_away_base": base["p_away"],
                    "p_over_base": base["p_over"],
                    "p_btts_base": base["p_btts"],
                }
            )
            rows.append(row)
    return rows


def _comparable(rows: list[dict]) -> list[dict]:
    return [row for row in rows if row["v0_ok"] and row["v1_ok"]]


def select_and_evaluate(matches: list[Match], config: V1Config | None = None) -> dict:
    """Tune decay and L2 on the validation season, then score the untouched test season."""
    config = config or V1Config()
    history = eligible_matches(matches)
    validation = [match for match in history if match.season == config.validation_season]
    test = [match for match in history if match.season == config.test_season]
    if not validation or not test:
        raise ValueError("validation and test seasons need eligible matches")
    grid = []
    best = None
    for decay in config.decays:
        for l2 in config.l2_grid:
            scored = _score_period(history, validation, decay, l2, config)
            compared = _comparable(scored)
            metrics = _metrics(compared, "v1")
            entry = {"decay": decay, "l2": l2, "metrics": metrics, "rows": scored}
            grid.append({"decay": decay, "l2": l2, "n": metrics.get("n", 0), "log_loss_1x2": metrics.get("log_loss_1x2")})
            if metrics.get("n", 0) == 0:
                continue
            if best is None or metrics["log_loss_1x2"] < best["metrics"]["log_loss_1x2"]:
                best = entry
    if best is None:
        raise ValueError("validation produced no comparable fixtures")
    test_rows = _score_period(history, test, best["decay"], best["l2"], config)
    compared = _comparable(test_rows)
    last_cutoff = max(_month_start(match.date) for match in test)
    final_fit = fit_poisson(history, last_cutoff, best["decay"], best["l2"], config)
    return {
        "config": {
            "decays": list(config.decays),
            "l2_grid": list(config.l2_grid),
            "validation_season": config.validation_season,
            "test_season": config.test_season,
            "v0": "5-season window, last 10 matches, production predict_fixture",
            "v1_refit": "first day of each fixture month, matches with date < cutoff",
        },
        "validation_grid": grid,
        "chosen": {"decay": best["decay"], "l2": best["l2"], "validation": best["metrics"]},
        "test": {
            "n_candidates": len(test_rows),
            "n_comparable": len(compared),
            "coverage_v0": sum(row["v0_ok"] for row in test_rows) / len(test_rows),
            "coverage_v1": sum(row["v1_ok"] for row in test_rows) / len(test_rows),
            "v0": _metrics(compared, "v0"),
            "v1": _metrics(compared, "v1"),
            "frequency_baseline": _metrics(compared, "base"),
            "low_history": sum("low_history" in row["v1_flags"] for row in test_rows),
            "cross_league": sum("cross_league_strength" in row["v1_flags"] for row in test_rows),
            "fits_converged": all(row["converged"] for row in test_rows),
        },
        "validation_rows": best["rows"],
        "test_rows": test_rows,
        "fit": final_fit,
    }


def _write_rows(path: Path, rows: list[dict]) -> None:
    fields = [
        "date",
        "cutoff",
        "season",
        "competition",
        "home_team",
        "away_team",
        "home_goals",
        "away_goals",
        "v0_ok",
        "v1_ok",
        "v1_flags",
        "v1_tail",
        "home_xg_v0",
        "away_xg_v0",
        "home_xg_v1",
        "away_xg_v1",
        "p_home_v0",
        "p_draw_v0",
        "p_away_v0",
        "p_over_v0",
        "p_btts_v0",
        "p_home_v1",
        "p_draw_v1",
        "p_away_v1",
        "p_over_v1",
        "p_btts_v1",
        "p_home_base",
        "p_draw_base",
        "p_away_base",
        "p_over_base",
        "p_btts_base",
    ]
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)


def _fit_payload(fit: PoissonFit) -> dict:
    attacks = list(fit.attack.values())
    defences = list(fit.defence.values())
    return {
        "cutoff": fit.cutoff.isoformat(),
        "decay": fit.decay,
        "l2": fit.l2,
        "intercept": fit.intercept,
        "home_advantage": fit.home_advantage,
        "reference_competition": fit.reference_competition,
        "competition": fit.competition,
        "attack": fit.attack,
        "defence": fit.defence,
        "team_counts": fit.team_counts,
        "n_matches": fit.n_matches,
        "iterations": fit.iterations,
        "converged": fit.converged,
        "max_abs_step": fit.max_abs_step,
        "mean_attack": sum(attacks) / len(attacks),
        "mean_defence": sum(defences) / len(defences),
        "min_rate_guard": {"eta_min": ETA_MIN, "eta_max": ETA_MAX},
    }


def write_artifacts(result: dict, output_dir: Path, stamp: str | None = None) -> Path:
    stamp = stamp or datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    folder = output_dir / "v1" / stamp
    folder.mkdir(parents=True, exist_ok=True)
    public = {
        "config": result["config"],
        "validation_grid": result["validation_grid"],
        "chosen": result["chosen"],
        "test": result["test"],
    }
    (folder / "metrics.json").write_text(json.dumps(public, indent=2), encoding="utf-8")
    (folder / "parameters.json").write_text(json.dumps(_fit_payload(result["fit"]), indent=2), encoding="utf-8")
    _write_rows(folder / "predictions_validation.csv", result["validation_rows"])
    _write_rows(folder / "predictions_test.csv", result["test_rows"])
    test = result["test"]
    lines = [
        "# Poisson V1 walk-forward",
        "",
        f"Chosen on {result['config']['validation_season']} only: decay={result['chosen']['decay']}, l2={result['chosen']['l2']}.",
        f"Test season {result['config']['test_season']} was not used to choose those values.",
        "V1 refits on the first day of each fixture month. V0 is the production 5-season, last-10 calculation.",
        "Comparable rows are fixtures where both models returned probabilities.",
        "",
        f"Test candidates: {test['n_candidates']}. Comparable: {test['n_comparable']}.",
        f"Coverage V0: {test['coverage_v0']:.3f}. Coverage V1: {test['coverage_v1']:.3f}.",
        f"Fits converged: {test['fits_converged']}.",
        "",
        "| Model | 1X2 log loss | 1X2 Brier | 1X2 accuracy | O/U log loss | BTTS log loss |",
        "| --- | --- | --- | --- | --- | --- |",
    ]
    for name in ("frequency_baseline", "v0", "v1"):
        metrics = test[name]
        lines.append(
            f"| {name} | {metrics['log_loss_1x2']:.4f} | {metrics['brier_1x2']:.4f} | "
            f"{metrics['accuracy_1x2']:.3f} | {metrics['log_loss_ou25']:.4f} | {metrics['log_loss_btts']:.4f} |"
        )
    lines.extend(
        [
            "",
            f"Low-history flags: {test['low_history']}. Cross-league strength flags: {test['cross_league']}.",
            "Attack and defence are centered at zero. The reference competition level is zero.",
            "A cross-league flag means the two clubs have no shared competition in the fit, so their strengths are not on a common scale.",
        ]
    )
    (folder / "report.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    return folder


def load_history(cache_dir: Path, refresh: bool = False) -> list[Match]:
    raw, _notes = load_all(cache_dir, refresh=refresh)
    history, _conflicts, _ambiguous = dedupe(raw)
    return history


def run_v1(cache_dir: Path, output_dir: Path, refresh: bool = False, config: V1Config | None = None) -> Path:
    result = select_and_evaluate(load_history(cache_dir, refresh=refresh), config)
    return write_artifacts(result, output_dir)
