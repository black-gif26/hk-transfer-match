/** Pure helpers shared by the UI and frontend unit tests. */

export function parseRouteValue(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export function parseStopValue(raw) {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    if (v && v.stopId) return { stopId: String(v.stopId), seq: Number(v.seq) };
  } catch {
    return { stopId: String(raw), seq: null };
  }
  return null;
}

export function sameRoute(a, b) {
  if (!a || !b) return false;
  return (
    a.co === b.co &&
    a.route === b.route &&
    a.bound === b.bound &&
    String(a.serviceType) === String(b.serviceType)
  );
}

export function canShowConfirmedJourney(c, plan) {
  return !!(
    c &&
    plan &&
    c.board1Eta &&
    c.timingStatus === "eta_matched" &&
    c.leg1Eta &&
    c.leg2Eta &&
    plan.board1TimingStatus === "ok"
  );
}

/**
 * Generation-token gate: only apply if the response still matches the stream's current gen
 * and the snapshotted inputs equal the current inputs.
 */
export function shouldApplyResponse(gen, currentGen, snap, current) {
  if (gen !== currentGen) return false;
  if (!snap || !current) return false;
  if (snap.boardingMode != null && snap.boardingMode !== current.boardingMode) {
    return false;
  }
  if (snap.origin && current.origin) {
    if (snap.origin.lat !== current.origin.lat || snap.origin.long !== current.origin.long) {
      return false;
    }
  } else if (!!snap.origin !== !!current.origin) {
    return false;
  }
  if (snap.boardStopId !== current.boardStopId || snap.boardStopSeq !== current.boardStopSeq) {
    return false;
  }
  if (snap.minutesToBoardStop !== current.minutesToBoardStop) {
    return false;
  }
  if (!sameRoute(snap.leg1, current.leg1)) return false;
  if (!sameRoute(snap.leg2, current.leg2)) return false;
  if (snap.mode != null && snap.mode !== current.mode) return false;
  if (
    Object.prototype.hasOwnProperty.call(snap, "preferredBoard1Eta") &&
    snap.preferredBoard1Eta !== current.preferredBoard1Eta
  ) {
    return false;
  }
  return true;
}

/** Rapid candidate selection: ignore responses for a different selected index. */
export function shouldApplyCandidateResponse(gen, currentGen, requestIndex, selectedIndex) {
  return gen === currentGen && requestIndex === selectedIndex;
}

export const TIMING_LABEL = {
  eta_matched: "時間兼容（估算）",
  awaiting_board1_eta: "待上車時間",
  awaiting_leg1_eta: "待落車時間",
  awaiting_leg2_eta: "待第二程班次",
  outside_visible_eta: "可見班次未配對",
  no_catchable_board1: "趕唔切第一程",
  manual_uncatchable: "揀咗趕唔切班次",
  preferred_gone: "班次已消失",
  catchability_unverified: "到站時間未核實",
  upstream_error: "資料暫時無法讀取",
};

export const GEO_FAIL_HINT =
  "暫時未能取得位置，你可以自行選擇第一程上車站繼續。";

/** Pure canPlan rule used by UI and tests. */
export function canPlanWith(inputs) {
  const hasRoutes = !!(inputs.leg1 && inputs.leg2);
  if (!hasRoutes) return false;
  if (inputs.boardingMode === "manual_stop") {
    return !!(inputs.boardStopId && inputs.boardStopSeq != null);
  }
  return !!inputs.origin;
}

export function geoErrorMessage(err, opts = {}) {
  const secure = opts.isSecureContext !== false;
  if (!opts.geolocationAvailable) {
    return `${GEO_FAIL_HINT}（呢部機唔支援定位）`;
  }
  if (!secure) {
    return `${GEO_FAIL_HINT}（需要 HTTPS 先可以用定位）`;
  }
  if (!err) return GEO_FAIL_HINT;
  if (err.code === 1) return `未授權定位。${GEO_FAIL_HINT}`;
  if (err.code === 2) return `暫時拎唔到位置。${GEO_FAIL_HINT}`;
  if (err.code === 3) return `定位逾時。${GEO_FAIL_HINT}`;
  return `${GEO_FAIL_HINT}${err.message ? `（${err.message}）` : ""}`;
}

/** Escape is unnecessary when using textContent; this documents the safe policy. */
export function textOnly(value) {
  return value == null ? "" : String(value);
}
