export type Company = "KMB" | "CTB";

export type Bound = "O" | "I";

export interface RouteOption {
  co: Company;
  route: string;
  bound: Bound;
  serviceType: string;
  origTc: string;
  destTc: string;
  origEn: string;
  destEn: string;
  labelTc: string;
}

export interface StopInfo {
  stopId: string;
  seq: number;
  nameTc: string;
  nameEn: string;
  lat: number;
  long: number;
}

export interface EtaItem {
  eta: string;
  etaSeq: number;
  destTc: string;
  rmkTc: string;
}

import ctbStopFile from "../data/ctb-stops.json";

type CtbStopRow = readonly [string, string, number, number];
const ctbStops = ctbStopFile.stops as unknown as Record<string, CtbStopRow>;

const KMB = "https://data.etabus.gov.hk/v1/transport/kmb";
const CTB = "https://rt.data.gov.hk/v2/transport/citybus";

type StopPlace = { nameTc: string; nameEn: string; lat: number; long: number };
type StopDirectory = Map<string, StopPlace>;

/**
 * Workers Free, Bundled, and temporary preview accounts allow 50 external
 * subrequests per invocation. Stay under that; `limits.subrequests` cannot raise it.
 */
const SUBREQUEST_SAFE_LIMIT = 40;

export class SubrequestBudget {
  readonly limit: number;
  private left: number;
  /** Same-request dedupe. Do not share this promise across invocations. */
  kmbDir: Promise<StopDirectory> | null = null;

  constructor(limit = SUBREQUEST_SAFE_LIMIT) {
    this.limit = limit;
    this.left = limit;
  }

  get remaining() {
    return this.left;
  }

  get used() {
    return this.limit - this.left;
  }

  charge(n = 1) {
    if (this.left < n) {
      throw new Error("今次搜尋要查太多班次，請改行少啲站或者轉最少步行再試。");
    }
    this.left -= n;
  }
}

let kmbStopDir: StopDirectory | null = null;
let kmbStopDirAt = 0;
const ctbStopCache = new Map<string, StopPlace>();

function ctbFromSnapshot(stopId: string): StopPlace | null {
  const row = ctbStops[stopId];
  if (!row) return null;
  return {
    nameTc: String(row[0]),
    nameEn: String(row[1]),
    lat: Number(row[2]),
    long: Number(row[3]),
  };
}

async function getJson<T>(url: string, budget?: SubrequestBudget): Promise<T> {
  budget?.charge();
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`上游失敗 ${res.status}: ${url}`);
  }
  return (await res.json()) as T;
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

export async function getStop(
  co: Company,
  stopId: string,
  budget?: SubrequestBudget,
): Promise<StopPlace> {
  if (co === "KMB") {
    const dir = await getKmbStopDirectory(budget);
    const stop = dir.get(stopId);
    if (!stop) throw new Error(`搵唔到 KMB 車站 ${stopId}`);
    return stop;
  }
  const stop = await getCtbStop(stopId, budget);
  if (!stop) throw new Error(`搵唔到城巴車站 ${stopId}`);
  return stop;
}

async function getKmbStopDirectory(budget?: SubrequestBudget): Promise<StopDirectory> {
  const fresh = Date.now() - kmbStopDirAt < 6 * 60 * 60 * 1000;
  if (kmbStopDir && fresh) return kmbStopDir;
  if (budget?.kmbDir) return budget.kmbDir;

  const loading = (async () => {
    type Row = { stop: string; name_tc: string; name_en: string; lat: string; long: string };
    const json = await getJson<{ data: Row[] }>(`${KMB}/stop`, budget);
    const map: StopDirectory = new Map();
    for (const row of json.data) {
      map.set(row.stop, {
        nameTc: row.name_tc,
        nameEn: row.name_en,
        lat: Number(row.lat),
        long: Number(row.long),
      });
    }
    kmbStopDir = map;
    kmbStopDirAt = Date.now();
    return map;
  })();

  if (budget) budget.kmbDir = loading;
  return loading;
}

function peekCtbStop(stopId: string): StopPlace | null {
  return ctbFromSnapshot(stopId) ?? ctbStopCache.get(stopId) ?? null;
}

async function getCtbStop(stopId: string, budget?: SubrequestBudget): Promise<StopPlace | null> {
  const known = peekCtbStop(stopId);
  if (known) return known;
  if (budget && budget.remaining < 1) return null;
  const stop = await getJson<{
    data: { stop: string; name_tc: string; name_en: string; lat: string; long: string };
  }>(`${CTB}/stop/${encodeURIComponent(stopId)}`, budget);
  const value = {
    nameTc: stop.data.name_tc,
    nameEn: stop.data.name_en,
    lat: Number(stop.data.lat),
    long: Number(stop.data.long),
  };
  ctbStopCache.set(stopId, value);
  return value;
}

function boundToKmbDir(bound: Bound): "outbound" | "inbound" {
  return bound === "O" ? "outbound" : "inbound";
}

function boundToCtbDir(bound: Bound): "outbound" | "inbound" {
  return bound === "O" ? "outbound" : "inbound";
}

const ROUTE_TTL_MS = 60 * 60 * 1000;

type KmbRouteRow = {
  route: string;
  bound: Bound;
  service_type: string;
  orig_tc: string;
  dest_tc: string;
  orig_en: string;
  dest_en: string;
};

type CtbRouteRow = {
  route: string;
  orig_tc: string;
  dest_tc: string;
  orig_en: string;
  dest_en: string;
};

let kmbRoutesCache: { at: number; rows: KmbRouteRow[] } | null = null;
let ctbRoutesCache: { at: number; rows: CtbRouteRow[] } | null = null;

async function loadKmbRouteRows(): Promise<KmbRouteRow[]> {
  if (kmbRoutesCache && Date.now() - kmbRoutesCache.at < ROUTE_TTL_MS) return kmbRoutesCache.rows;
  const json = await getJson<{ data: KmbRouteRow[] }>(`${KMB}/route/`);
  kmbRoutesCache = { at: Date.now(), rows: json.data };
  return json.data;
}

async function loadCtbRouteRows(): Promise<CtbRouteRow[]> {
  if (ctbRoutesCache && Date.now() - ctbRoutesCache.at < ROUTE_TTL_MS) return ctbRoutesCache.rows;
  const json = await getJson<{ data: CtbRouteRow[] }>(`${CTB}/route/CTB`);
  ctbRoutesCache = { at: Date.now(), rows: json.data };
  return json.data;
}

function kmbOption(row: KmbRouteRow): RouteOption {
  return {
    co: "KMB",
    route: row.route,
    bound: row.bound,
    serviceType: String(row.service_type),
    origTc: row.orig_tc,
    destTc: row.dest_tc,
    origEn: row.orig_en,
    destEn: row.dest_en,
    labelTc: `${row.route}｜${row.orig_tc} → ${row.dest_tc}${row.service_type !== "1" ? `（特${row.service_type}）` : ""}`,
  };
}

function ctbOptions(row: CtbRouteRow): RouteOption[] {
  return (["O", "I"] as Bound[]).map((bound) => {
    const origTc = bound === "O" ? row.orig_tc : row.dest_tc;
    const destTc = bound === "O" ? row.dest_tc : row.orig_tc;
    const origEn = bound === "O" ? row.orig_en : row.dest_en;
    const destEn = bound === "O" ? row.dest_en : row.orig_en;
    return {
      co: "CTB" as const,
      route: row.route,
      bound,
      serviceType: "1",
      origTc,
      destTc,
      origEn,
      destEn,
      labelTc: `${row.route}｜${origTc} → ${destTc}`,
    };
  });
}

export async function listRoutes(co: Company, query = ""): Promise<RouteOption[]> {
  const q = query.trim().toUpperCase();

  if (co === "KMB") {
    const rows = await loadKmbRouteRows();
    return rows
      .filter((r) => !q || r.route.toUpperCase().includes(q))
      .map(kmbOption)
      .sort((a, b) => a.route.localeCompare(b.route, "en", { numeric: true }));
  }

  const rows = await loadCtbRouteRows();
  const options: RouteOption[] = [];
  for (const row of rows) {
    if (q && !row.route.toUpperCase().includes(q)) continue;
    options.push(...ctbOptions(row));
  }
  return options.sort((a, b) => a.route.localeCompare(b.route, "en", { numeric: true }));
}

function routeMatchRank(route: string, query: string): number {
  const value = route.toUpperCase();
  if (value === query) return 0;
  if (value.startsWith(query)) return 1;
  return 2;
}

/** Both companies, exact route first, capped for a search box. */
export async function searchRoutes(query: string, limit = 8): Promise<RouteOption[]> {
  const q = query.trim().toUpperCase();
  if (!q) return [];
  const cap = Math.min(Math.max(Math.round(limit) || 8, 1), 12);
  const [kmbRows, ctbRows] = await Promise.all([loadKmbRouteRows(), loadCtbRouteRows()]);
  const options: RouteOption[] = [];
  for (const row of kmbRows) {
    if (routeMatchRank(row.route, q) > 1) continue;
    options.push(kmbOption(row));
  }
  for (const row of ctbRows) {
    if (routeMatchRank(row.route, q) > 1) continue;
    options.push(...ctbOptions(row));
  }
  options.sort((a, b) => {
    const rank = routeMatchRank(a.route, q) - routeMatchRank(b.route, q);
    if (rank) return rank;
    const length = a.route.length - b.route.length;
    if (length) return length;
    const numeric = a.route.localeCompare(b.route, "en", { numeric: true });
    if (numeric) return numeric;
    const service = Number(a.serviceType) - Number(b.serviceType);
    if (service) return service;
    return a.destTc.localeCompare(b.destTc, "zh-Hant");
  });
  return options.slice(0, cap);
}

function unresolvedStop(stopId: string, seq: number): StopInfo {
  return {
    stopId,
    seq,
    nameTc: stopId,
    nameEn: stopId,
    lat: Number.NaN,
    long: Number.NaN,
  };
}

export async function listRouteStops(
  co: Company,
  route: string,
  bound: Bound,
  serviceType = "1",
  budget?: SubrequestBudget,
): Promise<StopInfo[]> {
  if (co === "KMB") {
    type Row = { stop: string; seq: string };
    const [json, dir] = await Promise.all([
      getJson<{ data: Row[] }>(
        `${KMB}/route-stop/${encodeURIComponent(route)}/${boundToKmbDir(bound)}/${encodeURIComponent(serviceType)}`,
        budget,
      ),
      getKmbStopDirectory(budget),
    ]);
    return json.data
      .map((row) => {
        const stop = dir.get(row.stop);
        return {
          stopId: row.stop,
          seq: Number(row.seq),
          nameTc: stop?.nameTc ?? row.stop,
          nameEn: stop?.nameEn ?? row.stop,
          lat: stop?.lat ?? Number.NaN,
          long: stop?.long ?? Number.NaN,
        } satisfies StopInfo;
      })
      .sort((a, b) => a.seq - b.seq);
  }

  type Row = { stop: string; seq: number };
  const json = await getJson<{ data: Row[] }>(
    `${CTB}/route-stop/CTB/${encodeURIComponent(route)}/${boundToCtbDir(bound)}`,
    budget,
  );
  const rows = [...json.data].sort((a, b) => Number(a.seq) - Number(b.seq));
  const stops = new Array<StopInfo>(rows.length);
  const missing: number[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const known = peekCtbStop(row.stop);
    if (known) {
      stops[i] = {
        stopId: row.stop,
        seq: Number(row.seq),
        nameTc: known.nameTc,
        nameEn: known.nameEn,
        lat: known.lat,
        long: known.long,
      };
    } else {
      missing.push(i);
    }
  }
  // Workers allow 6 simultaneous connections. Snapshot hits do not fetch.
  await mapPool(missing, 6, async (index) => {
    const row = rows[index];
    const stop = await getCtbStop(row.stop, budget);
    stops[index] = stop
      ? {
          stopId: row.stop,
          seq: Number(row.seq),
          nameTc: stop.nameTc,
          nameEn: stop.nameEn,
          lat: stop.lat,
          long: stop.long,
        }
      : unresolvedStop(row.stop, Number(row.seq));
  });
  return stops;
}

export async function listEtas(
  co: Company,
  route: string,
  stopId: string,
  serviceType = "1",
  budget?: SubrequestBudget,
): Promise<EtaItem[]> {
  if (co === "KMB") {
    type Row = {
      eta: string | null;
      eta_seq: number;
      dest_tc: string;
      rmk_tc: string;
    };
    const json = await getJson<{ data: Row[] }>(
      `${KMB}/eta/${encodeURIComponent(stopId)}/${encodeURIComponent(route)}/${encodeURIComponent(serviceType)}`,
      budget,
    );
    return json.data
      .filter((r) => !!r.eta)
      .map((r) => ({
        eta: r.eta as string,
        etaSeq: r.eta_seq,
        destTc: r.dest_tc,
        rmkTc: r.rmk_tc || "",
      }))
      .sort((a, b) => a.eta.localeCompare(b.eta));
  }

  type Row = {
    eta: string | null;
    eta_seq: number;
    dest_tc: string;
    rmk_tc: string;
  };
  const json = await getJson<{ data: Row[] }>(
    `${CTB}/eta/CTB/${encodeURIComponent(stopId)}/${encodeURIComponent(route)}`,
    budget,
  );
  return json.data
    .filter((r) => !!r.eta)
    .map((r) => ({
      eta: r.eta as string,
      etaSeq: r.eta_seq,
      destTc: r.dest_tc,
      rmkTc: r.rmk_tc || "",
    }))
    .sort((a, b) => a.eta.localeCompare(b.eta));
}

export function distanceMeters(
  a: { lat: number; long: number },
  b: { lat: number; long: number },
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const R = 6371000;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.long - a.long);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Rough walking minutes from lat/long (≈ 4.5 km/h). */
export function estimateWalkMinutes(
  a: { lat: number; long: number },
  b: { lat: number; long: number },
): number {
  const minutes = distanceMeters(a, b) / ((4.5 * 1000) / 60);
  return Math.max(1, Math.ceil(minutes));
}

export interface NearbyStop {
  co: Company;
  stopId: string;
  nameTc: string;
  nameEn: string;
  lat: number;
  long: number;
  meters: number;
  walkMinutes: number;
}

export async function findNearbyStops(params: {
  lat: number;
  long: number;
  limit?: number;
  maxMeters?: number;
}): Promise<NearbyStop[]> {
  const limit = Math.min(Math.max(params.limit ?? 12, 1), 40);
  const maxMeters = Math.min(Math.max(params.maxMeters ?? 900, 100), 3000);
  const origin = { lat: params.lat, long: params.long };

  // Citybus has no bulk stop catalogue in the open API, so nearby is KMB/LWB first.
  const dir = await getKmbStopDirectory();
  const ranked: NearbyStop[] = [];
  for (const [stopId, stop] of dir) {
    if (!Number.isFinite(stop.lat) || !Number.isFinite(stop.long)) continue;
    const meters = distanceMeters(origin, stop);
    if (meters > maxMeters) continue;
    ranked.push({
      co: "KMB",
      stopId,
      nameTc: stop.nameTc,
      nameEn: stop.nameEn,
      lat: stop.lat,
      long: stop.long,
      meters: Math.round(meters),
      walkMinutes: Math.max(1, Math.ceil(meters / ((4.5 * 1000) / 60))),
    });
  }

  ranked.sort((a, b) => a.meters - b.meters);
  return ranked.slice(0, limit);
}

export interface StopService {
  co: Company;
  route: string;
  bound: Bound;
  serviceType: string;
  destTc: string;
  nextEta: string | null;
}

export async function listStopServices(co: Company, stopId: string): Promise<StopService[]> {
  if (co !== "KMB") {
    throw new Error("附近站路線暫時只支援九巴／龍運");
  }

  type Row = {
    co: string;
    route: string;
    dir: Bound;
    service_type: number;
    dest_tc: string;
    eta: string | null;
    eta_seq: number;
  };
  const json = await getJson<{ data: Row[] }>(`${KMB}/stop-eta/${encodeURIComponent(stopId)}`);
  const best = new Map<string, StopService>();

  for (const row of json.data) {
    const key = `${row.route}|${row.dir}|${row.service_type}`;
    const existing = best.get(key);
    if (!existing) {
      best.set(key, {
        co: "KMB",
        route: row.route,
        bound: row.dir,
        serviceType: String(row.service_type),
        destTc: row.dest_tc,
        nextEta: row.eta,
      });
      continue;
    }
    if (row.eta && (!existing.nextEta || row.eta < existing.nextEta)) {
      existing.nextEta = row.eta;
    }
  }

  return [...best.values()].sort((a, b) =>
    a.route.localeCompare(b.route, "en", { numeric: true }),
  );
}
