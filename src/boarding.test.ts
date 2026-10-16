import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EtaItem, StopInfo } from "./hk-transit";
import { ValidationError, parseBoardingInput } from "./validate";

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
  findStopOccurrence,
  planTransfer,
  resolveBoard1Context,
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

const stops1: StopInfo[] = [
  stop({ stopId: "A1", seq: 1, nameTc: "上車站", lat: 22.319, long: 114.169 }),
  stop({ stopId: "A2", seq: 2, nameTc: "中途甲", lat: 22.321, long: 114.171 }),
  stop({ stopId: "A3", seq: 3, nameTc: "中途乙", lat: 22.325, long: 114.175 }),
  stop({ stopId: "A2", seq: 4, nameTc: "中途甲再經", lat: 22.328, long: 114.178 }),
];

const stops2: StopInfo[] = [
  stop({ stopId: "B1", seq: 1, nameTc: "第二近", lat: 22.3212, long: 114.1712 }),
  stop({ stopId: "B2", seq: 2, nameTc: "第二遠", lat: 22.3255, long: 114.1755 }),
];

beforeEach(() => {
  listRouteStops.mockReset();
  listEtas.mockReset();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

describe("parseBoardingInput", () => {
  it("does not require origin in manual_stop mode", () => {
    const boarding = parseBoardingInput({
      boardingMode: "manual_stop",
      boardStopId: "A1",
      boardStopSeq: 1,
      minutesToBoardStop: 5,
    });
    expect(boarding.mode).toBe("manual_stop");
    expect(boarding.origin).toBeNull();
    expect(boarding.boardStopId).toBe("A1");
    expect(boarding.minutesToBoardStop).toBe(5);
  });

  it("requires origin in location mode", () => {
    expect(() => parseBoardingInput({ boardingMode: "location" })).toThrow(ValidationError);
  });
});

describe("manual boarding without origin", () => {
  it("plans transfers with explicit boarding stop and no origin", async () => {
    listRouteStops.mockImplementation(async (_co, route) => (route === "1A" ? stops1 : stops2));
    listEtas.mockImplementation(async (_co, route, stopId) => {
      if (route === "1A" && stopId === "A1") return [eta("2026-10-16T12:10:00+08:00", { seq: 1 })];
      if (route === "1A") return [eta("2026-10-16T12:25:00+08:00")];
      return [];
    });

    const plan = await planTransfer({
      boarding: {
        mode: "manual_stop",
        boardStopId: "A1",
        boardStopSeq: 1,
        minutesToBoardStop: 3,
      },
      leg1: { co: "KMB", route: "1A", bound: "O", serviceType: "1" },
      leg2: { co: "KMB", route: "5", bound: "O", serviceType: "1" },
      mode: "shortest_walk",
      nowMs: NOW,
    });

    expect(plan.board1.stopId).toBe("A1");
    expect(plan.board1.metersFromOrigin).toBeNull();
    expect(plan.board1.walkMinutesFromOrigin).toBeNull();
    expect(plan.board1.minutesToBoardStop).toBe(3);
    expect(plan.candidates.length).toBeGreaterThan(0);
    expect(plan.candidates.some((c) => c.timingStatus === "awaiting_leg2_eta")).toBe(true);
  });

  it("rejects boarding stop not on the selected route/direction", async () => {
    listRouteStops.mockResolvedValue(stops1);
    await expect(
      resolveBoard1Context({
        boarding: {
          mode: "manual_stop",
          boardStopId: "ZZZ",
          boardStopSeq: 1,
          minutesToBoardStop: 2,
        },
        leg1: { co: "KMB", route: "1A", bound: "O", serviceType: "1" },
        nowMs: NOW,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("only generates alighting candidates downstream of boarding occurrence", () => {
    const pairs = buildPairs(stops1, stops2, 2, 2000, "manual");
    expect(pairs.every((p) => p.alight1.seq > 2)).toBe(true);
    expect(pairs.some((p) => p.alight1.seq === 1)).toBe(false);
  });

  it("unknown time-to-boarding is not treated as zero", async () => {
    listRouteStops.mockResolvedValue(stops1);
    listEtas.mockResolvedValue([
      eta("2026-10-16T12:01:00+08:00", { seq: 1 }),
      eta("2026-10-16T12:20:00+08:00", { seq: 1 }),
    ]);

    const ctx = await resolveBoard1Context({
      boarding: {
        mode: "manual_stop",
        boardStopId: "A1",
        boardStopSeq: 1,
        minutesToBoardStop: null,
      },
      leg1: { co: "KMB", route: "1A", bound: "O", serviceType: "1" },
      nowMs: NOW,
    });

    expect(ctx.board1.catchabilityVerified).toBe(false);
    expect(ctx.board1TimingStatus).toBe("catchability_unverified");
    expect(ctx.board1.boardEta).toBeNull();
    expect(ctx.board1Departures.every((d) => d.catchable === null)).toBe(true);
  });

  it("findStopOccurrence requires seq when stopId repeats", () => {
    expect(findStopOccurrence(stops1, "A2", null)).toBeNull();
    expect(findStopOccurrence(stops1, "A2", 4)?.seq).toBe(4);
  });
});
