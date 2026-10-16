import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EtaItem, StopInfo } from "./hk-transit";

const listRouteStops = vi.fn();
const listEtas = vi.fn();

vi.mock("./hk-transit", async () => {
  const actual = await vi.importActual<typeof import("./hk-transit")>("./hk-transit");
  return {
    ...actual,
    listRouteStops: (...args: unknown[]) => listRouteStops(...args),
    listEtas: (...args: unknown[]) => listEtas(...args),
  };
});

import {
  buildPairs,
  planTransfer,
  pickCatchableEta,
  resolveBoard1Context,
  scoreCandidate,
} from "./transfer-plan";

const NOW = Date.parse("2026-10-16T12:00:00+08:00");

function stop(
  partial: Partial<StopInfo> & Pick<StopInfo, "stopId" | "seq" | "nameTc">,
): StopInfo {
  return {
    nameEn: partial.nameEn ?? partial.nameTc,
    lat: partial.lat ?? 22.3,
    long: partial.long ?? 114.17,
    hasValidCoord: partial.hasValidCoord ?? true,
    ...partial,
  };
}

function eta(iso: string, extras: Partial<EtaItem> = {}): EtaItem {
  return {
    eta: iso,
    etaSeq: extras.etaSeq ?? 1,
    destTc: extras.destTc ?? "目的地",
    rmkTc: extras.rmkTc ?? "",
    dir: extras.dir ?? "O",
    seq: extras.seq ?? null,
    dataTimestamp: extras.dataTimestamp ?? null,
  };
}

const origin = { lat: 22.319, long: 114.169 };

const stops1: StopInfo[] = [
  stop({ stopId: "A1", seq: 1, nameTc: "上車站", lat: 22.319, long: 114.169 }),
  stop({ stopId: "A2", seq: 2, nameTc: "中途甲", lat: 22.321, long: 114.171 }),
  stop({ stopId: "A3", seq: 3, nameTc: "中途乙", lat: 22.325, long: 114.175 }),
  // Repeated stop id at different seq
  stop({ stopId: "A2", seq: 4, nameTc: "中途甲再經", lat: 22.328, long: 114.178 }),
];

const stops2: StopInfo[] = [
  stop({ stopId: "B1", seq: 1, nameTc: "第二近", lat: 22.3212, long: 114.1712 }),
  stop({ stopId: "B2", seq: 2, nameTc: "第二遠但較快", lat: 22.3255, long: 114.1755 }),
  stop({ stopId: "B3", seq: 3, nameTc: "反向站", lat: 22.4, long: 114.2 }),
];

beforeEach(() => {
  listRouteStops.mockReset();
  listEtas.mockReset();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

describe("pickCatchableEta / board1", () => {
  it("never falls back to an uncatchable first departure", async () => {
    listRouteStops.mockResolvedValue(stops1);
    listEtas.mockResolvedValue([
      eta("2026-10-16T12:01:00+08:00"), // too soon after walk
      eta("2026-10-16T12:20:00+08:00"),
    ]);

    const ctx = await resolveBoard1Context({
      origin,
      leg1: { co: "KMB", route: "1A", bound: "O", serviceType: "1" },
      bufferMinutes: 1,
      nowMs: NOW,
    });

    // walk from origin to A1 is ~0m → ready ≈ now+1min buffer; 12:01 may be borderline.
    // With 0m walk, walkMinutesFromOrigin is at least 1, + buffer 1 → ready +2 min.
    expect(ctx.board1.boardEta).toBe("2026-10-16T12:20:00+08:00");
    expect(ctx.board1TimingStatus).toBe("ok");
  });

  it("returns no_catchable_board1 without selecting uncatchable bus", async () => {
    listRouteStops.mockResolvedValue(stops1);
    listEtas.mockResolvedValue([
      eta("2026-10-16T12:00:30+08:00"),
      eta("2026-10-16T12:01:00+08:00"),
    ]);

    const ctx = await resolveBoard1Context({
      origin,
      leg1: { co: "KMB", route: "1A", bound: "O", serviceType: "1" },
      bufferMinutes: 5,
      nowMs: NOW,
    });

    expect(ctx.board1.boardEta).toBeNull();
    expect(ctx.board1TimingStatus).toBe("no_catchable_board1");
    expect(ctx.board1EtaSource).toBe("none");
  });

  it("marks manual uncatchable without treating as feasible journey board", async () => {
    listRouteStops.mockResolvedValue(stops1);
    listEtas.mockResolvedValue([
      eta("2026-10-16T12:00:30+08:00"),
      eta("2026-10-16T12:30:00+08:00"),
    ]);

    const ctx = await resolveBoard1Context({
      origin,
      leg1: { co: "KMB", route: "1A", bound: "O", serviceType: "1" },
      bufferMinutes: 5,
      preferredBoard1Eta: "2026-10-16T12:00:30+08:00",
      nowMs: NOW,
    });

    expect(ctx.board1TimingStatus).toBe("manual_uncatchable");
    expect(ctx.board1.boardEta).toBe("2026-10-16T12:00:30+08:00");
    expect(ctx.board1EtaSource).toBe("manual");
  });

  it("reports preferred_gone without silent switch", async () => {
    listRouteStops.mockResolvedValue(stops1);
    listEtas.mockResolvedValue([eta("2026-10-16T12:30:00+08:00")]);

    const ctx = await resolveBoard1Context({
      origin,
      leg1: { co: "KMB", route: "1A", bound: "O", serviceType: "1" },
      preferredBoard1Eta: "2026-10-16T12:15:00+08:00",
      nowMs: NOW,
    });

    expect(ctx.board1TimingStatus).toBe("preferred_gone");
    expect(ctx.board1.boardEta).toBeNull();
  });
});

describe("physical candidates survive missing ETA", () => {
  it("keeps candidates when second ETA list is empty (awaiting_leg2_eta)", async () => {
    listRouteStops.mockImplementation(async (_co, route) => (route === "1A" ? stops1 : stops2));
    listEtas.mockImplementation(async (_co, route, stopId) => {
      if (route === "1A" && stopId === "A1") return [eta("2026-10-16T12:10:00+08:00", { seq: 1 })];
      if (route === "1A") return [eta("2026-10-16T12:25:00+08:00")];
      return []; // leg2 empty
    });

    const plan = await planTransfer({
      origin,
      leg1: { co: "KMB", route: "1A", bound: "O", serviceType: "1" },
      leg2: { co: "KMB", route: "5", bound: "O", serviceType: "1" },
      mode: "shortest_walk",
      nowMs: NOW,
    });

    expect(plan.candidates.length).toBeGreaterThan(0);
    expect(plan.candidates.every((c) => c.alight1 && c.board2)).toBe(true);
    expect(plan.candidates.some((c) => c.timingStatus === "awaiting_leg2_eta")).toBe(true);
    expect(plan.candidates.every((c) => c.hasMatch === (c.timingStatus === "eta_matched"))).toBe(
      true,
    );
  });

  it("uses outside_visible_eta when all visible second departures are too early", async () => {
    listRouteStops.mockImplementation(async (_co, route) => (route === "1A" ? stops1 : stops2));
    listEtas.mockImplementation(async (_co, route, stopId) => {
      if (route === "1A" && stopId === "A1") return [eta("2026-10-16T12:10:00+08:00", { seq: 1 })];
      if (route === "1A") return [eta("2026-10-16T12:25:00+08:00")];
      // All second-leg ETAs before transfer-ready
      return [eta("2026-10-16T12:20:00+08:00"), eta("2026-10-16T12:22:00+08:00")];
    });

    const plan = await planTransfer({
      origin,
      leg1: { co: "KMB", route: "1A", bound: "O", serviceType: "1" },
      leg2: { co: "KMB", route: "5", bound: "O", serviceType: "1" },
      mode: "manual",
      nowMs: NOW,
    });

    expect(plan.candidates.length).toBeGreaterThan(0);
    expect(plan.candidates.some((c) => c.timingStatus === "outside_visible_eta")).toBe(true);
    expect(plan.candidates.every((c) => c.leg2Eta == null || c.timingStatus === "eta_matched")).toBe(
      true,
    );
  });

  it("keeps physical candidates when board1 ETA missing", async () => {
    listRouteStops.mockImplementation(async (_co, route) => (route === "1A" ? stops1 : stops2));
    listEtas.mockResolvedValue([]);

    const plan = await planTransfer({
      origin,
      leg1: { co: "KMB", route: "1A", bound: "O", serviceType: "1" },
      leg2: { co: "KMB", route: "5", bound: "O", serviceType: "1" },
      mode: "shortest_walk",
      nowMs: NOW,
    });

    expect(plan.board1TimingStatus).toBe("awaiting_board1_eta");
    expect(plan.candidates.length).toBeGreaterThan(0);
    expect(plan.candidates.every((c) => c.timingStatus === "awaiting_board1_eta")).toBe(true);
    expect(plan.candidates.every((c) => !c.hasMatch)).toBe(true);
  });
});

describe("direction and stop occurrence", () => {
  it("passes bound into listEtas", async () => {
    listRouteStops.mockResolvedValue(stops1);
    listEtas.mockResolvedValue([eta("2026-10-16T12:30:00+08:00", { dir: "O", seq: 1 })]);

    await resolveBoard1Context({
      origin,
      leg1: { co: "KMB", route: "1A", bound: "I", serviceType: "1" },
      nowMs: NOW,
    });

    expect(listEtas).toHaveBeenCalled();
    const args = listEtas.mock.calls[0];
    expect(args[4]).toMatchObject({ bound: "I" });
  });

  it("does not merge repeated stop occurrences in buildPairs", () => {
    const pairs = buildPairs(stops1, stops2, 1, 2000, "manual");
    const alightKeys = new Set(pairs.map((p) => `${p.alight1.stopId}#${p.alight1.seq}`));
    expect(alightKeys.has("A2#2")).toBe(true);
    expect(alightKeys.has("A2#4")).toBe(true);
  });

  it("preserves non-nearest alternative for fastest ranking", () => {
    const short = buildPairs(stops1, stops2, 1, 2000, "shortest_walk");
    const fast = buildPairs(stops1, stops2, 1, 2000, "fastest");
    // shortest_walk keeps one board2 per alight; fastest keeps alternatives
    expect(fast.length).toBeGreaterThanOrEqual(short.length);
    const forA2 = fast.filter((p) => p.alight1.stopId === "A2" && p.alight1.seq === 2);
    expect(forA2.length).toBeGreaterThan(1);
  });
});

describe("timing confidence", () => {
  it("marks compatible timestamps as estimated_unverified", async () => {
    const pair = {
      alight1: stops1[1],
      board2: stops2[0],
      walkMeters: 40,
      walkMinutes: 1,
    };
    listEtas.mockImplementation(async (_co, route) => {
      if (route === "1A") return [eta("2026-10-16T12:25:00+08:00")];
      return [eta("2026-10-16T12:40:00+08:00")];
    });

    const c = await scoreCandidate({
      leg1: { co: "KMB", route: "1A", bound: "O", serviceType: "1" },
      leg2: { co: "KMB", route: "5", bound: "O", serviceType: "1" },
      pair,
      bufferMinutes: 1,
      board1: stops1[0],
      board1Eta: "2026-10-16T12:10:00+08:00",
      board1TimingStatus: "ok",
      nowMs: NOW,
    });

    expect(c.timingStatus).toBe("eta_matched");
    expect(c.timingConfidence).toBe("estimated_unverified");
    expect(c.timingNoteTc).toMatch(/未提供跨站車輛識別|估算/);
  });
});

describe("partial upstream failure", () => {
  it("still returns unaffected candidates when one ETA fails", async () => {
    listRouteStops.mockImplementation(async (_co, route) => (route === "1A" ? stops1 : stops2));
    listEtas.mockImplementation(async (_co, route, stopId) => {
      if (route === "1A" && stopId === "A1") return [eta("2026-10-16T12:10:00+08:00", { seq: 1 })];
      if (route === "1A" && stopId === "A2") {
        throw new Error("upstream boom");
      }
      if (route === "1A") return [eta("2026-10-16T12:30:00+08:00")];
      return [eta("2026-10-16T12:45:00+08:00")];
    });

    const plan = await planTransfer({
      origin,
      leg1: { co: "KMB", route: "1A", bound: "O", serviceType: "1" },
      leg2: { co: "KMB", route: "5", bound: "O", serviceType: "1" },
      mode: "manual",
      limit: 12,
      nowMs: NOW,
    });

    expect(plan.candidates.length).toBeGreaterThan(1);
    expect(plan.candidates.some((c) => c.timingStatus === "upstream_error")).toBe(true);
    expect(plan.candidates.some((c) => c.timingStatus === "eta_matched")).toBe(true);
  });
});

describe("fastest mode unknown timing", () => {
  it("explains fallback and keeps physical options", async () => {
    listRouteStops.mockImplementation(async (_co, route) => (route === "1A" ? stops1 : stops2));
    listEtas.mockImplementation(async (_co, route, stopId) => {
      if (route === "1A" && stopId === "A1") return [eta("2026-10-16T12:10:00+08:00", { seq: 1 })];
      if (route === "1A") return [eta("2026-10-16T12:25:00+08:00")];
      return [];
    });

    const plan = await planTransfer({
      origin,
      leg1: { co: "KMB", route: "1A", bound: "O", serviceType: "1" },
      leg2: { co: "KMB", route: "5", bound: "O", serviceType: "1" },
      mode: "fastest",
      nowMs: NOW,
    });

    expect(plan.summaryTc).toMatch(/暫未能比較最快方案/);
    expect(plan.candidates.length).toBeGreaterThan(0);
    expect(plan.candidates.every((c) => c.walkMeters > 0)).toBe(true);
  });
});

describe("pickCatchableEta unit", () => {
  it("skips early departures", () => {
    const ready = Date.parse("2026-10-16T12:10:00+08:00");
    const hit = pickCatchableEta(
      [eta("2026-10-16T12:05:00+08:00"), eta("2026-10-16T12:15:00+08:00")],
      ready,
    );
    expect(hit?.eta).toBe("2026-10-16T12:15:00+08:00");
  });
});
