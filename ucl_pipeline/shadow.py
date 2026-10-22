"""Local V0/V1 shadow predictions. Does not call Telegram."""

from __future__ import annotations

import csv
import hashlib
import json
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from ucl_pipeline import __version__
from ucl_pipeline.models import Match
from ucl_pipeline.poisson_v1 import (
    FROZEN_DECAY,
    FROZEN_L2,
    V1Config,
    _v0_by_fixture,
    eligible_matches,
    fit_poisson,
    predict_rates,
)
from ucl_pipeline.predict import _merge_fixtures, fixtures_for, load_prediction_matches
from ucl_pipeline.web_fixtures import hkjc_label, web_fixtures_on

MODEL_VERSION = f"poisson-v1/{__version__}/decay={FROZEN_DECAY}/l2={FROZEN_L2}"


def data_version(matches: list[Match], cutoff: date) -> dict:
    rows = [match for match in eligible_matches(matches) if match.date < cutoff]
    digest = hashlib.sha256()
    ordered = sorted(rows, key=lambda match: (match.date, match.competition, match.home_team, match.away_team))
    for match in ordered:
        digest.update(
            f"{match.date.isoformat()}|{match.competition}|{match.home_team}|{match.away_team}|"
            f"{match.home_goals}|{match.away_goals}\n".encode()
        )
    return {
        "sha256_12": digest.hexdigest()[:12],
        "n_matches": len(rows),
        "max_date": ordered[-1].date.isoformat() if ordered else None,
    }


def _blank(value: object) -> bool:
    return value in ("", None)


def _pct(value: object) -> str:
    return f"{float(value):.1%}"


def _lean(options: list[tuple[str, float]]) -> str:
    """Name the single highest probability. A tie stays unnamed."""
    best = max(value for _name, value in options)
    names = [name for name, value in options if value == best]
    if len(names) != 1:
        return "未分高低"
    return f"傾向{names[0]}"


def _market_lines(tag: str, row: dict, suffix: str) -> list[str]:
    """Spell out both sides. Over 2.5 below one half means the under is higher."""
    home = float(row[f"p_home_{suffix}"])
    draw = float(row[f"p_draw_{suffix}"])
    away = float(row[f"p_away_{suffix}"])
    over = float(row[f"p_over_{suffix}"])
    under = 1.0 - over
    btts = float(row[f"p_btts_{suffix}"])
    no_btts = 1.0 - btts
    note = "｜近況少" if suffix == "v1" and "low_history" in row.get("v1_flags", "") else ""
    return [
        f"{tag}{note}",
        (
            f"主勝 {_pct(home)}｜和 {_pct(draw)}｜客勝 {_pct(away)} → "
            f"{_lean([('主勝', home), ('和', draw), ('客勝', away)])}"
        ),
        f"大2.5 {_pct(over)}｜小2.5 {_pct(under)} → {_lean([('大', over), ('小', under)])}",
        f"雙方入球 {_pct(btts)}｜冇 {_pct(no_btts)} → {_lean([('有', btts), ('冇', no_btts)])}",
        f"預期入球 {float(row[f'home_xg_{suffix}']):.2f}-{float(row[f'away_xg_{suffix}']):.2f}",
    ]


def label_prediction(fixture: Match, v1: dict, v0_row: dict) -> dict:
    """Europa V1 is unvalidated. Unseen teams abstain. V0 is a labelled fallback."""
    experimental = fixture.competition == "UEFA Europa League"
    warnings = []
    if v1["abstain"]:
        if not _blank(v0_row.get("p_home")):
            role = "v0_fallback"
            warnings.append("v0_fallback")
        else:
            role = "abstain"
            warnings.append(v1.get("reason") or "unseen_team")
    else:
        role = "v1_experimental" if experimental else "v1"
        if experimental:
            warnings.append("experimental_europa_unvalidated")
            warnings.append("reference_competition_level")
    return {"role": role, "warnings": warnings}


def render_draft(rows: list[dict], meta: dict) -> str:
    """Traditional Chinese pre-match report. Not a result and not a Telegram send."""
    lines = [
        "賽前預測（未開波，不是賽果）",
        f"更新時間：{meta['updated_at_hkt']}",
        f"預測截止：{meta['prediction_cutoff']}（當日及之後的比分不入模）",
        f"資料版本：{meta['data_version']['sha256_12']}，最後有比分日期 {meta['data_version']['max_date']}",
        "V1 凍結 decay=0.0015、L2=4。歐霸沒有用來選參數，V1 標明實驗。",
        "歐霸評分水平用訓練參考聯賽，不是歐霸自己的入球水平。",
        "隊名用馬會 FB 場次譯名。",
        "讀法：1X2 的傾向係主勝、和、客勝入面最高，可以低過 50%。大2.5＝總入球 3 球或以上，小2.5＝2 球或以下；大低過 50% 就係傾向小。雙方入球＝兩隊都有入球。",
        meta["source_summary"],
        "",
    ]
    for row in rows:
        looked_code, looked_home, looked_away = hkjc_label(row["home_team"], row["away_team"])
        code = row.get("hkjc_code") or looked_code
        home = row.get("home_zh") or looked_home or row["home_team"]
        away = row.get("away_zh") or looked_away or row["away_team"]
        prefix = f"{code} " if code else ""
        lines.append(f"{row['kickoff']} {prefix}{home} vs {away}")
        if row["role"] == "abstain":
            lines.append("無法預測（未知球隊）")
        elif row["role"] == "v0_fallback":
            lines.extend(_market_lines("V1 無法使用。V0後備", row, "v0"))
        else:
            label = "V1實驗" if row["role"] == "v1_experimental" else "V1"
            lines.extend(_market_lines(label, row, "v1"))
        lines.append("")
    lines.append("警告：2026-09-20 之後的聯賽比分齊全度未知。未知球隊不預測。歐霸 V1 未經驗證。")
    return "\n".join(lines).strip() + "\n"


def split_draft(text: str, limit: int = 3500) -> list[str]:
    if len(text) <= limit:
        return [text]
    parts: list[str] = []
    current: list[str] = []
    size = 0
    for block in text.split("\n\n"):
        piece = block.strip()
        if not piece:
            continue
        addition = len(piece) + 2
        if current and size + addition > limit:
            parts.append("\n\n".join(current) + "\n")
            current = [piece]
            size = addition
        else:
            current.append(piece)
            size += addition
    if current:
        parts.append("\n\n".join(current) + "\n")
    return parts


def shadow_rows(history: list[Match], fixtures: list[Match], on: date) -> tuple[dict, list[dict]]:
    """Refit frozen V1 on matches dated before `on`. Same-day rows stay out."""
    version = data_version(history, on)
    fit = fit_poisson(history, on, FROZEN_DECAY, FROZEN_L2, V1Config())
    v0 = _v0_by_fixture(history, fixtures) if fixtures else {}
    rows = []
    for fixture in fixtures:
        v0_row = v0[(fixture.date, fixture.home_team, fixture.away_team)]
        v1 = predict_rates(fit, fixture.home_team, fixture.away_team, fixture.competition)
        labelled = label_prediction(fixture, v1, v0_row)
        code, home_zh, away_zh = hkjc_label(fixture.home_team, fixture.away_team)
        row = {
            "date": fixture.date.isoformat(),
            "kickoff": fixture.kickoff,
            "competition": fixture.competition,
            "role": labelled["role"],
            "warnings": ",".join(labelled["warnings"]),
            "hkjc_code": code,
            "home_zh": home_zh,
            "away_zh": away_zh,
            "home_team": fixture.home_team,
            "away_team": fixture.away_team,
            "model_version": MODEL_VERSION,
            "data_version": version["sha256_12"],
            "fit_cutoff": on.isoformat(),
            "fit_converged": int(fit.converged),
            "grad_inf": fit.grad_inf,
            "v1_flags": ",".join(v1.get("flags", [])),
            "v1_reason": v1.get("reason", ""),
            "home_xg_v0": v0_row.get("home_xg", ""),
            "away_xg_v0": v0_row.get("away_xg", ""),
            "p_home_v0": v0_row.get("p_home", ""),
            "p_draw_v0": v0_row.get("p_draw", ""),
            "p_away_v0": v0_row.get("p_away", ""),
            "p_over_v0": v0_row.get("p_over_25", ""),
            "p_btts_v0": v0_row.get("p_btts", ""),
            "home_xg_v1": "" if v1["abstain"] else v1["home_xg"],
            "away_xg_v1": "" if v1["abstain"] else v1["away_xg"],
            "p_home_v1": "" if v1["abstain"] else v1["p_home"],
            "p_draw_v1": "" if v1["abstain"] else v1["p_draw"],
            "p_away_v1": "" if v1["abstain"] else v1["p_away"],
            "p_over_v1": "" if v1["abstain"] else v1["p_over_25"],
            "p_btts_v1": "" if v1["abstain"] else v1["p_btts"],
        }
        rows.append(row)
    meta = {
        "model_version": MODEL_VERSION,
        "frozen_decay": FROZEN_DECAY,
        "frozen_l2": FROZEN_L2,
        "selection": "2024-25 validation 1X2 log loss; 2025-26 was not used to choose decay or L2",
        "prediction_cutoff": on.isoformat(),
        "data_version": version,
        "fit": {
            "cutoff": fit.cutoff.isoformat(),
            "converged": fit.converged,
            "status": fit.status,
            "message": fit.message,
            "iterations": fit.iterations,
            "objective": fit.objective,
            "grad_inf": fit.grad_inf,
            "runtime_seconds": fit.runtime_seconds,
            "n_matches": fit.n_matches,
            "n_components": fit.n_components,
            "bound_hits": fit.bound_hits,
            "prediction_guard_hits": fit.clip_hits,
        },
        "telegram": False,
    }
    return meta, rows


def write_shadow(
    history: list[Match],
    fixtures: list[Match],
    on: date,
    output_dir: Path,
    stamp: str | None = None,
    source_summary: str = "",
    chat_id: str = "",
    updated_at_hkt: str = "",
    teams: list[dict] | None = None,
) -> Path:
    meta, rows = shadow_rows(history, fixtures, on)
    stamp = stamp or datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    meta["source_summary"] = source_summary
    meta["updated_at_hkt"] = updated_at_hkt or stamp
    meta["teams"] = teams or []
    folder = output_dir / "shadow" / stamp
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "fit.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
    draft = render_draft(rows, meta) if rows else ""
    parts = split_draft(draft) if draft else []
    (folder / "draft.txt").write_text(draft, encoding="utf-8")
    run_id = f"shadow-{on.isoformat()}-{meta['data_version']['sha256_12']}-d{FROZEN_DECAY}-l{FROZEN_L2}"
    (folder / "send.json").write_text(
        json.dumps(
            {
                "run_id": run_id,
                "status": "pending_approval",
                "chat_id": chat_id,
                "sent": False,
                "message_ids": [],
                "part_count": len(parts),
                "parts": parts,
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    fields = list(rows[0]) if rows else [
        "date", "competition", "home_team", "away_team", "model_version", "data_version",
        "fit_cutoff", "fit_converged", "grad_inf", "v1_flags", "v1_reason",
    ]
    with (folder / "predictions.csv").open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        writer.writerows(rows)
    return folder


def run_shadow(cache_dir: Path, output_dir: Path, on: date, *, refresh: bool = False, chat_id: str = "") -> Path:
    from ucl_pipeline.sources import CL_API, _dir_names, load_football_json

    source_notes: list[dict] = []
    refreshed = load_football_json(cache_dir, refresh, source_notes, seasons=("2026-27",), keep_unplayed=True)
    cl_status, _cl_names = _dir_names(CL_API.format(season="2026-27"), cache_dir, refresh)
    history, unplayed, _notes = load_prediction_matches(cache_dir, refresh=False)
    web = web_fixtures_on(on)
    fixtures = _merge_fixtures(fixtures_for(unplayed, on), web)
    order = {(match.home_team, match.away_team): index for index, match in enumerate(web)}
    fixtures.sort(key=lambda match: (match.kickoff, order.get((match.home_team, match.away_team), 999)))
    played = [match for match in refreshed if match.goals_pair()]
    last_scored = max((match.date for match in played), default=None)
    files = [note for note in source_notes if note.get("files_used") is not None]
    errors = [note for note in source_notes if note.get("status") not in (None, 200)]
    summary = (
        f"football.json 2026-27 重新下載後最後有比分 {last_scored.isoformat() if last_scored else '無'}。"
        f"檔案 {', '.join(files[0]['files_used']) if files else '無'}。"
        f"歐冠 2026-27 目錄 {cl_status}。之後賽果齊全度未知。"
    )
    if errors:
        summary += " 下載錯誤：" + ", ".join(f"{note.get('status')} {note.get('url')}" for note in errors)
    gap = [
        match
        for match in refreshed
        if match.goals_pair() is None and last_scored is not None and last_scored < match.date < on
    ]
    summary += f" 截止前未填比分場數 {len(gap)}。"
    teams = _team_latest(history, fixtures, on)
    updated = datetime.now(timezone(timedelta(hours=8))).strftime("%Y-%m-%d %H:%M 香港時間")
    return write_shadow(
        history,
        fixtures,
        on,
        output_dir,
        source_summary=summary,
        chat_id=chat_id,
        updated_at_hkt=updated,
        teams=teams,
    )


def _team_latest(history: list[Match], fixtures: list[Match], cutoff: date) -> list[dict]:
    wanted: list[str] = []
    for fixture in fixtures:
        for team in (fixture.home_team, fixture.away_team):
            if team not in wanted:
                wanted.append(team)
    played = [match for match in eligible_matches(history) if match.date < cutoff]
    rows = []
    for team in wanted:
        dates = [match.date for match in played if match.home_team == team or match.away_team == team]
        rows.append(
            {
                "team": team,
                "latest_scored": max(dates).isoformat() if dates else None,
                "n_before_cutoff": len(dates),
                "completeness": "unknown",
            }
        )
    return rows
