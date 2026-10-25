import { isValidStopCoord } from "./validate";

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
  /** Stop occurrence on the selected route/direction (1-based seq from operator). */
  seq: number;
  nameTc: string;
  nameEn: string;
  lat: number;
  long: number;
  /** False when coordinates are missing/invalid — exclude from distance math. */
  hasValidCoord: boolean;
}

export interface EtaItem {
  eta: string;
  etaSeq: number;
  destTc: string;
  rmkTc: string;
  /** Operator `dir` when present (O/I). */
  dir: Bound | null;
  /** Operator stop sequence when present. */
  seq: number | null;
  dataTimestamp: string | null;
}

const KMB = "https://data.etabus.gov.hk/v1/transport/kmb";
const CTB = "https://rt.data.gov.hk/v2/transport/citybus";

const REQUEST_TIMEOUT_MS = 12_000;
const META_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const META_CACHE_MAX_CTB_STOPS = 4_000;

type StopDirectory = Map<
  string,
  { nameTc: string; nameEn: string; lat: number; long: number; hasValidCoord: boolean }
>;

let kmbStopDir: StopDirectory | null = null;
let kmbStopDirAt = 0;
let kmbStopDirInflight: Promise<StopDirectory> | null = null;

const ctbStopCache = new Map<
  string,
  { nameTc: string; nameEn: string; lat: number; long: number; hasValidCoord: boolean; at: number }
>();
const ctbStopInflight = new Map<
  string,
  Promise<{ nameTc: string; nameEn: string; lat: number; long: number; hasValidCoord: boolean }>
>();

/** Request-scoped dedupe for identical in-flight GETs (including ETA). */
const inflightGet = new Map<string, Promise<unknown>>();

export class UpstreamError extends Error {
  readonly status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.name = "UpstreamError";
    this.status = status;
  }
}

export class UpstreamSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpstreamSchemaError";
  }
}

function parseCoordPair(latRaw: unknown, longRaw: unknown): {
  lat: number;
  long: number;
  hasValidCoord: boolean;
} {
  const lat = Number(latRaw);
  const long = Number(longRaw);
  if (!isValidStopCoord(lat, long)) {
    return { lat: Number.NaN, long: Number.NaN, hasValidCoord: false };
  }
  return { lat, long, hasValidCoord: true };
}

async function getJson<T>(url: string): Promise<T> {
  const existing = inflightGet.get(url);
  if (existing) return existing as Promise<T>;

  const promise = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new UpstreamError(`上游資料暫時無法讀取（${res.status}）`, 502);
      }
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        throw new UpstreamSchemaError("上游回應格式無效");
      }
      return body as T;
    } catch (err) {
      if (err instanceof UpstreamError || err instanceof UpstreamSchemaError) throw err;
      if (err instanceof Error && err.name === "AbortError") {
        throw new UpstreamError("上游請求逾時", 504);
      }
      throw new UpstreamError("上游資料暫時無法讀取", 502);
    } finally {
      clearTimeout(timer);
      inflightGet.delete(url);
    }
  })();

  inflightGet.set(url, promise);
  return promise;
}

/** Test helper: clear caches between unit tests. */
export function __resetTransitCachesForTests(): void {
  kmbStopDir = null;
  kmbStopDirAt = 0;
  kmbStopDirInflight = null;
  ctbStopCache.clear();
  ctbStopInflight.clear();
  inflightGet.clear();
}

export async function getStop(
  co: Company,
  stopId: string,
): Promise<{ nameTc: string; nameEn: string; lat: number; long: number; hasValidCoord: boolean }> {
  if (co === "KMB") {
    const dir = await getKmbStopDirectory();
    const stop = dir.get(stopId);
    if (!stop) throw new UpstreamError(`搵唔到 KMB 車站`, 404);
    return stop;
  }
  return getCtbStop(stopId);
}

async function getKmbStopDirectory(): Promise<StopDirectory> {
  const fresh = Date.now() - kmbStopDirAt < META_CACHE_TTL_MS;
  if (kmbStopDir && fresh) return kmbStopDir;
  if (kmbStopDirInflight) return kmbStopDirInflight;

  kmbStopDirInflight = (async () => {
    type Row = { stop: string; name_tc: string; name_en: string; lat: string; long: string };
    const json = await getJson<{ data: Row[] }>(`${KMB}/stop`);
    if (!json || !Array.isArray(json.data)) {
      throw new UpstreamSchemaError("KMB 站表格式無效");
    }
    const map: StopDirectory = new Map();
    for (const row of json.data) {
      if (!row?.stop) continue;
      const coords = parseCoordPair(row.lat, row.long);
      map.set(row.stop, {
        nameTc: row.name_tc ?? row.stop,
        nameEn: row.name_en ?? row.stop,
        lat: coords.lat,
        long: coords.long,
        hasValidCoord: coords.hasValidCoord,
      });
    }
    kmbStopDir = map;
    kmbStopDirAt = Date.now();
    return map;
  })();

  try {
    return await kmbStopDirInflight;
  } finally {
    kmbStopDirInflight = null;
  }
}

async function getCtbStop(stopId: string) {
  const cached = ctbStopCache.get(stopId);
  if (cached && Date.now() - cached.at < META_CACHE_TTL_MS) {
    return {
      nameTc: cached.nameTc,
      nameEn: cached.nameEn,
      lat: cached.lat,
      long: cached.long,
      hasValidCoord: cached.hasValidCoord,
    };
  }

  const inflight = ctbStopInflight.get(stopId);
  if (inflight) return inflight;

  const promise = (async () => {
    const stop = await getJson<{
      data: { stop: string; name_tc: string; name_en: string; lat: string; long: string };
    }>(`${CTB}/stop/${encodeURIComponent(stopId)}`);
    if (!stop?.data) throw new UpstreamSchemaError("城巴車站格式無效");
    const coords = parseCoordPair(stop.data.lat, stop.data.long);
    const value = {
      nameTc: stop.data.name_tc ?? stopId,
      nameEn: stop.data.name_en ?? stopId,
      lat: coords.lat,
      long: coords.long,
      hasValidCoord: coords.hasValidCoord,
    };
    if (ctbStopCache.size >= META_CACHE_MAX_CTB_STOPS) {
      const first = ctbStopCache.keys().next().value;
      if (first != null) ctbStopCache.delete(first);
    }
    ctbStopCache.set(stopId, { ...value, at: Date.now() });
    return value;
  })();

  ctbStopInflight.set(stopId, promise);
  try {
    return await promise;
  } finally {
    ctbStopInflight.delete(stopId);
  }
}

async function mapPool<T, R>(items: T[], concurrency: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

function boundToKmbDir(bound: Bound): "outbound" | "inbound" {
  return bound === "O" ? "outbound" : "inbound";
}

function boundToCtbDir(bound: Bound): "outbound" | "inbound" {
  return bound === "O" ? "outbound" : "inbound";
}

function asBoundField(value: unknown): Bound | null {
  return value === "O" || value === "I" ? value : null;
}

export async function listRoutes(co: Company, query = ""): Promise<RouteOption[]> {
  const q = query.trim().toUpperCase();

  if (co === "KMB") {
    type Row = {
      route: string;
      bound: Bound;
      service_type: string;
      orig_tc: string;
      dest_tc: string;
      orig_en: string;
      dest_en: string;
    };
    const json = await getJson<{ data: Row[] }>(`${KMB}/route/`);
    if (!json || !Array.isArray(json.data)) throw new UpstreamSchemaError("KMB 路線格式無效");
    return json.data
      .filter((r) => !q || r.route.toUpperCase().includes(q) || r.route.toUpperCase() === q)
      .map((r) => ({
        co: "KMB" as const,
        route: r.route,
        bound: r.bound,
        serviceType: String(r.service_type),
        origTc: r.orig_tc,
        destTc: r.dest_tc,
        origEn: r.orig_en,
        destEn: r.dest_en,
        labelTc: `${r.route}｜${r.orig_tc} → ${r.dest_tc}${r.service_type !== "1" ? `（特${r.service_type}）` : ""}`,
      }))
      .sort((a, b) => a.route.localeCompare(b.route, "en", { numeric: true }));
  }

  type CtbRoute = {
    route: string;
    orig_tc: string;
    dest_tc: string;
    orig_en: string;
    dest_en: string;
  };
  const json = await getJson<{ data: CtbRoute[] }>(`${CTB}/route/CTB`);
  if (!json || !Array.isArray(json.data)) throw new UpstreamSchemaError("城巴路線格式無效");
  const filtered = json.data.filter(
    (r) => !q || r.route.toUpperCase().includes(q) || r.route.toUpperCase() === q,
  );

  const options: RouteOption[] = [];
  for (const r of filtered) {
    for (const bound of ["O", "I"] as Bound[]) {
      const origTc = bound === "O" ? r.orig_tc : r.dest_tc;
      const destTc = bound === "O" ? r.dest_tc : r.orig_tc;
      const origEn = bound === "O" ? r.orig_en : r.dest_en;
      const destEn = bound === "O" ? r.dest_en : r.orig_en;
      options.push({
        co: "CTB",
        route: r.route,
        bound,
        serviceType: "1",
        origTc,
        destTc,
        origEn,
        destEn,
        labelTc: `${r.route}｜${origTc} → ${destTc}`,
      });
    }
  }
  return options.sort((a, b) => a.route.localeCompare(b.route, "en", { numeric: true }));
}

export async function listRouteStops(
  co: Company,
  route: string,
  bound: Bound,
  serviceType = "1",
): Promise<StopInfo[]> {
  if (co === "KMB") {
    type Row = { stop: string; seq: string };
    const [json, dir] = await Promise.all([
      getJson<{ data: Row[] }>(
        `${KMB}/route-stop/${encodeURIComponent(route)}/${boundToKmbDir(bound)}/${encodeURIComponent(serviceType)}`,
      ),
      getKmbStopDirectory(),
    ]);
    if (!json || !Array.isArray(json.data)) throw new UpstreamSchemaError("KMB 站序格式無效");
    return json.data
      .map((row) => {
        const stop = dir.get(row.stop);
        const coords = stop
          ? { lat: stop.lat, long: stop.long, hasValidCoord: stop.hasValidCoord }
          : { lat: Number.NaN, long: Number.NaN, hasValidCoord: false };
        return {
          stopId: row.stop,
          seq: Number(row.seq),
          nameTc: stop?.nameTc ?? row.stop,
          nameEn: stop?.nameEn ?? row.stop,
          lat: coords.lat,
          long: coords.long,
          hasValidCoord: coords.hasValidCoord,
        } satisfies StopInfo;
      })
      .sort((a, b) => a.seq - b.seq);
  }

  type Row = { stop: string; seq: number };
  const json = await getJson<{ data: Row[] }>(
    `${CTB}/route-stop/CTB/${encodeURIComponent(route)}/${boundToCtbDir(bound)}`,
  );
  if (!json || !Array.isArray(json.data)) throw new UpstreamSchemaError("城巴站序格式無效");

  const stops = await mapPool(json.data, 8, async (row) => {
    const stop = await getCtbStop(row.stop);
    return {
      stopId: row.stop,
      seq: Number(row.seq),
      nameTc: stop.nameTc,
      nameEn: stop.nameEn,
      lat: stop.lat,
      long: stop.long,
      hasValidCoord: stop.hasValidCoord,
    } satisfies StopInfo;
  });
  return stops.sort((a, b) => a.seq - b.seq);
}

/**
 * List live ETAs for a stop/route.
 * When `bound` is provided and upstream rows include `dir`, filter to that direction.
 * `stopSeq` (when provided) further filters repeated stop occurrences if upstream `seq` is present.
 */
export async function listEtas(
  co: Company,
  route: string,
  stopId: string,
  serviceType = "1",
  options?: { bound?: Bound; stopSeq?: number },
): Promise<EtaItem[]> {
  const bound = options?.bound;
  const stopSeq = options?.stopSeq;

  if (co === "KMB") {
    type Row = {
      eta: string | null;
      eta_seq: number;
      dest_tc: string;
      rmk_tc: string;
      dir?: string;
      seq?: number;
      data_timestamp?: string;
    };
    const json = await getJson<{ data: Row[] }>(
      `${KMB}/eta/${encodeURIComponent(stopId)}/${encodeURIComponent(route)}/${encodeURIComponent(serviceType)}`,
    );
    if (!json || !Array.isArray(json.data)) throw new UpstreamSchemaError("KMB ETA 格式無效");
    return mapEtaRows(json.data, bound, stopSeq);
  }

  type Row = {
    eta: string | null;
    eta_seq: number;
    dest_tc: string;
    rmk_tc: string;
    dir?: string;
    seq?: number;
    data_timestamp?: string;
  };
  const json = await getJson<{ data: Row[] }>(
    `${CTB}/eta/CTB/${encodeURIComponent(stopId)}/${encodeURIComponent(route)}`,
  );
  if (!json || !Array.isArray(json.data)) throw new UpstreamSchemaError("城巴 ETA 格式無效");
  return mapEtaRows(json.data, bound, stopSeq);
}

function mapEtaRows(
  rows: Array<{
    eta: string | null;
    eta_seq: number;
    dest_tc: string;
    rmk_tc: string;
    dir?: string;
    seq?: number;
    data_timestamp?: string;
  }>,
  bound?: Bound,
  stopSeq?: number,
): EtaItem[] {
  return rows
    .filter((r) => !!r.eta)
    .filter((r) => {
      if (!bound) return true;
      const dir = asBoundField(r.dir);
      // If upstream omits dir, keep the row but do not pretend we filtered.
      if (dir == null) return true;
      return dir === bound;
    })
    .filter((r) => {
      if (stopSeq == null) return true;
      if (r.seq == null || !Number.isFinite(Number(r.seq))) return true;
      return Number(r.seq) === stopSeq;
    })
    .map((r) => ({
      eta: r.eta as string,
      etaSeq: r.eta_seq,
      destTc: r.dest_tc,
      rmkTc: r.rmk_tc || "",
      dir: asBoundField(r.dir),
      seq: r.seq != null && Number.isFinite(Number(r.seq)) ? Number(r.seq) : null,
      dataTimestamp: r.data_timestamp ?? null,
    }))
    .sort((a, b) => a.eta.localeCompare(b.eta));
}

export function distanceMeters(
  a: { lat: number; long: number },
  b: { lat: number; long: number },
): number {
  if (!isValidStopCoord(a.lat, a.long) || !isValidStopCoord(b.lat, b.long)) {
    return Number.NaN;
  }
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

/** Rough walking minutes from lat/long (≈ 4.5 km/h). Straight-line only. */
export function estimateWalkMinutes(
  a: { lat: number; long: number },
  b: { lat: number; long: number },
): number {
  const meters = distanceMeters(a, b);
  if (!Number.isFinite(meters)) return Number.NaN;
  const minutes = meters / ((4.5 * 1000) / 60);
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

  const dir = await getKmbStopDirectory();
  const ranked: NearbyStop[] = [];
  for (const [stopId, stop] of dir) {
    if (!stop.hasValidCoord) continue;
    const meters = distanceMeters(origin, stop);
    if (!Number.isFinite(meters) || meters > maxMeters) continue;
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
    throw new UpstreamError("附近站路線暫時只支援九巴／龍運", 400);
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
  if (!json || !Array.isArray(json.data)) throw new UpstreamSchemaError("KMB 站 ETA 格式無效");
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

/** Occurrence key: stopId + route seq (handles repeated visits). */
export function stopOccurrenceKey(stop: Pick<StopInfo, "stopId" | "seq">): string {
  return `${stop.stopId}#${stop.seq}`;
}
