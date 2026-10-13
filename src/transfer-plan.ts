import {
  distanceMeters,
  estimateWalkMinutes,
  listEtas,
  listRouteStops,
  type Bound,
  type Company,
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
  leg1Eta: string | null;
  leg2Eta: string | null;
  readyAt: string | null;
  scoreTc: string;
}

export interface TransferPlanResult {
  mode: PlanMode;
  board1: StopInfo & { metersFromOrigin: number; walkMinutesFromOrigin: number };
  candidates: TransferCandidate[];
  summaryTc: string;
}

function parseEtaMs(iso: string): number {
  return new Date(iso).getTime();
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
    // Must ride at least one stop before transferring.
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

  // Keep best board2 per alight stop (shortest walk), then unique-ish pairs.
  const bestByAlight = new Map<string, (typeof pairs)[number]>();
  for (const p of pairs) {
    const key = p.alight1.stopId;
    const prev = bestByAlight.get(key);
    if (!prev || p.walkMeters < prev.walkMeters) bestByAlight.set(key, p);
  }
  return [...bestByAlight.values()].sort((x, y) => x.walkMeters - y.walkMeters);
}

async function scoreCandidate(
  leg1: RouteRef,
  leg2: RouteRef,
  pair: { alight1: StopInfo; board2: StopInfo; walkMeters: number; walkMinutes: number },
  bufferMinutes: number,
): Promise<TransferCandidate> {
  const [etas1, etas2] = await Promise.all([
    listEtas(leg1.co, leg1.route, pair.alight1.stopId, leg1.serviceType),
    listEtas(leg2.co, leg2.route, pair.board2.stopId, leg2.serviceType),
  ]);

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

  const best = matched.pairs.find((p) => p.status !== "miss") ?? null;
  return {
    alight1: pair.alight1,
    board2: pair.board2,
    walkMeters: pair.walkMeters,
    walkMinutes: pair.walkMinutes,
    hasMatch: !!best,
    waitMinutes: best?.waitMinutes ?? null,
    gapMinutes: best?.gapMinutes ?? null,
    leg1Eta: best?.leg1Eta ?? etas1[0]?.eta ?? null,
    leg2Eta: best?.leg2Eta ?? null,
    readyAt: best?.readyAt ?? null,
    scoreTc: best
      ? `步行 ${pair.walkMeters}m · 等約 ${best.waitMinutes} 分`
      : `步行 ${pair.walkMeters}m · 暫時接唔到可見班次`,
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

  const [stops1, stops2] = await Promise.all([
    listRouteStops(params.leg1.co, params.leg1.route, params.leg1.bound, params.leg1.serviceType),
    listRouteStops(params.leg2.co, params.leg2.route, params.leg2.bound, params.leg2.serviceType),
  ]);

  if (!stops1.length) throw new Error("第一程未有車站資料");
  if (!stops2.length) throw new Error("第二程未有車站資料");

  const nearest = pickNearestStop(params.origin, stops1);
  const metersFromOrigin = Math.round(distanceMeters(params.origin, nearest));
  const board1 = {
    ...nearest,
    metersFromOrigin,
    walkMinutesFromOrigin: Math.max(1, Math.ceil(metersFromOrigin / ((4.5 * 1000) / 60))),
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

  if (params.mode === "shortest_walk" || params.mode === "manual") {
    const top = pairs.slice(0, limit);
    // Still attach light ETA scoring for display, but keep walk order.
    const scored = await Promise.all(
      top.map((p) => scoreCandidate(params.leg1, params.leg2, p, bufferMinutes)),
    );
    const summaryTc =
      params.mode === "manual"
        ? `已列出 ${scored.length} 個可揀轉乘站（由近至遠）。你可人手揀一個。`
        : `最少步行：最近轉乘約 ${scored[0].walkMeters}m（${scored[0].alight1.nameTc} → ${scored[0].board2.nameTc}）。`;
    return { mode: params.mode, board1, candidates: scored, summaryTc };
  }

  // fastest: evaluate a wider shortlist by walk, then sort by earliest successful board2 time / wait
  const shortlist = pairs.slice(0, Math.min(16, pairs.length));
  const scored = await Promise.all(
    shortlist.map((p) => scoreCandidate(params.leg1, params.leg2, p, bufferMinutes)),
  );

  scored.sort((a, b) => {
    if (a.hasMatch !== b.hasMatch) return a.hasMatch ? -1 : 1;
    if (a.hasMatch && b.hasMatch) {
      const aBoard = a.leg2Eta ? parseEtaMs(a.leg2Eta) : Infinity;
      const bBoard = b.leg2Eta ? parseEtaMs(b.leg2Eta) : Infinity;
      if (aBoard !== bBoard) return aBoard - bBoard;
      return (a.waitMinutes ?? 99) - (b.waitMinutes ?? 99);
    }
    return a.walkMeters - b.walkMeters;
  });

  const top = scored.slice(0, limit);
  const best = top[0];
  const summaryTc = best?.hasMatch
    ? `最快轉乘：建議喺「${best.alight1.nameTc}」轉「${best.board2.nameTc}」，第二程約 ${best.leg2Eta ? new Date(best.leg2Eta).toLocaleTimeString("zh-HK", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Hong_Kong" }) : "—"} 可上車。`
    : `搵到 ${top.length} 個近距離轉乘站，但即時 ETA 暫時未見穩陣接駁；可試人手選擇。`;

  return { mode: "fastest", board1, candidates: top, summaryTc };
}
