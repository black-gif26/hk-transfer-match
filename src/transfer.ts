import type { Company, Bound, EtaItem } from "./hk-transit";

export interface LegInput {
  co: Company;
  route: string;
  bound: Bound;
  serviceType: string;
  stopId: string;
  stopNameTc?: string;
}

export interface TransferPair {
  leg1Eta: string;
  leg2Eta: string;
  readyAt: string;
  waitMinutes: number;
  gapMinutes: number;
  status: "comfortable" | "tight" | "miss";
  statusTc: string;
}

export interface TransferResult {
  generatedAt: string;
  walkMinutes: number;
  bufferMinutes: number;
  leg1: {
    co: Company;
    route: string;
    stopId: string;
    stopNameTc: string;
    etas: EtaItem[];
  };
  leg2: {
    co: Company;
    route: string;
    stopId: string;
    stopNameTc: string;
    etas: EtaItem[];
  };
  pairs: TransferPair[];
  summaryTc: string;
  hasMatch: boolean;
}

function parseEta(iso: string): number {
  return new Date(iso).getTime();
}

function addMinutes(iso: string, minutes: number): string {
  const d = new Date(parseEta(iso) + minutes * 60_000);
  // Keep Hong Kong offset so UI / API stay consistent with ETA feeds.
  const hk = new Date(d.getTime() + 8 * 60 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${hk.getUTCFullYear()}-${pad(hk.getUTCMonth() + 1)}-${pad(hk.getUTCDate())}T${pad(hk.getUTCHours())}:${pad(hk.getUTCMinutes())}:${pad(hk.getUTCSeconds())}+08:00`;
}

function minutesBetween(aIso: string, bIso: string): number {
  return Math.round((parseEta(bIso) - parseEta(aIso)) / 60_000);
}

export function matchTransfer(params: {
  leg1: LegInput & { stopNameTc: string; etas: EtaItem[] };
  leg2: LegInput & { stopNameTc: string; etas: EtaItem[] };
  walkMinutes: number;
  bufferMinutes: number;
  /** When set, ignore alight ETAs that belong to a bus you have not boarded yet. */
  board1Eta?: string | null;
  /** Minimum minutes on the first bus before an alight ETA can count. */
  minRideMinutes?: number | null;
}): TransferResult {
  const { leg1, leg2, walkMinutes, bufferMinutes } = params;
  const minRideMinutes = Math.max(0, params.minRideMinutes ?? 0);
  const boardMs = params.board1Eta ? parseEta(params.board1Eta) : NaN;
  const leg1Etas = Number.isFinite(boardMs)
    ? leg1.etas.filter((eta) => parseEta(eta.eta) >= boardMs + minRideMinutes * 60_000)
    : leg1.etas;
  const pairs: TransferPair[] = [];

  for (const e1 of leg1Etas) {
    const readyAt = addMinutes(e1.eta, walkMinutes + bufferMinutes);
    const readyMs = parseEta(readyAt);

    const candidates = leg2.etas
      .filter((e2) => parseEta(e2.eta) >= readyMs)
      .sort((a, b) => a.eta.localeCompare(b.eta));

    const best = candidates[0];
    if (!best) {
      pairs.push({
        leg1Eta: e1.eta,
        leg2Eta: "",
        readyAt,
        waitMinutes: -1,
        gapMinutes: -1,
        status: "miss",
        statusTc: "第二程未見足夠遲嘅班次",
      });
      continue;
    }

    const waitMinutes = minutesBetween(readyAt, best.eta);
    const gapMinutes = minutesBetween(e1.eta, best.eta);
    let status: TransferPair["status"] = "comfortable";
    let statusTc = "充裕";
    if (waitMinutes <= 2) {
      status = "tight";
      statusTc = "好逼";
    } else if (waitMinutes <= 8) {
      status = "comfortable";
      statusTc = "啱啱好";
    } else {
      status = "comfortable";
      statusTc = "要等一陣";
    }

    pairs.push({
      leg1Eta: e1.eta,
      leg2Eta: best.eta,
      readyAt,
      waitMinutes,
      gapMinutes,
      status,
      statusTc,
    });
  }

  const matched = pairs.filter((p) => p.status !== "miss");
  const hasMatch = matched.length > 0;
  let summaryTc: string;
  if (!leg1.etas.length) {
    summaryTc = "第一程暫時未有 ETA，可能收車或者資料暫時空。";
  } else if (!leg1Etas.length) {
    summaryTc = "見到嘅落車時間早過你上第一程，接唔到呢班。";
  } else if (!leg2.etas.length) {
    summaryTc = "第二程暫時未有 ETA，可能收車或者資料暫時空。";
  } else if (!hasMatch) {
    summaryTc = "依家呢幾班第一程，行過去都趕唔切第二程可見班次。";
  } else {
    const best = matched.reduce((a, b) => (a.waitMinutes < b.waitMinutes ? a : b));
    summaryTc = `有 ${matched.length} 個轉乘組合 match；最快落地後仲有約 ${best.waitMinutes} 分鐘等第二程。`;
  }

  return {
    generatedAt: new Date().toISOString(),
    walkMinutes,
    bufferMinutes,
    leg1: {
      co: leg1.co,
      route: leg1.route,
      stopId: leg1.stopId,
      stopNameTc: leg1.stopNameTc,
      etas: leg1.etas,
    },
    leg2: {
      co: leg2.co,
      route: leg2.route,
      stopId: leg2.stopId,
      stopNameTc: leg2.stopNameTc,
      etas: leg2.etas,
    },
    pairs,
    summaryTc,
    hasMatch,
  };
}
