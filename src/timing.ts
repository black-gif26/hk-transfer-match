/** Explicit timing states: unknown ≠ infeasible. */
export type TimingStatus =
  | "eta_matched"
  | "awaiting_board1_eta"
  | "awaiting_leg1_eta"
  | "awaiting_leg2_eta"
  | "outside_visible_eta"
  | "no_catchable_board1"
  | "manual_uncatchable"
  | "preferred_gone"
  | "catchability_unverified"
  | "upstream_error";

/** Open ETA feeds do not expose stable trip/vehicle IDs across stops. */
export type TimingConfidence = "estimated_unverified" | "none";

export type Board1TimingStatus =
  | "ok"
  | "awaiting_board1_eta"
  | "no_catchable_board1"
  | "manual_uncatchable"
  | "preferred_gone"
  | "catchability_unverified"
  | "upstream_error";

export const TIMING_STATUS_TC: Record<TimingStatus, string> = {
  eta_matched: "可見班次時間兼容（估算，未核實同一架車）",
  awaiting_board1_eta: "已找到轉車站，第一程上車時間待更新",
  awaiting_leg1_eta: "已找到轉車站，第一程落車時間待更新",
  awaiting_leg2_eta: "可喺此轉車，第二程班次待更新",
  outside_visible_eta: "目前可見班次未能配對，稍後再查",
  no_catchable_board1: "目前可見第一程班次未能趕上，請更新班次",
  manual_uncatchable: "你揀嘅班次可能趕唔切上車站，請改揀或更新",
  preferred_gone: "你揀嘅班次已唔喺可見列表，請重新揀",
  catchability_unverified: "已找到轉車站，到上車站時間未核實（唔當 0 分）",
  upstream_error: "班次資料暫時無法讀取",
};

export const BOARD1_TIMING_TC: Record<Board1TimingStatus, string> = {
  ok: "已選定第一程上車時間",
  awaiting_board1_eta: "第一程上車時間待更新",
  no_catchable_board1: "目前可見第一程班次未能趕上，請更新班次",
  manual_uncatchable: "你揀嘅班次可能趕唔切上車站",
  preferred_gone: "你揀嘅班次已唔喺可見列表",
  catchability_unverified: "未填到上車站時間，趕得切與否未核實",
  upstream_error: "班次資料暫時無法讀取",
};

export const WALK_CAVEAT_TC =
  "轉車距離為直線估算，唔代表實際可行人路（可能隔馬路／欄杆）。";

export const CONTINUITY_CAVEAT_TC =
  "公開 ETA 未提供跨站車輛識別；落車時間係按可見班次估算，唔保證同一架車。";

/** Narrow compatibility flag: only true when visible times are compatible. */
export function hasEtaMatch(status: TimingStatus): boolean {
  return status === "eta_matched";
}
