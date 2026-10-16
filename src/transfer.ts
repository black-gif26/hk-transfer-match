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
  leg2Eta: string | null;
  readyAt: string;
  waitMinutes: number | null;
  gapMinutes: number | null;
  status: "comfortable" | "tight" | "outside_visible_eta";
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
  /** True only when at least one pair has a visible catchable second departure. */
  hasMatch: boolean;
}

function parseEta(iso: string): number {
  return new Date(iso).getTime();
}

function addMinutes(iso: string, minutes: number): string {
  const d = new Date(parseEta(iso) + minutes * 60_000);
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
}): TransferResult {
  const { leg1, leg2, walkMinutes, bufferMinutes } = params;
  const pairs: TransferPair[] = [];

  for (const e1 of leg1.etas) {
    const readyAt = addMinutes(e1.eta, walkMinutes + bufferMinutes);
    const readyMs = parseEta(readyAt);

    const candidates = leg2.etas
      .filter((e2) => parseEta(e2.eta) >= readyMs)
      .sort((a, b) => a.eta.localeCompare(b.eta));

    const best = candidates[0];
    if (!best) {
      pairs.push({
        leg1Eta: e1.eta,
        leg2Eta: null,
        readyAt,
        waitMinutes: null,
        gapMinutes: null,
        status: "outside_visible_eta",
        statusTc: "目前可見班次未能配對，稍後再查",
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

  const matched = pairs.filter((p) => p.status !== "outside_visible_eta");
  const hasMatch = matched.length > 0;
  let summaryTc: string;
  if (!leg1.etas.length) {
    summaryTc = "第一程暫時未有可見 ETA（唔代表已收車）。";
  } else if (!leg2.etas.length) {
    summaryTc = "第二程暫時未有可見 ETA（唔代表已收車或無法轉乘）。";
  } else if (!hasMatch) {
    summaryTc = "目前可見第二程班次未能配對；稍後可能有更遲班次。";
  } else {
    const best = matched.reduce((a, b) =>
      (a.waitMinutes ?? Infinity) < (b.waitMinutes ?? Infinity) ? a : b,
    );
    summaryTc = `有 ${matched.length} 個可見時間兼容組合；落地後約仲有 ${best.waitMinutes} 分鐘等第二程（估算）。`;
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
