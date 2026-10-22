"""Trained Poisson scoring model (V1).

V0 in predict.py stays the default production calculation. This module fits

    log λ_home = intercept + home_advantage + attack_home + defence_away + competition
    log λ_away = intercept + attack_away + defence_home + competition

Defence is a conceding effect: a higher value raises the opponent's expected goals.
The most common competition in the fit is the reference level and is fixed at 0.
Attack parameters sum to 0 and defence parameters sum to 0. Those constraints
are the parameter domain: free coefficients multiply an orthonormal Helmert
basis of the sum-to-zero subspace. The optimizer does not project after each step.
Teams are shrunk toward those zeros with an L2 penalty.
Matches on or after the cutoff are excluded, including same-day matches.

Objective, as a sum rather than a mean. The Poisson log(y!) term does not depend
on the parameters and is omitted.

    L = Σ_i w_i (exp(η_home,i) - y_home,i η_home,i + exp(η_away,i) - y_away,i η_away,i)
      + (l2 / 2) * (home_advantage² + Σ_teams attack² + Σ_teams defence²
                    + Σ_{competitions except reference} competition²)

w_i = 1 when decay is 0, and exp(-decay * days_before_cutoff) otherwise. Rows with
days <= 0 are not in the fit. L2 is not multiplied by the number of matches or by
the weight sum. The penalty is applied to the reconstructed attack and defence vectors, which
already sum to zero. The training loss does not clip η.
Prediction still clamps η to [ETA_MIN, ETA_MAX] when building scoreline markets.
"""

from __future__ import annotations

import csv
import json
import math
import time
from collections import defaultdict
from dataclasses import dataclass
from datetime import date, datetime, timezone
from pathlib import Path

import numpy as np
from scipy.optimize import minimize

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
# Frozen on 2024–25 validation log loss. Do not retune from 2025–26.
FROZEN_DECAY = 0.0015
FROZEN_L2 = 4.0
NON_DOMESTIC = frozenset(
    {
        "UEFA Champions League",
        "UEFA Champions League Qualifying",
        "UEFA Europa League",
    }
)


@dataclass(frozen=True)
class V1Config:
    decays: tuple[float, ...] = (0.0, 0.0015, 0.004)
    l2_grid: tuple[float, ...] = (1.0, 4.0)
    max_iter: int = 2000
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
    objective: float
    grad_inf: float
    status: int
    message: str
    runtime_seconds: float
    bound_hits: int
    clip_hits: int
    n_components: int
    component_sizes: tuple[int, ...]
    nfev: int


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


@dataclass
class _Design:
    teams: list[str]
    competitions: list[str]
    team_counts: dict[str, int]
    team_comps: dict[str, set[str]]
    home_ix: np.ndarray
    away_ix: np.ndarray
    comp_ix: np.ndarray
    yh: np.ndarray
    ya: np.ndarray
    weights: np.ndarray
    weight_sum: float
    mean_log_rate: float
    component_sizes: tuple[int, ...]
    team_basis: np.ndarray

    @property
    def n_teams(self) -> int:
        return len(self.teams)

    @property
    def n_comps(self) -> int:
        return len(self.competitions)

    @property
    def n_free_teams(self) -> int:
        return max(self.n_teams - 1, 0)

    @property
    def dim(self) -> int:
        return 2 + 2 * self.n_free_teams + max(self.n_comps - 1, 0)


def _sum_zero_basis(n_teams: int) -> np.ndarray:
    """Orthonormal columns that each sum to zero. Empty when there is one team."""
    basis = np.zeros((n_teams, max(n_teams - 1, 0)), dtype=np.float64)
    for column in range(n_teams - 1):
        scale = math.sqrt((column + 1) * (column + 2))
        basis[: column + 1, column] = 1.0 / scale
        basis[column + 1, column] = -(column + 1) / scale
    return basis


def _components(n_teams: int, home_ix: np.ndarray, away_ix: np.ndarray) -> tuple[int, ...]:
    parent = list(range(n_teams))

    def find(index: int) -> int:
        while parent[index] != index:
            parent[index] = parent[parent[index]]
            index = parent[index]
        return index

    for home, away in zip(home_ix.tolist(), away_ix.tolist()):
        left, right = find(home), find(away)
        if left != right:
            parent[right] = left
    sizes: dict[int, int] = defaultdict(int)
    for index in range(n_teams):
        sizes[find(index)] += 1
    return tuple(sorted(sizes.values(), reverse=True))


def _prepare(matches: list[Match], cutoff: date, decay: float) -> _Design:
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
    home_ix = np.array([team_index[match.home_team] for match in rows], dtype=np.int64)
    away_ix = np.array([team_index[match.away_team] for match in rows], dtype=np.int64)
    weights = np.array([time_weight(match.date, cutoff, decay) for match in rows], dtype=np.float64)
    weight_sum = float(weights.sum())
    yh = np.array([match.home_goals or 0 for match in rows], dtype=np.float64)
    ya = np.array([match.away_goals or 0 for match in rows], dtype=np.float64)
    goal_sum = float(np.sum(weights * (yh + ya)))
    return _Design(
        teams=teams,
        competitions=competitions,
        team_counts=dict(team_counts),
        team_comps={team: set(comps) for team, comps in team_comps.items()},
        home_ix=home_ix,
        away_ix=away_ix,
        comp_ix=np.array([comp_index[match.competition] for match in rows], dtype=np.int64),
        yh=yh,
        ya=ya,
        weights=weights,
        weight_sum=weight_sum,
        mean_log_rate=math.log(max(goal_sum / (2.0 * weight_sum), 0.05)),
        component_sizes=_components(len(teams), home_ix, away_ix),
        team_basis=_sum_zero_basis(len(teams)),
    )


def _unpack(design: _Design, theta: np.ndarray) -> tuple[float, float, np.ndarray, np.ndarray, np.ndarray]:
    free = design.n_free_teams
    intercept = float(theta[0])
    home = float(theta[1])
    if free:
        attack = design.team_basis @ theta[2 : 2 + free]
        defence = design.team_basis @ theta[2 + free : 2 + 2 * free]
    else:
        attack = np.zeros(design.n_teams, dtype=np.float64)
        defence = np.zeros(design.n_teams, dtype=np.float64)
    comp = np.zeros(design.n_comps, dtype=np.float64)
    comp_free = theta[2 + 2 * free :]
    if comp_free.size:
        comp[1:] = comp_free
    return intercept, home, attack, defence, comp


def _evaluate(design: _Design, l2: float, theta: np.ndarray) -> tuple[float, np.ndarray, int]:
    """Unclipped penalised loss and the gradient of the reduced parameter vector."""
    intercept, home, attack, defence, comp = _unpack(design, theta)
    eta_home = intercept + home + attack[design.home_ix] + defence[design.away_ix] + comp[design.comp_ix]
    eta_away = intercept + attack[design.away_ix] + defence[design.home_ix] + comp[design.comp_ix]
    clip_hits = int(np.sum((eta_home < ETA_MIN) | (eta_home > ETA_MAX)))
    clip_hits += int(np.sum((eta_away < ETA_MIN) | (eta_away > ETA_MAX)))
    lam_home = np.exp(eta_home)
    lam_away = np.exp(eta_away)
    residual_home = design.weights * (lam_home - design.yh)
    residual_away = design.weights * (lam_away - design.ya)
    data = float(np.sum(design.weights * (lam_home - design.yh * eta_home + lam_away - design.ya * eta_away)))
    penalty = 0.5 * l2 * (
        home * home
        + float(np.dot(attack, attack))
        + float(np.dot(defence, defence))
        + float(np.dot(comp[1:], comp[1:]))
    )
    g_attack = np.bincount(design.home_ix, residual_home, minlength=design.n_teams)
    g_attack += np.bincount(design.away_ix, residual_away, minlength=design.n_teams)
    g_attack += l2 * attack
    g_defence = np.bincount(design.away_ix, residual_home, minlength=design.n_teams)
    g_defence += np.bincount(design.home_ix, residual_away, minlength=design.n_teams)
    g_defence += l2 * defence
    g_comp = np.bincount(design.comp_ix, residual_home + residual_away, minlength=design.n_comps)
    if design.n_comps > 1:
        g_comp[1:] += l2 * comp[1:]
    grad = np.empty(design.dim, dtype=np.float64)
    grad[0] = float(np.sum(residual_home) + np.sum(residual_away))
    grad[1] = float(np.sum(residual_home) + l2 * home)
    free = design.n_free_teams
    if free:
        grad[2 : 2 + free] = design.team_basis.T @ g_attack
        grad[2 + free : 2 + 2 * free] = design.team_basis.T @ g_defence
    if design.n_comps > 1:
        grad[2 + 2 * free :] = g_comp[1:]
    return data + penalty, grad, clip_hits


def _polish(design: _Design, l2: float, theta: np.ndarray, tol: float) -> tuple[np.ndarray, int]:
    """Coordinate Newton steps for gradients L-BFGS left above tol.

    L-BFGS-B stops when the objective change falls below a relative function
    tolerance. On the summed loss that can happen while one analytic derivative
    is still just above tol, because the matching step is smaller than a unit
    in the last place of the loss. A step is kept only when the loss does not
    increase.
    """
    current = np.array(theta, dtype=np.float64, copy=True)
    used = 0
    for sweep in range(1, 9):
        loss, grad, _hits = _evaluate(design, l2, current)
        hot = np.flatnonzero(np.abs(grad) > tol)
        if hot.size == 0:
            break
        moved = False
        for index in hot[np.argsort(-np.abs(grad[hot]))]:
            slope = float(grad[index])
            probe = 1e-6
            up = current.copy()
            up[index] += probe
            loss_up, _gradient, _hits = _evaluate(design, l2, up)
            curvature = 2.0 * ((loss_up - loss) - slope * probe) / probe**2
            if not math.isfinite(curvature) or curvature <= 1e-8:
                continue
            step = slope / curvature
            if abs(step) > 1e-3:
                continue
            trial = current.copy()
            trial[index] -= step
            trial_loss, _gradient, _hits = _evaluate(design, l2, trial)
            if trial_loss <= loss + 1e-12:
                current = trial
                loss = trial_loss
                moved = True
                loss, grad, _hits = _evaluate(design, l2, current)
        used = sweep
        if not moved:
            break
    return current, used


def initial_theta(matches: list[Match], cutoff: date, decay: float, kind: str = "mean_rate") -> np.ndarray:
    """Deterministic reduced-parameter starts. 'mean_rate' is the fit default."""
    design = _prepare(matches, cutoff, decay)
    theta = np.zeros(design.dim, dtype=np.float64)
    if kind == "zeros":
        return theta
    if kind == "mean_rate":
        theta[0] = design.mean_log_rate
        return theta
    if kind == "shifted":
        theta[0] = design.mean_log_rate
        theta[1] = 0.25
        free = design.n_free_teams
        for index in range(free):
            sign = 1.0 if index % 2 == 0 else -1.0
            theta[2 + index] = 0.05 * sign
            theta[2 + free + index] = -0.04 * sign
        return theta
    raise ValueError(f"unknown start {kind}")


def objective_and_gradient(
    matches: list[Match], cutoff: date, decay: float, l2: float, theta: np.ndarray
) -> tuple[float, np.ndarray]:
    """Loss and analytic reduced gradient at theta. Used by finite-difference checks."""
    loss, grad, _hits = _evaluate(_prepare(matches, cutoff, decay), l2, np.asarray(theta, dtype=np.float64))
    return loss, grad


def fit_poisson(
    matches: list[Match],
    cutoff: date,
    decay: float,
    l2: float,
    config: V1Config,
    x0: np.ndarray | None = None,
) -> PoissonFit:
    """Weighted penalised Poisson scoring, using only matches dated before cutoff."""
    design = _prepare(matches, cutoff, decay)
    start = initial_theta(matches, cutoff, decay, "mean_rate") if x0 is None else np.asarray(x0, dtype=np.float64)
    if start.shape != (design.dim,):
        raise ValueError(f"x0 has shape {start.shape}, expected {(design.dim,)}")
    last_step = 0.0
    previous: np.ndarray | None = None

    def fun(theta: np.ndarray) -> tuple[float, np.ndarray]:
        nonlocal last_step, previous
        current = np.asarray(theta, dtype=np.float64)
        if previous is not None:
            last_step = float(np.max(np.abs(current - previous)))
        previous = current.copy()
        loss, grad, _hits = _evaluate(design, l2, current)
        return loss, grad

    started = time.perf_counter()
    result = minimize(
        fun,
        start,
        method="L-BFGS-B",
        jac=True,
        options={"maxiter": config.max_iter, "gtol": config.tol, "ftol": 1e-16},
    )
    runtime = time.perf_counter() - started
    solution = np.asarray(result.x, dtype=np.float64)
    polish_sweeps = 0
    if result.success:
        solution, polish_sweeps = _polish(design, l2, solution, config.tol)
    loss, grad, clip_hits = _evaluate(design, l2, solution)
    grad_inf = float(np.max(np.abs(grad))) if grad.size else 0.0
    finite = math.isfinite(loss) and math.isfinite(grad_inf)
    converged = bool(result.success) and finite and grad_inf <= config.tol
    message = str(result.message)
    if polish_sweeps:
        message = f"{message}; coordinate polish sweeps={polish_sweeps}"
    intercept, home, attack, defence, comp = _unpack(design, solution)
    return PoissonFit(
        cutoff=cutoff,
        decay=decay,
        l2=l2,
        intercept=intercept,
        home_advantage=home,
        attack=dict(zip(design.teams, attack.tolist())),
        defence=dict(zip(design.teams, defence.tolist())),
        competition=dict(zip(design.competitions, comp.tolist())),
        reference_competition=design.competitions[0],
        team_counts=design.team_counts,
        team_competitions=design.team_comps,
        n_matches=int(design.home_ix.size),
        iterations=int(result.nit),
        converged=converged,
        max_abs_step=last_step,
        weights_sum=design.weight_sum,
        objective=loss,
        grad_inf=grad_inf,
        status=int(result.status),
        message=message,
        runtime_seconds=runtime,
        bound_hits=0,
        clip_hits=clip_hits,
        n_components=len(design.component_sizes),
        component_sizes=design.component_sizes,
        nfev=int(result.nfev),
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
    flags = competition_flags(
        home_comps,
        away_comps,
        fit.team_counts.get(home, 0),
        fit.team_counts.get(away, 0),
    )
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


def competition_flags(home_comps: set[str], away_comps: set[str], home_n: int, away_n: int) -> list[str]:
    """Separate 'no shared competition' from clubs whose domestic leagues differ.

    cross_league_strength means the two clubs have no competition in common in the fit.
    cross_domestic_league means each club has a domestic competition and those sets
    do not overlap. Sharing a European competition does not clear the domestic flag.
    """
    flags = []
    if home_n < LOW_HISTORY or away_n < LOW_HISTORY:
        flags.append("low_history")
    if not home_comps & away_comps:
        flags.append("cross_league_strength")
    home_domestic = home_comps - NON_DOMESTIC
    away_domestic = away_comps - NON_DOMESTIC
    if home_domestic and away_domestic and not (home_domestic & away_domestic):
        flags.append("cross_domestic_league")
    return flags


def pick_validation_candidate(entries: list[dict]) -> dict:
    """Use only candidates whose every validation month converged.

    A failed month makes the whole decay/L2 pair ineligible. Surviving months
    from that pair are not a selection score.
    """
    eligible = [entry for entry in entries if entry["fits_converged"] and entry["metrics"].get("n", 0)]
    if not eligible:
        raise ValueError("no validation candidate converged on every month")
    return min(eligible, key=lambda entry: entry["metrics"]["log_loss_1x2"])


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
                "grad_inf": fit.grad_inf,
                "fit_status": fit.status,
                "fit_message": fit.message,
                "objective": fit.objective,
                "fit_iterations": fit.iterations,
                "n_components": fit.n_components,
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
    candidates = []
    for decay in config.decays:
        for l2 in config.l2_grid:
            scored = _score_period(history, validation, decay, l2, config)
            compared = _comparable(scored)
            metrics = _metrics(compared, "v1")
            failed = _failed_fits(scored)
            entry = {
                "decay": decay,
                "l2": l2,
                "metrics": metrics,
                "rows": scored,
                "fits_converged": not failed and bool(scored),
            }
            candidates.append(entry)
            grid.append(
                {
                    "decay": decay,
                    "l2": l2,
                    "n": metrics.get("n", 0),
                    "log_loss_1x2": metrics.get("log_loss_1x2"),
                    "fits_converged": entry["fits_converged"],
                    "selection_eligible": entry["fits_converged"],
                    "max_grad_inf": max((row["grad_inf"] for row in scored), default=None),
                    "failed_fits": failed,
                }
            )
    best = pick_validation_candidate(candidates)
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
            "max_grad_inf": max(row["grad_inf"] for row in test_rows),
            "failed_fits": _failed_fits(test_rows),
        },
        "validation_rows": best["rows"],
        "test_rows": test_rows,
        "fit": final_fit,
    }


def _failed_fits(rows: list[dict]) -> list[dict]:
    seen: set[str] = set()
    failed = []
    for row in rows:
        if row["converged"] or row["cutoff"] in seen:
            continue
        seen.add(row["cutoff"])
        failed.append(
            {
                "cutoff": row["cutoff"],
                "status": row["fit_status"],
                "message": row["fit_message"],
                "grad_inf": row["grad_inf"],
                "objective": row["objective"],
                "iterations": row["fit_iterations"],
                "n_components": row["n_components"],
            }
        )
    return failed


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
        "converged",
        "grad_inf",
        "fit_status",
        "objective",
        "fit_iterations",
        "n_components",
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
        "nfev": fit.nfev,
        "converged": fit.converged,
        "status": fit.status,
        "message": fit.message,
        "objective": fit.objective,
        "grad_inf": fit.grad_inf,
        "max_abs_step": fit.max_abs_step,
        "runtime_seconds": fit.runtime_seconds,
        "bound_hits": fit.bound_hits,
        "prediction_guard_hits": fit.clip_hits,
        "training_loss_clipped": False,
        "n_components": fit.n_components,
        "component_sizes": list(fit.component_sizes),
        "mean_attack": sum(attacks) / len(attacks),
        "mean_defence": sum(defences) / len(defences),
        "objective_scale": "sum of weighted Poisson terms plus (l2/2) * squared parameters; not a mean",
        "l2_convention": "(l2/2) on home advantage, every attack, every defence, and non-reference competitions",
        "min_rate_guard": {"eta_min": ETA_MIN, "eta_max": ETA_MAX, "applied_in_training_loss": False},
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
        f"Fits converged: {test['fits_converged']}. Max gradient infinity norm: {test['max_grad_inf']}.",
        f"Failed fits: {json.dumps(test['failed_fits'])}.",
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
