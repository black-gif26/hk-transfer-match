import {
  distanceMeters,
  estimateWalkMinutes,
  listEtas,
  listRouteStops,
  SubrequestBudget,
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

export interface Board1Departure {
  eta: string;
  etaSeq: number;
  destTc: string;
  catchable: boolean;
  inMinutes: number;
  labelTc: string;
}

export interface TransferPlanResult {
  mode: PlanMode;
  board1: StopInfo & {
    metersFromOrigin: number;
    walkMinutesFromOrigin: number;
    boardEta: string | null;
  };
  board1Departures: Board1Departure[];
  board1EtaSource: "auto" | "manual";
  candidates: TransferCandidate[];
  summaryTc: string;
}

export interface Board1Context {
  board1: StopInfo & {
    metersFromOrigin: number;
    walkMinutesFromOrigin: number;
    boardEta: string | null;
  };
  board1Departures: Board1Departure[];
  board1EtaSource: "auto" | "manual";
}

async function mapPool<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  if (!items.length) return out;
  let cursor = 0;
  const workers = Math.min(size, items.length);
  await Promise.all(
    Array.from({ length: workers }, async () => {
      while (cursor < items.length) {
        const index = cursor++;
        out[index] = await fn(items[index]);
      }
    }),
  );
  return out;
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

function buildBoard1Departures(
  etas: EtaItem[],
  readyMs: number,
  nowMs: number,
): Board1Departure[] {
  return [...etas]
    .filter((e) => !!e.eta)
    .sort((a, b) => a.eta.localeCompare(b.eta))
    .map((e) => {
      const catchable = parseEtaMs(e.eta) >= readyMs;
      const inMinutes = minutesFromNow(e.eta, nowMs) ?? 0;
      return {
        eta: e.eta,
        etaSeq: e.etaSeq,
        destTc: e.destTc,
        catchable,
        inMinutes,
        labelTc: `${fmtHkHm(e.eta)}（${inMinutes} 分後）${catchable ? " · 趕得切" : " · 可能趕唔切"}${e.destTc ? ` → ${e.destTc}` : ""}`,
      };
    });
}

export async function resolveBoard1Context(params: {
  origin?: { lat: number; long: number } | null;
  leg1: RouteRef;
  bufferMinutes?: number;
  preferredBoard1Eta?: string | null;
  preferredBoard1StopId?: string | null;
  budget?: SubrequestBudget;
}): Promise<Board1Context & { stops1: StopInfo[] }> {
  const bufferMinutes = Math.max(0, params.bufferMinutes ?? 1);
  const nowMs = Date.now();
  const stops1 = await listRouteStops(
    params.leg1.co,
    params.leg1.route,
    params.leg1.bound,
    params.leg1.serviceType,
    params.budget,
  );
  if (!stops1.length) throw new Error("第一程未有車站資料");

  const origin = params.origin && Number.isFinite(params.origin.lat) && Number.isFinite(params.origin.long)
    ? params.origin
    : null;
  const chosenBoard = params.preferredBoard1StopId
    ? stops1.find((stop) => stop.stopId === params.preferredBoard1StopId) ?? null
    : null;
  const nearest = chosenBoard
    ?? (origin
      ? pickNearestStop(origin, stops1)
      : stops1.find((stop) => Number.isFinite(stop.lat) && Number.isFinite(stop.long)) ?? stops1[0]);
  const metersFromOrigin = origin ? Math.round(distanceMeters(origin, nearest)) : 0;
  const walkMinutesFromOrigin = origin
    ? Math.max(1, Math.ceil(metersFromOrigin / ((4.5 * 1000) / 60)))
    : 0;
  const board1Etas = await listEtas(
    params.leg1.co,
    params.leg1.route,
    nearest.stopId,
    params.leg1.serviceType,
    params.budget,
  );
  const readyAtBoard1Ms = nowMs + (walkMinutesFromOrigin + bufferMinutes) * 60_000;
  const departures = buildBoard1Departures(board1Etas, readyAtBoard1Ms, nowMs);

  const preferred = params.preferredBoard1Eta?.trim() || null;
  const preferredHit = preferred
    ? departures.find((d) => d.eta === preferred) ?? null
    : null;
  const auto = pickCatchableEta(board1Etas, readyAtBoard1Ms);
  const board1Eta = preferredHit?.eta ?? auto?.eta ?? departures[0]?.eta ?? null;
  const board1EtaSource: "auto" | "manual" = preferredHit ? "manual" : "auto";

  return {
    stops1,
    board1Departures: departures,
    board1EtaSource,
    board1: {
      ...nearest,
      metersFromOrigin,
      walkMinutesFromOrigin,
      boardEta: board1Eta,
    },
  };
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

const CLOSEST_BUSES = 3;

function bareCandidate(
  pair: { alight1: StopInfo; board2: StopInfo; walkMeters: number; walkMinutes: number },
  board1Eta: string | null,
): TransferCandidate {
  return {
    alight1: pair.alight1,
    board2: pair.board2,
    walkMeters: pair.walkMeters,
    walkMinutes: pair.walkMinutes,
    hasMatch: false,
    waitMinutes: null,
    gapMinutes: null,
    board1Eta,
    leg1Eta: null,
    leg2Eta: null,
    readyAt: null,
    board2InMinutes: null,
    scoreTc: `轉車步行 ${pair.walkMeters}m · 落 ${pair.alight1.nameTc} → 上 ${pair.board2.nameTc}`,
  };
}

function isChronological(board1Eta: string | null, leg1Eta: string, leg2Eta: string): boolean {
  if (!board1Eta) return parseEtaMs(leg1Eta) < parseEtaMs(leg2Eta);
  return (
    parseEtaMs(board1Eta) < parseEtaMs(leg1Eta) && parseEtaMs(leg1Eta) < parseEtaMs(leg2Eta)
  );
}

async function scoreCandidate(params: {
  leg1: RouteRef;
  leg2: RouteRef;
  pair: { alight1: StopInfo; board2: StopInfo; walkMeters: number; walkMinutes: number };
  bufferMinutes: number;
  board1: StopInfo;
  board1Eta: string | null;
  nowMs: number;
  budget?: SubrequestBudget;
}): Promise<TransferCandidate> {
  const { leg1, leg2, pair, bufferMinutes, board1, board1Eta, nowMs, budget } = params;

  const miss = (scoreTc: string, leg1Eta: string | null = null): TransferCandidate => ({
    alight1: pair.alight1,
    board2: pair.board2,
    walkMeters: pair.walkMeters,
    walkMinutes: pair.walkMinutes,
    hasMatch: false,
    waitMinutes: null,
    gapMinutes: null,
    board1Eta,
    leg1Eta,
    leg2Eta: null,
    readyAt: null,
    board2InMinutes: null,
    scoreTc,
  });

  const [etas1Raw, etas2] = await Promise.all([
    listEtas(leg1.co, leg1.route, pair.alight1.stopId, leg1.serviceType, budget),
    listEtas(leg2.co, leg2.route, pair.board2.stopId, leg2.serviceType, budget),
  ]);

  // Only use alight ETAs that can belong to the bus you board at board1.
  // (Open ETA has no trip id, so we approximate with min ride time by stop gap.)
  const stopGap = Math.max(1, pair.alight1.seq - board1.seq);
  const minRideMinutes = Math.max(3, Math.round(stopGap * 1.8));
  const earliestAlightMs = board1Eta
    ? parseEtaMs(board1Eta) + minRideMinutes * 60_000
    : nowMs;

  const etas1 = etas1Raw.filter((e) => parseEtaMs(e.eta) >= earliestAlightMs);
  if (!etas1.length) {
    return miss(
      `轉車步行 ${pair.walkMeters}m · 未見第一程落車 ETA（可能仲未入到顯示範圍）`,
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

  // Never accept a chain that goes backwards in time (e.g. board2 before board1).
  const best =
    matched.pairs.find(
      (p) =>
        p.status !== "miss" &&
        !!p.leg2Eta &&
        isChronological(board1Eta, p.leg1Eta, p.leg2Eta),
    ) ?? null;

  if (!best) {
    return miss(`轉車步行 ${pair.walkMeters}m · 暫時接唔到合理時間嘅第二程`, etas1[0]?.eta ?? null);
  }

  const board2InMinutes = minutesFromNow(best.leg2Eta, nowMs);
  return {
    alight1: pair.alight1,
    board2: pair.board2,
    walkMeters: pair.walkMeters,
    walkMinutes: pair.walkMinutes,
    hasMatch: true,
    waitMinutes: best.waitMinutes,
    gapMinutes: best.gapMinutes,
    board1Eta,
    leg1Eta: best.leg1Eta,
    leg2Eta: best.leg2Eta,
    readyAt: best.readyAt,
    board2InMinutes,
    scoreTc: `第二程上車 ${fmtHkHm(best.leg2Eta)}（約 ${board2InMinutes} 分後）· 轉車步行 ${pair.walkMeters}m`,
  };
}

export async function planTransfer(params: {
  origin?: { lat: number; long: number } | null;
  leg1: RouteRef;
  leg2: RouteRef;
  mode: PlanMode;
  maxTransferMeters?: number;
  bufferMinutes?: number;
  limit?: number;
  preferredBoard1Eta?: string | null;
  board1StopId?: string | null;
  alight2StopId?: string | null;
  budget?: SubrequestBudget;
}): Promise<TransferPlanResult> {
  const maxTransferMeters = Math.min(Math.max(params.maxTransferMeters ?? 450, 80), 1200);
  const bufferMinutes = Math.max(0, params.bufferMinutes ?? 1);
  const limit = Math.min(Math.max(params.limit ?? 8, 1), 20);
  const nowMs = Date.now();
  const budget = params.budget ?? new SubrequestBudget();

  const [{ stops1, board1, board1Departures, board1EtaSource }, stops2] = await Promise.all([
    resolveBoard1Context({
      origin: params.origin,
      leg1: params.leg1,
      bufferMinutes,
      preferredBoard1Eta: params.preferredBoard1Eta,
      preferredBoard1StopId: params.board1StopId,
      budget,
    }),
    listRouteStops(params.leg2.co, params.leg2.route, params.leg2.bound, params.leg2.serviceType, budget),
  ]);

  if (!stops2.length) throw new Error("第二程未有車站資料");

  const alight2 = params.alight2StopId
    ? stops2.find((stop) => stop.stopId === params.alight2StopId) ?? null
    : null;
  const boardingStops2 = alight2 ? stops2.filter((stop) => stop.seq < alight2.seq) : stops2;

  const board1Eta = board1.boardEta;
  const tripLabel = board1EtaSource === "manual" ? "你揀嘅班次" : "自動班次";

  if (alight2 && !boardingStops2.length) {
    return {
      mode: params.mode,
      board1,
      board1Departures,
      board1EtaSource,
      candidates: [],
      summaryTc: `第二程落車站「${alight2.nameTc}」前面冇站可以上第二程。`,
    };
  }

  const pairs = buildPairs(stops1, boardingStops2, board1.seq, maxTransferMeters);
  if (!pairs.length) {
    return {
      mode: params.mode,
      board1,
      board1Departures,
      board1EtaSource,
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
      budget,
    });

  // ETA-score only the closest few (two fetches each). List every other
  // feasible interchange by walk, without times, until the user picks one.
  const listed = pairs.slice(0, Math.min(limit, pairs.length));
  const scoreCount = Math.min(CLOSEST_BUSES, listed.length, Math.floor(budget.remaining / 2));
  const shortlist = listed.slice(0, Math.max(0, scoreCount));
  const scoredAll = [
    ...(shortlist.length ? await mapPool(shortlist, 3, scoreOne) : []),
    ...listed.slice(scoreCount).map((pair) => bareCandidate(pair, board1Eta)),
  ];

  if (params.mode === "shortest_walk" || params.mode === "manual") {
    const scored = scoredAll;
    const where = params.origin ? "" : `未用定位，由「${board1.nameTc}」計。`;
    const summaryTc = `${where}有 ${scored.length} 個可轉車站。最近約 ${scored[0].walkMeters}m，${tripLabel}第一程上車 ${fmtHkHm(board1Eta)}。`;
    return {
      mode: params.mode,
      board1,
      board1Departures,
      board1EtaSource,
      candidates: scored,
      summaryTc,
    };
  }

  const scored = scoredAll;

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

  const best = scored.find((c) => c.hasMatch) ?? scored[0];
  let summaryTc: string;
  const where = params.origin ? `行去「${board1.nameTc}」約 ${board1.walkMinutesFromOrigin} 分，` : `未用定位，由「${board1.nameTc}」計。`;
  if (best?.hasMatch && board1Eta && best.leg1Eta && best.leg2Eta) {
    summaryTc = `有 ${scored.length} 個可轉車站。${where}${fmtHkHm(board1Eta)} 上第一程 → 約 ${fmtHkHm(best.leg2Eta)} 上第二程（轉車 ${best.walkMeters}m）。`;
  } else {
    summaryTc = `有 ${scored.length} 個可轉車站。${where}${tripLabel}第一程約 ${fmtHkHm(board1Eta)} 上車，最近轉乘約 ${best?.walkMeters ?? "—"}m。`;
  }

  return {
    mode: "fastest",
    board1,
    board1Departures,
    board1EtaSource,
    candidates: scored,
    summaryTc,
  };
}
