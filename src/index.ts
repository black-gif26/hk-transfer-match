import {
  estimateWalkMinutes,
  findNearbyStops,
  getStop,
  listEtas,
  listRouteStops,
  listRoutes,
  listStopServices,
  searchRoutes,
  type Bound,
  type Company,
} from "./hk-transit";
import { matchTransfer } from "./transfer";
import { planTransfer, resolveBoard1Context, type PlanMode } from "./transfer-plan";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function error(message: string, status = 400): Response {
  return json({ error: message }, status);
}

function asCompany(value: string | null): Company | null {
  if (value === "KMB" || value === "CTB") return value;
  return null;
}

function asBound(value: string | null): Bound | null {
  if (value === "O" || value === "I") return value;
  return null;
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      try {
        return await handleApi(request, url);
      } catch (err) {
        const message = err instanceof Error ? err.message : "未知錯誤";
        console.error(JSON.stringify({ level: "error", message }));
        return error(message, 502);
      }
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;

async function handleApi(request: Request, url: URL): Promise<Response> {
  if (request.method === "GET" && url.pathname === "/api/health") {
    return json({ ok: true, service: "hk-transfer-match", version: "0.3.1" });
  }

  if (request.method === "GET" && url.pathname === "/api/nearby") {
    const lat = Number(url.searchParams.get("lat"));
    const long = Number(url.searchParams.get("long") ?? url.searchParams.get("lng"));
    const limit = Number(url.searchParams.get("limit") ?? "12");
    const maxMeters = Number(url.searchParams.get("maxMeters") ?? "900");
    if (!Number.isFinite(lat) || !Number.isFinite(long)) {
      return error("需要 lat / long");
    }
    if (lat < 22.1 || lat > 22.6 || long < 113.8 || long > 114.5) {
      return error("位置似乎唔喺香港範圍");
    }
    const stops = await findNearbyStops({
      lat,
      long,
      limit: Number.isFinite(limit) ? limit : 12,
      maxMeters: Number.isFinite(maxMeters) ? maxMeters : 900,
    });
    return json({
      origin: { lat, long },
      stops,
      noteTc: "附近站暫時用九巴／龍運站庫（城巴未有完整公開站表）。",
    });
  }

  if (request.method === "GET" && url.pathname === "/api/stop-services") {
    const co = asCompany(url.searchParams.get("co")) ?? "KMB";
    const stopId = url.searchParams.get("stopId");
    if (!stopId) return error("需要 stopId");
    const services = await listStopServices(co, stopId);
    return json({ services });
  }

  if (request.method === "GET" && url.pathname === "/api/routes") {
    const co = asCompany(url.searchParams.get("co"));
    const q = url.searchParams.get("q") ?? "";
    if (!co) {
      const limit = Number(url.searchParams.get("limit") ?? "8");
      const routes = await searchRoutes(q, Number.isFinite(limit) ? limit : 8);
      return json({ routes });
    }
    const routes = await listRoutes(co, q);
    return json({ routes });
  }

  if (request.method === "GET" && url.pathname === "/api/stops") {
    const co = asCompany(url.searchParams.get("co"));
    const route = url.searchParams.get("route");
    const bound = asBound(url.searchParams.get("bound"));
    const serviceType = url.searchParams.get("serviceType") ?? "1";
    if (!co || !route || !bound) return error("需要 co、route、bound");
    const stops = await listRouteStops(co, route, bound, serviceType);
    return json({ stops });
  }

  if (request.method === "POST" && url.pathname === "/api/board1-departures") {
    const body = (await request.json()) as {
      origin?: { lat: number; long: number };
      leg1?: {
        co: Company;
        route: string;
        bound: Bound;
        serviceType?: string;
      };
      bufferMinutes?: number;
      preferredBoard1Eta?: string | null;
    };
    if (!body?.origin || !Number.isFinite(body.origin.lat) || !Number.isFinite(body.origin.long)) {
      return error("需要出發地 origin.lat / origin.long");
    }
    if (!body.leg1?.route || !body.leg1.bound || !body.leg1.co) {
      return error("需要第一程路線");
    }
    const ctx = await resolveBoard1Context({
      origin: body.origin,
      leg1: {
        co: body.leg1.co,
        route: body.leg1.route,
        bound: body.leg1.bound,
        serviceType: body.leg1.serviceType ?? "1",
      },
      bufferMinutes: body.bufferMinutes,
      preferredBoard1Eta: body.preferredBoard1Eta,
    });
    return json({
      board1: ctx.board1,
      board1Departures: ctx.board1Departures,
      board1EtaSource: ctx.board1EtaSource,
      noteTc: `會喺「${ctx.board1.nameTc}」上第一程（距出發地約 ${ctx.board1.metersFromOrigin}m / ${ctx.board1.walkMinutesFromOrigin} 分）。`,
    });
  }

  if (request.method === "POST" && url.pathname === "/api/plan-transfer") {
    const body = (await request.json()) as {
      origin?: { lat: number; long: number };
      leg1?: {
        co: Company;
        route: string;
        bound: Bound;
        serviceType?: string;
      };
      leg2?: {
        co: Company;
        route: string;
        bound: Bound;
        serviceType?: string;
      };
      mode?: PlanMode;
      maxTransferMeters?: number;
      bufferMinutes?: number;
      limit?: number;
      preferredBoard1Eta?: string | null;
    };

    if (!body?.origin || !Number.isFinite(body.origin.lat) || !Number.isFinite(body.origin.long)) {
      return error("需要出發地 origin.lat / origin.long");
    }
    if (!body.leg1?.route || !body.leg1.bound || !body.leg1.co) {
      return error("需要第一程路線");
    }
    if (!body.leg2?.route || !body.leg2.bound || !body.leg2.co) {
      return error("需要第二程路線");
    }
    const mode = body.mode ?? "shortest_walk";
    if (mode !== "shortest_walk" && mode !== "fastest" && mode !== "manual") {
      return error("mode 只可以係 shortest_walk / fastest / manual");
    }

    const plan = await planTransfer({
      origin: body.origin,
      leg1: {
        co: body.leg1.co,
        route: body.leg1.route,
        bound: body.leg1.bound,
        serviceType: body.leg1.serviceType ?? "1",
      },
      leg2: {
        co: body.leg2.co,
        route: body.leg2.route,
        bound: body.leg2.bound,
        serviceType: body.leg2.serviceType ?? "1",
      },
      mode,
      maxTransferMeters: body.maxTransferMeters,
      bufferMinutes: body.bufferMinutes,
      limit: body.limit,
      preferredBoard1Eta: body.preferredBoard1Eta,
    });
    return json(plan);
  }

  if (request.method === "POST" && url.pathname === "/api/match") {
    const body = (await request.json()) as {
      leg1: {
        co: Company;
        route: string;
        bound: Bound;
        serviceType?: string;
        stopId: string;
      };
      leg2: {
        co: Company;
        route: string;
        bound: Bound;
        serviceType?: string;
        stopId: string;
      };
      walkMinutes?: number | null;
      bufferMinutes?: number | null;
    };

    if (!body?.leg1?.stopId || !body?.leg2?.stopId) {
      return error("需要 leg1 / leg2 嘅 stopId");
    }

    const [stop1, stop2, etas1, etas2] = await Promise.all([
      getStop(body.leg1.co, body.leg1.stopId),
      getStop(body.leg2.co, body.leg2.stopId),
      listEtas(
        body.leg1.co,
        body.leg1.route,
        body.leg1.stopId,
        body.leg1.serviceType ?? "1",
      ),
      listEtas(
        body.leg2.co,
        body.leg2.route,
        body.leg2.stopId,
        body.leg2.serviceType ?? "1",
      ),
    ]);

    const estimatedWalk = estimateWalkMinutes(stop1, stop2);
    const walkMinutes =
      typeof body.walkMinutes === "number" && Number.isFinite(body.walkMinutes)
        ? Math.max(0, Math.round(body.walkMinutes))
        : estimatedWalk;
    const bufferMinutes =
      typeof body.bufferMinutes === "number" && Number.isFinite(body.bufferMinutes)
        ? Math.max(0, Math.round(body.bufferMinutes))
        : 1;

    const result = matchTransfer({
      leg1: {
        ...body.leg1,
        serviceType: body.leg1.serviceType ?? "1",
        stopNameTc: stop1.nameTc,
        etas: etas1,
      },
      leg2: {
        ...body.leg2,
        serviceType: body.leg2.serviceType ?? "1",
        stopNameTc: stop2.nameTc,
        etas: etas2,
      },
      walkMinutes,
      bufferMinutes,
    });

    return json({
      ...result,
      estimatedWalkMinutes: estimatedWalk,
      distanceHintTc: `兩站直線估算步行約 ${estimatedWalk} 分鐘（可人手改）`,
    });
  }

  return error("未知 API", 404);
}
