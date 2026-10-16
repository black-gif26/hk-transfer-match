import {
  distanceMeters,
  estimateWalkMinutes,
  listEtas,
  listRouteStops,
  stopOccurrenceKey,
  type Bound,
  type Company,
  type EtaItem,
  type StopInfo,
  UpstreamError,
  UpstreamSchemaError,
} from "./hk-transit";
import { matchTransfer } from "./transfer";
import {
  BOARD1_TIMING_TC,
  CONTINUITY_CAVEAT_TC,
  TIMING_STATUS_TC,
  WALK_CAVEAT_TC,
  hasEtaMatch,
  type Board1TimingStatus,
  type TimingConfidence,
  type TimingStatus,
} from "./timing";
import { ValidationError } from "./validate";

export type PlanMode = "shortest_walk" | "fastest" | "manual";

export type BoardingMode = "location" | "manual_stop";

export interface RouteRef {
  co: Company;
  route: string;
  bound: Bound;
  serviceType: string;
}

/** Location-based or explicit first-leg boarding stop. */
export interface BoardingInput {
  mode: BoardingMode;
  origin?: { lat: number; long: number } | null;
  boardStopId?: string | null;
  boardStopSeq?: number | null;
  /** Minutes until user reaches the boarding stop (manual mode). Null ⇒ catchability unverified. */
  minutesToBoardStop?: number | null;
}

export interface PhysicalPair {
  alight1: StopInfo;
  board2: StopInfo;
  walkMeters: number;
  walkMinutes: number;
}

export interface TransferCandidate {
  alight1: StopInfo;
  board2: StopInfo;
  walkMeters: number;
  walkMinutes: number;
  walkNoteTc: string;
  timingStatus: TimingStatus;
  timingStatusTc: string;
  timingConfidence: TimingConfidence;
  timingNoteTc: string;
  /** Narrow: true only when timingStatus === "eta_matched". Not physical feasibility. */
  hasMatch: boolean;
  waitMinutes: number | null;
  gapMinutes: number | null;
  board1Eta: string | null;
  leg1Eta: string | null;
  leg2Eta: string | null;
  readyAt: string | null;
  board2InMinutes: number | null;
  scoreTc: string;
  evaluatedAt: string;
  stale: boolean;
}

export interface Board1Departure {
  eta: string;
  etaSeq: number;
  destTc: string;
  /** null when catchability cannot be verified (unknown time-to-stop). */
  catchable: boolean | null;
  inMinutes: number;
  labelTc: string;
}

export interface Board1Context {
  board1: StopInfo & {
    metersFromOrigin: number | null;
    walkMinutesFromOrigin: number | null;
    boardEta: string | null;
    boardingMode: BoardingMode;
    minutesToBoardStop: number | null;
    catchabilityVerified: boolean;
  };
  board1Departures: Board1Departure[];
  board1EtaSource: "auto" | "manual" | "none";
  board1TimingStatus: Board1TimingStatus;
  board1TimingStatusTc: string;
}

export interface TransferPlanResult {
  mode: PlanMode;
  board1: Board1Context["board1"];
  board1Departures: Board1Departure[];
  board1EtaSource: Board1Context["board1EtaSource"];
  board1TimingStatus: Board1TimingStatus;
  board1TimingStatusTc: string;
  candidates: TransferCandidate[];
  summaryTc: string;
  searchTruncated: boolean;
  searchNoteTc: string | null;
  generatedAt: string;
}

function parseEtaMs(iso: string): number {
  return new Date(iso).getTime();
}

function fmtHkHm(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString("zh-HK", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Hong_Kong",
  });
}

function minutesFromNow(iso: string | null, nowMs: number): number | null {
  if (!iso) return null;
  const ms = parseEtaMs(iso);
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Math.round((ms - nowMs) / 60_000));
}

function pickNearestStop(origin: { lat: number; long: number }, stops: StopInfo[]): StopInfo | null {
  let best: StopInfo | null = null;
  let bestD = Infinity;
  for (const s of stops) {
    if (!s.hasValidCoord) continue;
    const d = distanceMeters(origin, s);
    if (!Number.isFinite(d)) continue;
    if (d < bestD) {
      bestD = d;
      best = s;
    }
  }
  return best;
}

/** First ETA you can catch after walking from origin (+ buffer). */
export function pickCatchableEta(etas: EtaItem[], readyMs: number): EtaItem | null {
  const sorted = [...etas].sort((a, b) => a.eta.localeCompare(b.eta));
  return sorted.find((e) => parseEtaMs(e.eta) >= readyMs) ?? null;
}

export function buildBoard1Departures(
  etas: EtaItem[],
  readyMs: number | null,
  nowMs: number,
): Board1Departure[] {
  return [...etas]
    .filter((e) => !!e.eta)
    .sort((a, b) => a.eta.localeCompare(b.eta))
    .map((e) => {
      const inMinutes = minutesFromNow(e.eta, nowMs) ?? 0;
      const catchable =
        readyMs == null ? null : parseEtaMs(e.eta) >= readyMs;
      const catchLabel =
        catchable == null ? " · 趕得切未核實" : catchable ? " · 趕得切" : " · 可能趕唔切";
      return {
        eta: e.eta,
        etaSeq: e.etaSeq,
        destTc: e.destTc,
        catchable,
        inMinutes,
        labelTc: `${fmtHkHm(e.eta)}（${inMinutes} 分後）${catchLabel}${e.destTc ? ` → ${e.destTc}` : ""}`,
      };
    });
}

/** Resolve a route-stop occurrence; requires seq when the same stopId repeats. */
export function findStopOccurrence(
  stops: StopInfo[],
  stopId: string,
  seq?: number | null,
): StopInfo | null {
  if (seq != null && Number.isFinite(seq)) {
    return stops.find((s) => s.stopId === stopId && s.seq === seq) ?? null;
  }
  const matches = stops.filter((s) => s.stopId === stopId);
  if (matches.length === 1) return matches[0];
  return null;
}

function normalizeBoardingInput(
  params: { boarding?: BoardingInput; origin?: { lat: number; long: number } },
): BoardingInput {
  if (params.boarding) return params.boarding;
  if (params.origin) {
    return { mode: "location", origin: params.origin };
  }
  throw new Error("需要 boarding 或 origin");
}

export async function resolveBoard1Context(params: {
  boarding?: BoardingInput;
  /** @deprecated Prefer boarding.mode === "location". Kept for callers/tests. */
  origin?: { lat: number; long: number };
  leg1: RouteRef;
  bufferMinutes?: number;
  preferredBoard1Eta?: string | null;
  /** Fixed request-time reference so slow requests do not treat stale "now" as current. */
  nowMs?: number;
}): Promise<Board1Context & { stops1: StopInfo[] }> {
  const bufferMinutes = Math.max(0, params.bufferMinutes ?? 1);
  const nowMs = params.nowMs ?? Date.now();
  const boarding = normalizeBoardingInput(params);

  const stops1 = await listRouteStops(
    params.leg1.co,
    params.leg1.route,
    params.leg1.bound,
    params.leg1.serviceType,
  );
  if (!stops1.length) throw new Error("第一程未有車站資料");

  let boardStop: StopInfo;
  let metersFromOrigin: number | null = null;
  let walkMinutesFromOrigin: number | null = null;
  let minutesToBoardStop: number | null = null;
  let catchabilityVerified = false;

  if (boarding.mode === "location") {
    const origin = boarding.origin;
    if (!origin) throw new Error("定位模式需要出發地座標");
    const nearest = pickNearestStop(origin, stops1);
    if (!nearest) {
      throw new Error("第一程上車站座標無效，無法估算步行時間");
    }
    boardStop = nearest;
    const meters = distanceMeters(origin, nearest);
    metersFromOrigin = Math.round(meters);
    walkMinutesFromOrigin = Math.max(1, Math.ceil(metersFromOrigin / ((4.5 * 1000) / 60)));
    minutesToBoardStop = walkMinutesFromOrigin;
    catchabilityVerified = true;
  } else {
    const stopId = boarding.boardStopId?.trim();
    if (!stopId) throw new Error("人手模式需要第一程上車站");
    const found = findStopOccurrence(stops1, stopId, boarding.boardStopSeq);
    if (!found) {
      throw new ValidationError("上車站唔屬於所選路線／方向／班次");
    }
    boardStop = found;
    if (
      boarding.minutesToBoardStop != null &&
      Number.isFinite(boarding.minutesToBoardStop) &&
      boarding.minutesToBoardStop >= 0
    ) {
      minutesToBoardStop = boarding.minutesToBoardStop;
      catchabilityVerified = true;
      // Do not fabricate origin coordinates or origin-walking estimates.
      metersFromOrigin = null;
      walkMinutesFromOrigin = null;
    } else {
      minutesToBoardStop = null;
      catchabilityVerified = false;
      metersFromOrigin = null;
      walkMinutesFromOrigin = null;
    }
  }

  let board1Etas: EtaItem[] = [];
  let upstreamError = false;
  try {
    board1Etas = await listEtas(
      params.leg1.co,
      params.leg1.route,
      boardStop.stopId,
      params.leg1.serviceType,
      { bound: params.leg1.bound, stopSeq: boardStop.seq },
    );
  } catch (err) {
    if (err instanceof UpstreamError || err instanceof UpstreamSchemaError) {
      upstreamError = true;
    } else {
      throw err;
    }
  }

  const readyAtBoard1Ms =
    catchabilityVerified && minutesToBoardStop != null
      ? nowMs + (minutesToBoardStop + bufferMinutes) * 60_000
      : null;
  const departures = buildBoard1Departures(board1Etas, readyAtBoard1Ms, nowMs);
  const preferred = params.preferredBoard1Eta?.trim() || null;

  let board1Eta: string | null = null;
  let board1EtaSource: Board1Context["board1EtaSource"] = "none";
  let board1TimingStatus: Board1TimingStatus;

  if (upstreamError) {
    board1TimingStatus = "upstream_error";
  } else if (!catchabilityVerified) {
    // Unknown time-to-boarding must not be treated as zero.
    if (preferred) {
      const preferredHit = departures.find((d) => d.eta === preferred) ?? null;
      if (!preferredHit) {
        board1TimingStatus = "preferred_gone";
        board1EtaSource = "manual";
        board1Eta = null;
      } else {
        board1TimingStatus = "catchability_unverified";
        board1EtaSource = "manual";
        board1Eta = preferredHit.eta;
      }
    } else if (!board1Etas.length) {
      board1TimingStatus = "awaiting_board1_eta";
      board1EtaSource = "none";
      board1Eta = null;
    } else {
      board1TimingStatus = "catchability_unverified";
      board1EtaSource = "none";
      board1Eta = null;
    }
  } else if (preferred) {
    const preferredHit = departures.find((d) => d.eta === preferred) ?? null;
    if (!preferredHit) {
      board1TimingStatus = "preferred_gone";
      board1EtaSource = "manual";
      board1Eta = null;
    } else if (preferredHit.catchable === false) {
      board1TimingStatus = "manual_uncatchable";
      board1EtaSource = "manual";
      board1Eta = preferredHit.eta;
    } else {
      board1TimingStatus = "ok";
      board1EtaSource = "manual";
      board1Eta = preferredHit.eta;
    }
  } else {
    const auto =
      readyAtBoard1Ms != null ? pickCatchableEta(board1Etas, readyAtBoard1Ms) : null;
    if (auto) {
      board1TimingStatus = "ok";
      board1EtaSource = "auto";
      board1Eta = auto.eta;
    } else if (!board1Etas.length) {
      board1TimingStatus = "awaiting_board1_eta";
      board1EtaSource = "none";
      board1Eta = null;
    } else {
      board1TimingStatus = "no_catchable_board1";
      board1EtaSource = "none";
      board1Eta = null;
    }
  }

  return {
    stops1,
    board1Departures: departures,
    board1EtaSource,
    board1TimingStatus,
    board1TimingStatusTc: BOARD1_TIMING_TC[board1TimingStatus],
    board1: {
      ...boardStop,
      metersFromOrigin,
      walkMinutesFromOrigin,
      boardEta: board1Eta,
      boardingMode: boarding.mode,
      minutesToBoardStop,
      catchabilityVerified,
    },
  };
}

/**
 * Build physical transfer pairs within walking distance.
 * Dedupes by stop occurrence (stopId#seq), not stopId alone.
 * For shortest_walk shortlist: keep nearest board2 per alight occurrence.
 * For fastest/manual evaluation: keep alternatives (capped) so non-nearest can win on time.
 */
export function buildPairs(
  stops1: StopInfo[],
  stops2: StopInfo[],
  board1Seq: number,
  maxTransferMeters: number,
  mode: PlanMode,
): PhysicalPair[] {
  const pairs: PhysicalPair[] = [];

  for (const a of stops1) {
    if (a.seq <= board1Seq) continue;
    if (!a.hasValidCoord) continue;
    for (const b of stops2) {
      if (!b.hasValidCoord) continue;
      const meters = distanceMeters(a, b);
      if (!Number.isFinite(meters) || meters > maxTransferMeters) continue;
      const walkMinutes = estimateWalkMinutes(a, b);
      if (!Number.isFinite(walkMinutes)) continue;
      pairs.push({
        alight1: a,
        board2: b,
        walkMeters: Math.round(meters),
        walkMinutes,
      });
    }
  }

  pairs.sort((x, y) => {
    if (x.walkMeters !== y.walkMeters) return x.walkMeters - y.walkMeters;
    const ak = stopOccurrenceKey(x.alight1);
    const bk = stopOccurrenceKey(y.alight1);
    if (ak !== bk) return ak.localeCompare(bk);
    return stopOccurrenceKey(x.board2).localeCompare(stopOccurrenceKey(y.board2));
  });

  if (mode === "shortest_walk") {
    const bestByAlight = new Map<string, PhysicalPair>();
    for (const p of pairs) {
      const key = stopOccurrenceKey(p.alight1);
      const prev = bestByAlight.get(key);
      if (!prev || p.walkMeters < prev.walkMeters) bestByAlight.set(key, p);
    }
    return [...bestByAlight.values()].sort((x, y) => x.walkMeters - y.walkMeters);
  }

  // fastest / manual: preserve alternative board2 stops; dedupe exact occurrence pairs.
  const seen = new Set<string>();
  const unique: PhysicalPair[] = [];
  for (const p of pairs) {
    const key = `${stopOccurrenceKey(p.alight1)}>${stopOccurrenceKey(p.board2)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(p);
  }
  return unique;
}

function isChronological(board1Eta: string | null, leg1Eta: string, leg2Eta: string): boolean {
  if (!board1Eta) return parseEtaMs(leg1Eta) < parseEtaMs(leg2Eta);
  return (
    parseEtaMs(board1Eta) < parseEtaMs(leg1Eta) && parseEtaMs(leg1Eta) < parseEtaMs(leg2Eta)
  );
}

function baseCandidate(
  pair: PhysicalPair,
  board1Eta: string | null,
  timingStatus: TimingStatus,
  extras: Partial<TransferCandidate> & { scoreTc: string; timingNoteTc: string },
  nowMs: number,
): TransferCandidate {
  return {
    alight1: pair.alight1,
    board2: pair.board2,
    walkMeters: pair.walkMeters,
    walkMinutes: pair.walkMinutes,
    walkNoteTc: WALK_CAVEAT_TC,
    timingStatus,
    timingStatusTc: TIMING_STATUS_TC[timingStatus],
    timingConfidence: extras.timingConfidence ?? "none",
    timingNoteTc: extras.timingNoteTc,
    hasMatch: hasEtaMatch(timingStatus),
    waitMinutes: extras.waitMinutes ?? null,
    gapMinutes: extras.gapMinutes ?? null,
    board1Eta,
    leg1Eta: extras.leg1Eta ?? null,
    leg2Eta: extras.leg2Eta ?? null,
    readyAt: extras.readyAt ?? null,
    board2InMinutes: extras.board2InMinutes ?? null,
    scoreTc: extras.scoreTc,
    evaluatedAt: new Date(nowMs).toISOString(),
    stale: false,
  };
}

/**
 * Soft earliest-alight filter when open ETA has no trip id.
 * Documented heuristic only — never proves vehicle continuity.
 */
export function earliestAlightMsHeuristic(
  board1Eta: string | null,
  board1Seq: number,
  alightSeq: number,
  nowMs: number,
): { earliestMs: number; noteTc: string } {
  const stopGap = Math.max(1, alightSeq - board1Seq);
  const minRideMinutes = Math.max(3, Math.round(stopGap * 1.8));
  const earliestMs = board1Eta
    ? parseEtaMs(board1Eta) + minRideMinutes * 60_000
    : nowMs;
  return {
    earliestMs,
    noteTc: `${CONTINUITY_CAVEAT_TC}（啟發式最少行車約 ${minRideMinutes} 分，非保證。）`,
  };
}

async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, Math.max(1, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function scoreCandidate(params: {
  leg1: RouteRef;
  leg2: RouteRef;
  pair: PhysicalPair;
  bufferMinutes: number;
  board1: StopInfo;
  board1Eta: string | null;
  board1TimingStatus: Board1TimingStatus;
  nowMs: number;
}): Promise<TransferCandidate> {
  const { leg1, leg2, pair, bufferMinutes, board1, board1Eta, board1TimingStatus, nowMs } = params;

  const walkLabel = `轉車步行約 ${pair.walkMeters}m（直線）`;

  if (board1TimingStatus === "upstream_error") {
    return baseCandidate(
      pair,
      null,
      "upstream_error",
      {
        scoreTc: `${walkLabel} · ${TIMING_STATUS_TC.upstream_error}`,
        timingNoteTc: TIMING_STATUS_TC.upstream_error,
      },
      nowMs,
    );
  }

  if (board1TimingStatus === "preferred_gone") {
    return baseCandidate(
      pair,
      null,
      "preferred_gone",
      {
        scoreTc: `${walkLabel} · ${TIMING_STATUS_TC.preferred_gone}`,
        timingNoteTc: TIMING_STATUS_TC.preferred_gone,
      },
      nowMs,
    );
  }

  if (board1TimingStatus === "manual_uncatchable") {
    return baseCandidate(
      pair,
      board1Eta,
      "manual_uncatchable",
      {
        scoreTc: `${walkLabel} · ${TIMING_STATUS_TC.manual_uncatchable}`,
        timingNoteTc: TIMING_STATUS_TC.manual_uncatchable,
        board1Eta,
      },
      nowMs,
    );
  }

  if (board1TimingStatus === "no_catchable_board1") {
    return baseCandidate(
      pair,
      null,
      "no_catchable_board1",
      {
        scoreTc: `${walkLabel} · ${TIMING_STATUS_TC.no_catchable_board1}`,
        timingNoteTc: TIMING_STATUS_TC.no_catchable_board1,
      },
      nowMs,
    );
  }

  if (board1TimingStatus === "catchability_unverified" && !board1Eta) {
    return baseCandidate(
      pair,
      null,
      "catchability_unverified",
      {
        scoreTc: `${walkLabel} · ${TIMING_STATUS_TC.catchability_unverified}`,
        timingNoteTc: TIMING_STATUS_TC.catchability_unverified,
      },
      nowMs,
    );
  }

  if (board1TimingStatus === "awaiting_board1_eta" || !board1Eta) {
    return baseCandidate(
      pair,
      null,
      board1TimingStatus === "catchability_unverified"
        ? "catchability_unverified"
        : "awaiting_board1_eta",
      {
        scoreTc: `${walkLabel} · ${
          board1TimingStatus === "catchability_unverified"
            ? TIMING_STATUS_TC.catchability_unverified
            : TIMING_STATUS_TC.awaiting_board1_eta
        }`,
        timingNoteTc:
          board1TimingStatus === "catchability_unverified"
            ? TIMING_STATUS_TC.catchability_unverified
            : TIMING_STATUS_TC.awaiting_board1_eta,
      },
      nowMs,
    );
  }

  let etas1Raw: EtaItem[] = [];
  let etas2: EtaItem[] = [];
  let leg1Err = false;
  let leg2Err = false;

  const [r1, r2] = await Promise.allSettled([
    listEtas(leg1.co, leg1.route, pair.alight1.stopId, leg1.serviceType, {
      bound: leg1.bound,
      stopSeq: pair.alight1.seq,
    }),
    listEtas(leg2.co, leg2.route, pair.board2.stopId, leg2.serviceType, {
      bound: leg2.bound,
      stopSeq: pair.board2.seq,
    }),
  ]);

  if (r1.status === "fulfilled") etas1Raw = r1.value;
  else leg1Err = true;
  if (r2.status === "fulfilled") etas2 = r2.value;
  else leg2Err = true;

  if (leg1Err && leg2Err) {
    return baseCandidate(
      pair,
      board1Eta,
      "upstream_error",
      {
        scoreTc: `${walkLabel} · ${TIMING_STATUS_TC.upstream_error}`,
        timingNoteTc: TIMING_STATUS_TC.upstream_error,
      },
      nowMs,
    );
  }

  const { earliestMs, noteTc: continuityNote } = earliestAlightMsHeuristic(
    board1Eta,
    board1.seq,
    pair.alight1.seq,
    nowMs,
  );

  if (leg1Err) {
    return baseCandidate(
      pair,
      board1Eta,
      "upstream_error",
      {
        scoreTc: `${walkLabel} · 第一程落車 ETA 暫時無法讀取`,
        timingNoteTc: "第一程落車班次資料暫時無法讀取；轉車站仍然有效。",
        board1Eta,
      },
      nowMs,
    );
  }

  const etas1 = etas1Raw.filter((e) => parseEtaMs(e.eta) >= earliestMs);

  if (!etas1Raw.length) {
    return baseCandidate(
      pair,
      board1Eta,
      "awaiting_leg1_eta",
      {
        scoreTc: `${walkLabel} · ${TIMING_STATUS_TC.awaiting_leg1_eta}`,
        timingNoteTc: `${TIMING_STATUS_TC.awaiting_leg1_eta}。${continuityNote}`,
        board1Eta,
      },
      nowMs,
    );
  }

  if (!etas1.length) {
    return baseCandidate(
      pair,
      board1Eta,
      "awaiting_leg1_eta",
      {
        scoreTc: `${walkLabel} · ${TIMING_STATUS_TC.awaiting_leg1_eta}`,
        timingNoteTc: `可見落車 ETA 都早過上車時間推算；${continuityNote}`,
        board1Eta,
        leg1Eta: etas1Raw[0]?.eta ?? null,
      },
      nowMs,
    );
  }

  if (leg2Err) {
    return baseCandidate(
      pair,
      board1Eta,
      "upstream_error",
      {
        scoreTc: `${walkLabel} · 第二程 ETA 暫時無法讀取`,
        timingNoteTc: "第二程班次資料暫時無法讀取；轉車站仍然有效。",
        board1Eta,
        leg1Eta: etas1[0]?.eta ?? null,
        timingConfidence: "estimated_unverified",
      },
      nowMs,
    );
  }

  if (!etas2.length) {
    return baseCandidate(
      pair,
      board1Eta,
      "awaiting_leg2_eta",
      {
        scoreTc: `${walkLabel} · ${TIMING_STATUS_TC.awaiting_leg2_eta}`,
        timingNoteTc: `${TIMING_STATUS_TC.awaiting_leg2_eta}。空列表唔代表已收車。${continuityNote}`,
        board1Eta,
        leg1Eta: etas1[0]?.eta ?? null,
        timingConfidence: "estimated_unverified",
      },
      nowMs,
    );
  }

  const matched = matchTransfer({
    leg1: {
      ...leg1,
      stopId: pair.alight1.stopId,
      stopNameTc: pair.alight1.nameTc,
      etas: etas1,
    },
    leg2: {
      ...leg2,
      stopId: pair.board2.stopId,
      stopNameTc: pair.board2.nameTc,
      etas: etas2,
    },
    walkMinutes: pair.walkMinutes,
    bufferMinutes,
  });

  const best =
    matched.pairs.find(
      (p) =>
        p.status !== "outside_visible_eta" &&
        !!p.leg2Eta &&
        isChronological(board1Eta, p.leg1Eta, p.leg2Eta),
    ) ?? null;

  if (!best || !best.leg2Eta) {
    return baseCandidate(
      pair,
      board1Eta,
      "outside_visible_eta",
      {
        scoreTc: `${walkLabel} · ${TIMING_STATUS_TC.outside_visible_eta}`,
        timingNoteTc: `${TIMING_STATUS_TC.outside_visible_eta}。唔代表之後冇班次。${continuityNote}`,
        board1Eta,
        leg1Eta: etas1[0]?.eta ?? null,
        timingConfidence: "estimated_unverified",
      },
      nowMs,
    );
  }

  const board2InMinutes = minutesFromNow(best.leg2Eta, nowMs);
  return baseCandidate(
    pair,
    board1Eta,
    "eta_matched",
    {
      scoreTc: `第二程上車 ${fmtHkHm(best.leg2Eta)}（約 ${board2InMinutes} 分後）· ${walkLabel}`,
      timingNoteTc: `${TIMING_STATUS_TC.eta_matched}。${continuityNote}`,
      timingConfidence: "estimated_unverified",
      waitMinutes: best.waitMinutes,
      gapMinutes: best.gapMinutes,
      board1Eta,
      leg1Eta: best.leg1Eta,
      leg2Eta: best.leg2Eta,
      readyAt: best.readyAt,
      board2InMinutes,
    },
    nowMs,
  );
}

/** Re-score one physical pair with the same board1 constraint (for refresh / selection). */
export async function refreshCandidateTiming(params: {
  boarding?: BoardingInput;
  origin?: { lat: number; long: number };
  leg1: RouteRef;
  leg2: RouteRef;
  alight1StopId: string;
  alight1Seq: number;
  board2StopId: string;
  board2Seq: number;
  bufferMinutes?: number;
  preferredBoard1Eta?: string | null;
  nowMs?: number;
}): Promise<{
  board1Context: Board1Context;
  candidate: TransferCandidate;
  generatedAt: string;
}> {
  const nowMs = params.nowMs ?? Date.now();
  const bufferMinutes = Math.max(0, params.bufferMinutes ?? 1);
  const boarding = normalizeBoardingInput(params);
  const board1Context = await resolveBoard1Context({
    boarding,
    leg1: params.leg1,
    bufferMinutes,
    preferredBoard1Eta: params.preferredBoard1Eta,
    nowMs,
  });

  const stops2 = await listRouteStops(
    params.leg2.co,
    params.leg2.route,
    params.leg2.bound,
    params.leg2.serviceType,
  );

  const alight1 =
    board1Context.stops1.find(
      (s) => s.stopId === params.alight1StopId && s.seq === params.alight1Seq,
    ) ??
    board1Context.stops1.find((s) => s.stopId === params.alight1StopId);
  const board2 =
    stops2.find((s) => s.stopId === params.board2StopId && s.seq === params.board2Seq) ??
    stops2.find((s) => s.stopId === params.board2StopId);

  if (!alight1 || !board2) {
    throw new Error("轉車站唔屬於所選路線／方向");
  }
  if (alight1.seq <= board1Context.board1.seq) {
    throw new Error("落車站必須喺第一程上車站之後");
  }
  if (!alight1.hasValidCoord || !board2.hasValidCoord) {
    throw new Error("轉車站座標無效");
  }

  const meters = distanceMeters(alight1, board2);
  if (!Number.isFinite(meters)) throw new Error("無法計算轉車距離");
  const pair: PhysicalPair = {
    alight1,
    board2,
    walkMeters: Math.round(meters),
    walkMinutes: estimateWalkMinutes(alight1, board2),
  };

  const candidate = await scoreCandidate({
    leg1: params.leg1,
    leg2: params.leg2,
    pair,
    bufferMinutes,
    board1: board1Context.board1,
    board1Eta: board1Context.board1.boardEta,
    board1TimingStatus: board1Context.board1TimingStatus,
    nowMs,
  });

  return {
    board1Context: {
      board1: board1Context.board1,
      board1Departures: board1Context.board1Departures,
      board1EtaSource: board1Context.board1EtaSource,
      board1TimingStatus: board1Context.board1TimingStatus,
      board1TimingStatusTc: board1Context.board1TimingStatusTc,
    },
    candidate,
    generatedAt: new Date(nowMs).toISOString(),
  };
}

const FASTEST_EVAL_CAP = 24;

export async function planTransfer(params: {
  boarding?: BoardingInput;
  origin?: { lat: number; long: number };
  leg1: RouteRef;
  leg2: RouteRef;
  mode: PlanMode;
  maxTransferMeters?: number;
  bufferMinutes?: number;
  limit?: number;
  preferredBoard1Eta?: string | null;
  nowMs?: number;
}): Promise<TransferPlanResult> {
  const maxTransferMeters = Math.min(Math.max(params.maxTransferMeters ?? 450, 80), 1200);
  const bufferMinutes = Math.max(0, params.bufferMinutes ?? 1);
  const limit = Math.min(Math.max(params.limit ?? 8, 1), 20);
  const nowMs = params.nowMs ?? Date.now();
  const generatedAt = new Date(nowMs).toISOString();
  const boarding = normalizeBoardingInput(params);

  const [{ stops1, board1, board1Departures, board1EtaSource, board1TimingStatus, board1TimingStatusTc }, stops2] =
    await Promise.all([
      resolveBoard1Context({
        boarding,
        leg1: params.leg1,
        bufferMinutes,
        preferredBoard1Eta: params.preferredBoard1Eta,
        nowMs,
      }),
      listRouteStops(params.leg2.co, params.leg2.route, params.leg2.bound, params.leg2.serviceType),
    ]);

  if (!stops2.length) throw new Error("第二程未有車站資料");

  const board1Eta = board1.boardEta;
  const tripLabel =
    board1EtaSource === "manual" ? "你揀嘅班次" : board1EtaSource === "auto" ? "自動班次" : "未定班次";

  const pairs = buildPairs(stops1, stops2, board1.seq, maxTransferMeters, params.mode);
  if (!pairs.length) {
    return {
      mode: params.mode,
      board1,
      board1Departures,
      board1EtaSource,
      board1TimingStatus,
      board1TimingStatusTc,
      candidates: [],
      summaryTc: `第一程上車站係「${board1.nameTc}」，但兩程喺 ${maxTransferMeters}m 內搵唔到可步行轉乘站（直線距離）。可改人手選擇或加大步行範圍。`,
      searchTruncated: false,
      searchNoteTc: null,
      generatedAt,
    };
  }

  const scoreOne = (p: PhysicalPair) =>
    scoreCandidate({
      leg1: params.leg1,
      leg2: params.leg2,
      pair: p,
      bufferMinutes,
      board1,
      board1Eta,
      board1TimingStatus,
      nowMs,
    });

  if (params.mode === "shortest_walk" || params.mode === "manual") {
    const top = pairs.slice(0, limit);
    const scored = await mapPool(top, 6, scoreOne);
    const summaryTc =
      params.mode === "manual"
        ? `已列出 ${scored.length} 個可揀轉乘站（由近至遠，含未有 ETA 嘅選項）。${tripLabel}第一程上車 ${fmtHkHm(board1Eta)}。${WALK_CAVEAT_TC}`
        : `最少步行：最近轉乘約 ${scored[0].walkMeters}m。${tripLabel}第一程上車 ${fmtHkHm(board1Eta)}。時間狀態：${scored[0].timingStatusTc}`;
    return {
      mode: params.mode,
      board1,
      board1Departures,
      board1EtaSource,
      board1TimingStatus,
      board1TimingStatusTc,
      candidates: scored,
      summaryTc,
      searchTruncated: pairs.length > limit,
      searchNoteTc:
        pairs.length > limit
          ? `結果限於已評估嘅 ${limit} 個較近轉車站，唔係全局最優。`
          : null,
      generatedAt,
    };
  }

  // fastest = earliest estimated second-bus boarding among evaluated candidates
  const evalCap = Math.min(FASTEST_EVAL_CAP, pairs.length);
  const shortlist = pairs.slice(0, evalCap);
  const searchTruncated = pairs.length > evalCap;
  const scored = await mapPool(shortlist, 6, scoreOne);

  const timed = scored.filter((c) => c.timingStatus === "eta_matched" && c.leg2Eta);
  const unknown = scored.filter((c) => c.timingStatus !== "eta_matched");

  timed.sort((a, b) => {
    const aBoard = a.leg2Eta ? parseEtaMs(a.leg2Eta) : Infinity;
    const bBoard = b.leg2Eta ? parseEtaMs(b.leg2Eta) : Infinity;
    if (aBoard !== bBoard) return aBoard - bBoard;
    return a.walkMeters - b.walkMeters;
  });
  unknown.sort((a, b) => a.walkMeters - b.walkMeters);

  const ranked = [...timed, ...unknown].slice(0, limit);
  const bestTimed = timed[0] ?? null;

  let summaryTc: string;
  if (bestTimed && board1Eta && bestTimed.leg1Eta && bestTimed.leg2Eta && board1TimingStatus === "ok") {
    const walkBit =
      board1.walkMinutesFromOrigin != null
        ? `行去「${board1.nameTc}」約 ${board1.walkMinutesFromOrigin} 分，`
        : board1.minutesToBoardStop != null
          ? `約 ${board1.minutesToBoardStop} 分後到「${board1.nameTc}」，`
          : `喺「${board1.nameTc}」`;
    summaryTc = `最早第二程上車（${tripLabel}，估算）：${walkBit}${fmtHkHm(board1Eta)} 上第一程 → ${fmtHkHm(bestTimed.leg1Eta)} 喺「${bestTimed.alight1.nameTc}」落 → 步行約 ${bestTimed.walkMeters}m → 約 ${fmtHkHm(bestTimed.leg2Eta)} 上第二程。呢個係最早上車，唔係終點到達時間。`;
  } else if (!timed.length) {
    summaryTc = `暫未能比較最快方案，先列出較少步行轉車站。${board1TimingStatusTc}。${WALK_CAVEAT_TC}`;
  } else {
    summaryTc = `${tripLabel}第一程 ${fmtHkHm(board1Eta)} 喺「${board1.nameTc}」；部分轉車站有可見時間估算。`;
  }

  return {
    mode: "fastest",
    board1,
    board1Departures,
    board1EtaSource,
    board1TimingStatus,
    board1TimingStatusTc,
    candidates: ranked,
    summaryTc,
    searchTruncated,
    searchNoteTc: searchTruncated
      ? `最快模式只評估 ${evalCap} 個較近轉乘組合（共 ${pairs.length}），唔保證全局最早。`
      : null,
    generatedAt,
  };
}
