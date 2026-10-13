import {
  estimateWalkMinutes,
  getStop,
  listEtas,
  listRouteStops,
  listRoutes,
  type Bound,
  type Company,
} from "./hk-transit";
import { matchTransfer } from "./transfer";

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
    return json({ ok: true, service: "hk-transfer-match", version: "0.1.0" });
  }

  if (request.method === "GET" && url.pathname === "/api/routes") {
    const co = asCompany(url.searchParams.get("co"));
    if (!co) return error("需要 co=KMB 或 CTB");
    const q = url.searchParams.get("q") ?? "";
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
