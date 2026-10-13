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

const KMB = "https://data.etabus.gov.hk/v1/transport/kmb";
const CTB = "https://rt.data.gov.hk/v2/transport/citybus";

type StopDirectory = Map<string, { nameTc: string; nameEn: string; lat: number; long: number }>;

let kmbStopDir: StopDirectory | null = null;
let kmbStopDirAt = 0;
const ctbStopCache = new Map<string, { nameTc: string; nameEn: string; lat: number; long: number }>();

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`上游失敗 ${res.status}: ${url}`);
  }
  return (await res.json()) as T;
}

export async function getStop(
  co: Company,
  stopId: string,
): Promise<{ nameTc: string; nameEn: string; lat: number; long: number }> {
  if (co === "KMB") {
    const dir = await getKmbStopDirectory();
    const stop = dir.get(stopId);
    if (!stop) throw new Error(`搵唔到 KMB 車站 ${stopId}`);
    return stop;
  }
  return getCtbStop(stopId);
}

async function getKmbStopDirectory(): Promise<StopDirectory> {
  const fresh = Date.now() - kmbStopDirAt < 6 * 60 * 60 * 1000;
  if (kmbStopDir && fresh) return kmbStopDir;

  type Row = { stop: string; name_tc: string; name_en: string; lat: string; long: string };
  const json = await getJson<{ data: Row[] }>(`${KMB}/stop`);
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
}

async function getCtbStop(stopId: string) {
  const cached = ctbStopCache.get(stopId);
  if (cached) return cached;
  const stop = await getJson<{
    data: { stop: string; name_tc: string; name_en: string; lat: string; long: string };
  }>(`${CTB}/stop/${stopId}`);
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
    return json.data
      .map((row) => {
        const stop = dir.get(row.stop);
        return {
          stopId: row.stop,
          seq: Number(row.seq),
          nameTc: stop?.nameTc ?? row.stop,
          nameEn: stop?.nameEn ?? row.stop,
          lat: stop?.lat ?? 0,
          long: stop?.long ?? 0,
        } satisfies StopInfo;
      })
      .sort((a, b) => a.seq - b.seq);
  }

  type Row = { stop: string; seq: number };
  const json = await getJson<{ data: Row[] }>(
    `${CTB}/route-stop/CTB/${encodeURIComponent(route)}/${boundToCtbDir(bound)}`,
  );
  const stops = await Promise.all(
    json.data.map(async (row) => {
      const stop = await getCtbStop(row.stop);
      return {
        stopId: row.stop,
        seq: Number(row.seq),
        nameTc: stop.nameTc,
        nameEn: stop.nameEn,
        lat: stop.lat,
        long: stop.long,
      } satisfies StopInfo;
    }),
  );
  return stops.sort((a, b) => a.seq - b.seq);
}

export async function listEtas(
  co: Company,
  route: string,
  stopId: string,
  serviceType = "1",
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

/** Rough walking minutes from lat/long (≈ 4.5 km/h). */
export function estimateWalkMinutes(
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
  const meters = 2 * R * Math.asin(Math.sqrt(h));
  const minutes = meters / ((4.5 * 1000) / 60);
  return Math.max(1, Math.ceil(minutes));
}
