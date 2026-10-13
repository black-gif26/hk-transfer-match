import {
  distanceMeters,
  estimateWalkMinutes,
  listEtas,
  listRouteStops,
  type Bound,
  type Company,
  type EtaItem,
  type StopInfo,
} from "./hk-transit";
import { matchTransfer } from "./transfer";

export type PlanMode = "shortest_walk" | "fastest" | "manual";

export interface RouteRef {
  co: Company;
  route: string;
  bound: Bound;
  serviceType: string;
}

export interface TransferCandidate {
  alight1: StopInfo;
  board2: StopInfo;
  walkMeters: number;
  walkMinutes: number;
  hasMatch: boolean;
  waitMinutes: number | null;
  gapMinutes: number | null;
  board1Eta: string | null;
  leg1Eta: string | null;
  leg2Eta: string | null;
  readyAt: string | null;
  /** Estimated minutes from now until boarding the second bus. */
  board2InMinutes: number | null;
  scoreTc: string;
}

export interface TransferPlanResult {
  mode: PlanMode;
  board1: StopInfo & {
    metersFromOrigin: number;
    walkMinutesFromOrigin: number;
    boardEta: string | null;
  };
  candidates: TransferCandidate[];
  summaryTc: string;
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
  return Math.max(0, Math.round((parseEtaMs(iso) - nowMs) / 60_000));
}

function pickNearestStop(origin: { lat: number; long: number }, stops: StopInfo[]): StopInfo {
  let best = stops[0];
  let bestD = Infinity;
  for (const s of stops) {
    if (!Number.isFinite(s.lat) || !Number.isFinite(s.long)) continue;
    const d = distanceMeters(origin, s);
    if (d < bestD) {
      bestD = d;
      best = s;
    }
  }
  return best;
}

/** First ETA you can catch after walking from origin (+ buffer). */
function pickCatchableEta(
  etas: EtaItem[],
  readyMs: number,
): EtaItem | null {
  const sorted = [...etas].sort((a, b) => a.eta.localeCompare(b.eta));
  return sorted.find((e) => parseEtaMs(e.eta) >= readyMs) ?? null;
}

function buildPairs(
  stops1: StopInfo[],
  stops2: StopInfo[],
  board1Seq: number,
  maxTransferMeters: number,
): Array<{ alight1: StopInfo; board2: StopInfo; walkMeters: number; walkMinutes: number }> {
  const pairs: Array<{
    alight1: StopInfo;
    board2: StopInfo;
    walkMeters: number;
    walkMinutes: number;
  }> = [];

  for (const a of stops1) {
    if (a.seq <= board1Seq) continue;
    for (const b of stops2) {
      if (!Number.isFinite(a.lat) || !Number.isFinite(b.lat)) continue;
      const meters = distanceMeters(a, b);
      if (meters > maxTransferMeters) continue;
      pairs.push({
        alight1: a,
        board2: b,
        walkMeters: Math.round(meters),
        walkMinutes: estimateWalkMinutes(a, b),
      });
    }
  }

  const bestByAlight = new Map<string, (typeof pairs)[number]>();
  for (const p of pairs) {
    const key = p.alight1.stopId;
    const prev = bestByAlight.get(key);
    if (!prev || p.walkMeters < prev.walkMeters) bestByAlight.set(key, p);
  }
  return [...bestByAlight.values()].sort((x, y) => x.walkMeters - y.walkMeters);
}

async function scoreCandidate(params: {
  leg1: RouteRef;
  leg2: RouteRef;
  pair: { alight1: StopInfo; board2: StopInfo; walkMeters: number; walkMinutes: number };
  bufferMinutes: number;
  board1: StopInfo;
  board1Eta: string | null;
  nowMs: number;
}): Promise<TransferCandidate> {
  const { leg1, leg2, pair, bufferMinutes, board1, board1Eta, nowMs } = params;

  const [etas1Raw, etas2] = await Promise.all([
    listEtas(leg1.co, leg1.route, pair.alight1.stopId, leg1.serviceType),
    listEtas(leg2.co, leg2.route, pair.board2.stopId, leg2.serviceType),
  ]);

  // Rough ride time so alight ETA is after the bus you boarded at board1.
  const stopGap = Math.max(1, pair.alight1.seq - board1.seq);
  const minRideMinutes = Math.max(2, Math.round(stopGap * 1.6));
  const earliestAlightMs = board1Eta
    ? parseEtaMs(board1Eta) + minRideMinutes * 60_000
    : nowMs;

  const etas1 = etas1Raw.filter((e) => parseEtaMs(e.eta) >= earliestAlightMs);

  const matched = matchTransfer({
    leg1: {
      ...leg1,
      stopId: pair.alight1.stopId,
      stopNameTc: pair.alight1.nameTc,
      etas: etas1.length ? etas1 : etas1Raw,
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

  const best = matched.pairs.find((p) => p.status !== "miss") ?? null;
  const board2InMinutes = minutesFromNow(best?.leg2Eta ?? null, nowMs);

  let scoreTc: string;
  if (best) {
    scoreTc = `第二程上車 ${fmtHkHm(best.leg2Eta)}（約 ${board2InMinutes} 分後）· 轉車步行 ${pair.walkMeters}m`;
  } else {
    scoreTc = `轉車步行 ${pair.walkMeters}m · 暫時接唔到可見班次`;
  }

  return {
    alight1: pair.alight1,
    board2: pair.board2,
    walkMeters: pair.walkMeters,
    walkMinutes: pair.walkMinutes,
    hasMatch: !!best,
    waitMinutes: best?.waitMinutes ?? null,
    gapMinutes: best?.gapMinutes ?? null,
    board1Eta,
    leg1Eta: best?.leg1Eta ?? etas1[0]?.eta ?? etas1Raw[0]?.eta ?? null,
    leg2Eta: best?.leg2Eta ?? null,
    readyAt: best?.readyAt ?? null,
    board2InMinutes,
    scoreTc,
  };
}

export async function planTransfer(params: {
  origin: { lat: number; long: number };
  leg1: RouteRef;
  leg2: RouteRef;
  mode: PlanMode;
  maxTransferMeters?: number;
  bufferMinutes?: number;
  limit?: number;
}): Promise<TransferPlanResult> {
  const maxTransferMeters = Math.min(Math.max(params.maxTransferMeters ?? 450, 80), 1200);
  const bufferMinutes = Math.max(0, params.bufferMinutes ?? 1);
  const limit = Math.min(Math.max(params.limit ?? 8, 1), 20);
  const nowMs = Date.now();

  const [stops1, stops2] = await Promise.all([
    listRouteStops(params.leg1.co, params.leg1.route, params.leg1.bound, params.leg1.serviceType),
    listRouteStops(params.leg2.co, params.leg2.route, params.leg2.bound, params.leg2.serviceType),
  ]);

  if (!stops1.length) throw new Error("第一程未有車站資料");
  if (!stops2.length) throw new Error("第二程未有車站資料");

  const nearest = pickNearestStop(params.origin, stops1);
  const metersFromOrigin = Math.round(distanceMeters(params.origin, nearest));
  const walkMinutesFromOrigin = Math.max(
    1,
    Math.ceil(metersFromOrigin / ((4.5 * 1000) / 60)),
  );

  const board1Etas = await listEtas(
    params.leg1.co,
    params.leg1.route,
    nearest.stopId,
    params.leg1.serviceType,
  );
  const readyAtBoard1Ms = nowMs + (walkMinutesFromOrigin + bufferMinutes) * 60_000;
  const catchable = pickCatchableEta(board1Etas, readyAtBoard1Ms);
  const board1Eta = catchable?.eta ?? board1Etas[0]?.eta ?? null;

  const board1 = {
    ...nearest,
    metersFromOrigin,
    walkMinutesFromOrigin,
    boardEta: board1Eta,
  };

  const pairs = buildPairs(stops1, stops2, board1.seq, maxTransferMeters);
  if (!pairs.length) {
    return {
      mode: params.mode,
      board1,
      candidates: [],
      summaryTc: `第一程最近上車站係「${board1.nameTc}」，但兩程喺 ${maxTransferMeters}m 內搵唔到可步行轉乘站。可改人手選擇或加大步行範圍。`,
    };
  }

  const scoreOne = (p: (typeof pairs)[number]) =>
    scoreCandidate({
      leg1: params.leg1,
      leg2: params.leg2,
      pair: p,
      bufferMinutes,
      board1,
      board1Eta,
      nowMs,
    });

  if (params.mode === "shortest_walk" || params.mode === "manual") {
    const top = pairs.slice(0, limit);
    const scored = await Promise.all(top.map(scoreOne));
    const summaryTc =
      params.mode === "manual"
        ? `已列出 ${scored.length} 個可揀轉乘站（由近至遠）。預計第一程上車 ${fmtHkHm(board1Eta)}。`
        : `最少步行：最近轉乘約 ${scored[0].walkMeters}m。預計第一程上車 ${fmtHkHm(board1Eta)}，第二程上車 ${fmtHkHm(scored[0].leg2Eta)}。`;
    return { mode: params.mode, board1, candidates: scored, summaryTc };
  }

  // fastest = earliest estimated second-bus boarding time
  const shortlist = pairs.slice(0, Math.min(16, pairs.length));
  const scored = await Promise.all(shortlist.map(scoreOne));

  scored.sort((a, b) => {
    if (a.hasMatch !== b.hasMatch) return a.hasMatch ? -1 : 1;
    if (a.hasMatch && b.hasMatch) {
      const aBoard = a.leg2Eta ? parseEtaMs(a.leg2Eta) : Infinity;
      const bBoard = b.leg2Eta ? parseEtaMs(b.leg2Eta) : Infinity;
      if (aBoard !== bBoard) return aBoard - bBoard;
      return a.walkMeters - b.walkMeters;
    }
    return a.walkMeters - b.walkMeters;
  });

  const top = scored.slice(0, limit);
  const best = top[0];
  const summaryTc = best?.hasMatch
    ? `上車時間估算：行去「${board1.nameTc}」約 ${board1.walkMinutesFromOrigin} 分，預計 ${fmtHkHm(board1Eta)} 上第一程；轉「${best.alight1.nameTc} → ${best.board2.nameTc}」後，約 ${fmtHkHm(best.leg2Eta)} 上第二程。`
    : `搵到 ${top.length} 個近距離轉乘站，但即時 ETA 暫時未見穩陣接駁；可試人手選擇。`;

  return { mode: "fastest", board1, candidates: top, summaryTc };
}
