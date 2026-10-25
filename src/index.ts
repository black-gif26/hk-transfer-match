import {
  estimateWalkMinutes,
  findNearbyStops,
  getStop,
  listEtas,
  listRouteStops,
  listRoutes,
  listStopServices,
  UpstreamError,
  UpstreamSchemaError,
} from "./hk-transit";
import { matchTransfer } from "./transfer";
import {
  planTransfer,
  refreshCandidateTiming,
  resolveBoard1Context,
} from "./transfer-plan";
import {
  ValidationError,
  isPlanMode,
  optionalEtaIso,
  optionalFiniteNumber,
  parseBoardingInput,
  parseJsonBody,
  parseRouteLeg,
  requireCompany,
  requireBound,
  requireHkCoord,
  requireNonEmptyString,
} from "./validate";

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

async function readJson(request: Request): Promise<Record<string, unknown>> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw new ValidationError("請求 JSON 格式唔正確");
  }
  return parseJsonBody(raw);
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      try {
        return await handleApi(request, url);
      } catch (err) {
        if (err instanceof ValidationError) {
          return error(err.message, 400);
        }
        if (err instanceof UpstreamError) {
          console.error(JSON.stringify({ level: "error", kind: "upstream", message: err.message }));
          return error(err.message, err.status);
        }
        if (err instanceof UpstreamSchemaError) {
          console.error(JSON.stringify({ level: "error", kind: "schema", message: err.message }));
          return error("上游資料格式異常", 502);
        }
        const message = err instanceof Error ? err.message : "未知錯誤";
        console.error(JSON.stringify({ level: "error", message }));
        // Application-level errors (missing stops etc.) stay user-facing without internals.
        const status = message.includes("需要") || message.includes("未有") ? 400 : 502;
        return error(message, status);
      }
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;

async function handleApi(request: Request, url: URL): Promise<Response> {
  if (request.method === "GET" && url.pathname === "/api/health") {
    return json({ ok: true, service: "hk-transfer-match", version: "0.3.0" });
  }

  if (request.method === "GET" && url.pathname === "/api/nearby") {
    const lat = Number(url.searchParams.get("lat"));
    const long = Number(url.searchParams.get("long") ?? url.searchParams.get("lng"));
    const limit = Number(url.searchParams.get("limit") ?? "12");
    const maxMeters = Number(url.searchParams.get("maxMeters") ?? "900");
    const origin = requireHkCoord(lat, long);
    const stops = await findNearbyStops({
      lat: origin.lat,
      long: origin.long,
      limit: Number.isFinite(limit) ? limit : 12,
      maxMeters: Number.isFinite(maxMeters) ? maxMeters : 900,
    });
    return json({
      origin,
      stops,
      noteTc: "附近站暫時用九巴／龍運站庫（城巴未有完整公開站表）。直線距離唔代表可行人路。",
    });
  }

  if (request.method === "GET" && url.pathname === "/api/stop-services") {
    const co = requireCompany(url.searchParams.get("co") ?? "KMB");
    const stopId = requireNonEmptyString(url.searchParams.get("stopId"), "stopId");
    const services = await listStopServices(co, stopId);
    return json({ services });
  }

  if (request.method === "GET" && url.pathname === "/api/routes") {
    const co = requireCompany(url.searchParams.get("co"));
    const q = url.searchParams.get("q") ?? "";
    if (q.length > 32) return error("q 過長");
    const routes = await listRoutes(co, q);
    return json({ routes });
  }

  if (request.method === "GET" && url.pathname === "/api/stops") {
    const co = requireCompany(url.searchParams.get("co"));
    const route = requireNonEmptyString(url.searchParams.get("route"), "route", 16);
    const bound = requireBound(url.searchParams.get("bound"));
    const serviceType = url.searchParams.get("serviceType") ?? "1";
    if (serviceType.length > 8) return error("serviceType 過長");
    const stops = await listRouteStops(co, route, bound, serviceType);
    return json({ stops });
  }

  if (request.method === "POST" && url.pathname === "/api/board1-departures") {
    const body = await readJson(request);
    const boarding = parseBoardingInput(body);
    const leg1 = parseRouteLeg(body.leg1, "leg1");
    const bufferMinutes = optionalFiniteNumber(body.bufferMinutes, "bufferMinutes", {
      min: 0,
      max: 30,
    });
    const preferredBoard1Eta = optionalEtaIso(body.preferredBoard1Eta);

    const ctx = await resolveBoard1Context({
      boarding,
      leg1: {
        co: leg1.co,
        route: leg1.route,
        bound: leg1.bound,
        serviceType: leg1.serviceType,
      },
      bufferMinutes,
      preferredBoard1Eta,
    });
    const noteWalk =
      ctx.board1.metersFromOrigin != null && ctx.board1.walkMinutesFromOrigin != null
        ? `（距出發地約 ${ctx.board1.metersFromOrigin}m / ${ctx.board1.walkMinutesFromOrigin} 分）`
        : ctx.board1.minutesToBoardStop != null
          ? `（約 ${ctx.board1.minutesToBoardStop} 分後到站）`
          : "";
    return json({
      board1: ctx.board1,
      board1Departures: ctx.board1Departures,
      board1EtaSource: ctx.board1EtaSource,
      board1TimingStatus: ctx.board1TimingStatus,
      board1TimingStatusTc: ctx.board1TimingStatusTc,
      noteTc: `會喺「${ctx.board1.nameTc}」上第一程${noteWalk}。${ctx.board1TimingStatusTc}`,
    });
  }

  if (request.method === "POST" && url.pathname === "/api/plan-transfer") {
    const body = await readJson(request);
    const boarding = parseBoardingInput(body);
    const leg1 = parseRouteLeg(body.leg1, "leg1");
    const leg2 = parseRouteLeg(body.leg2, "leg2");
    const mode = body.mode ?? "shortest_walk";
    if (!isPlanMode(mode)) {
      throw new ValidationError("mode 只可以係 shortest_walk / fastest / manual");
    }
    const maxTransferMeters = optionalFiniteNumber(body.maxTransferMeters, "maxTransferMeters", {
      min: 80,
      max: 1200,
    });
    const bufferMinutes = optionalFiniteNumber(body.bufferMinutes, "bufferMinutes", {
      min: 0,
      max: 30,
    });
    const limit = optionalFiniteNumber(body.limit, "limit", { min: 1, max: 20, integer: true });
    const preferredBoard1Eta = optionalEtaIso(body.preferredBoard1Eta);

    const plan = await planTransfer({
      boarding,
      leg1: {
        co: leg1.co,
        route: leg1.route,
        bound: leg1.bound,
        serviceType: leg1.serviceType,
      },
      leg2: {
        co: leg2.co,
        route: leg2.route,
        bound: leg2.bound,
        serviceType: leg2.serviceType,
      },
      mode,
      maxTransferMeters,
      bufferMinutes,
      limit,
      preferredBoard1Eta,
    });
    return json(plan);
  }

  if (request.method === "POST" && url.pathname === "/api/refresh-candidate") {
    const body = await readJson(request);
    const boarding = parseBoardingInput(body);
    const leg1 = parseRouteLeg(body.leg1, "leg1");
    const leg2 = parseRouteLeg(body.leg2, "leg2");
    const alight1StopId = requireNonEmptyString(body.alight1StopId, "alight1StopId");
    const board2StopId = requireNonEmptyString(body.board2StopId, "board2StopId");
    const alight1Seq = optionalFiniteNumber(body.alight1Seq, "alight1Seq", {
      min: 1,
      max: 500,
      integer: true,
    });
    const board2Seq = optionalFiniteNumber(body.board2Seq, "board2Seq", {
      min: 1,
      max: 500,
      integer: true,
    });
    if (alight1Seq == null || board2Seq == null) {
      throw new ValidationError("需要 alight1Seq / board2Seq");
    }
    const bufferMinutes = optionalFiniteNumber(body.bufferMinutes, "bufferMinutes", {
      min: 0,
      max: 30,
    });
    const preferredBoard1Eta = optionalEtaIso(body.preferredBoard1Eta);

    const result = await refreshCandidateTiming({
      boarding,
      leg1: {
        co: leg1.co,
        route: leg1.route,
        bound: leg1.bound,
        serviceType: leg1.serviceType,
      },
      leg2: {
        co: leg2.co,
        route: leg2.route,
        bound: leg2.bound,
        serviceType: leg2.serviceType,
      },
      alight1StopId,
      alight1Seq,
      board2StopId,
      board2Seq,
      bufferMinutes,
      preferredBoard1Eta,
    });
    return json(result);
  }

  if (request.method === "POST" && url.pathname === "/api/match") {
    const body = await readJson(request);
    const leg1 = parseRouteLeg(body.leg1, "leg1");
    const leg2 = parseRouteLeg(body.leg2, "leg2");
    if (!leg1.stopId || !leg2.stopId) {
      throw new ValidationError("需要 leg1 / leg2 嘅 stopId");
    }

    const [stop1, stop2, etas1, etas2] = await Promise.all([
      getStop(leg1.co, leg1.stopId),
      getStop(leg2.co, leg2.stopId),
      listEtas(leg1.co, leg1.route, leg1.stopId, leg1.serviceType, { bound: leg1.bound }),
      listEtas(leg2.co, leg2.route, leg2.stopId, leg2.serviceType, { bound: leg2.bound }),
    ]);

    const estimatedWalk =
      stop1.hasValidCoord && stop2.hasValidCoord
        ? estimateWalkMinutes(stop1, stop2)
        : Number.NaN;
    const walkMinutes = optionalFiniteNumber(body.walkMinutes, "walkMinutes", {
      min: 0,
      max: 90,
    });
    const bufferMinutes =
      optionalFiniteNumber(body.bufferMinutes, "bufferMinutes", { min: 0, max: 30 }) ?? 1;

    const resolvedWalk =
      walkMinutes != null
        ? Math.round(walkMinutes)
        : Number.isFinite(estimatedWalk)
          ? estimatedWalk
          : 5;

    const result = matchTransfer({
      leg1: {
        ...leg1,
        stopId: leg1.stopId,
        stopNameTc: stop1.nameTc,
        etas: etas1,
      },
      leg2: {
        ...leg2,
        stopId: leg2.stopId,
        stopNameTc: stop2.nameTc,
        etas: etas2,
      },
      walkMinutes: resolvedWalk,
      bufferMinutes,
    });

    return json({
      ...result,
      estimatedWalkMinutes: Number.isFinite(estimatedWalk) ? estimatedWalk : null,
      distanceHintTc: Number.isFinite(estimatedWalk)
        ? `兩站直線估算步行約 ${estimatedWalk} 分鐘（可人手改；唔代表可行人路）`
        : "兩站座標無效，無法估算步行時間",
    });
  }

  return error("未知 API", 404);
}
