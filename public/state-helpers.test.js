import { describe, expect, it } from "vitest";
import {
  canPlanWith,
  canShowConfirmedJourney,
  geoErrorMessage,
  GEO_FAIL_HINT,
  parseRouteValue,
  shouldApplyCandidateResponse,
  shouldApplyResponse,
  textOnly,
} from "./state-helpers.js";

describe("frontend state races", () => {
  it("ignores stale plan responses when inputs changed", () => {
    const snap = {
      origin: { lat: 22.3, long: 114.17 },
      leg1: { co: "KMB", route: "1A", bound: "O", serviceType: "1" },
      leg2: { co: "KMB", route: "5", bound: "O", serviceType: "1" },
      mode: "fastest",
      preferredBoard1Eta: null,
    };
    const current = {
      ...snap,
      leg1: { ...snap.leg1, route: "2" },
    };
    expect(shouldApplyResponse(1, 1, snap, current)).toBe(false);
    expect(shouldApplyResponse(1, 2, snap, snap)).toBe(false);
    expect(shouldApplyResponse(3, 3, snap, snap)).toBe(true);
  });

  it("ignores old candidate refresh for a new selection", () => {
    expect(shouldApplyCandidateResponse(1, 1, 0, 1)).toBe(false);
    expect(shouldApplyCandidateResponse(2, 2, 1, 1)).toBe(true);
  });
});

describe("safe text rendering helpers", () => {
  it("keeps HTML-like strings as plain text values", () => {
    const evil = '<img src=x onerror=alert(1)>尖沙咀';
    expect(textOnly(evil)).toBe(evil);
    expect(parseRouteValue(`{"co":"KMB","route":"1A","bound":"O","serviceType":"1"}`)).toEqual({
      co: "KMB",
      route: "1A",
      bound: "O",
      serviceType: "1",
    });
  });
});

describe("confirmed journey gate", () => {
  it("does not claim complete journey without board1", () => {
    expect(
      canShowConfirmedJourney(
        {
          board1Eta: null,
          timingStatus: "awaiting_leg2_eta",
          leg1Eta: null,
          leg2Eta: null,
        },
        { board1TimingStatus: "awaiting_board1_eta" },
      ),
    ).toBe(false);

    expect(
      canShowConfirmedJourney(
        {
          board1Eta: "2026-10-16T12:10:00+08:00",
          timingStatus: "eta_matched",
          leg1Eta: "2026-10-16T12:25:00+08:00",
          leg2Eta: "2026-10-16T12:40:00+08:00",
        },
        { board1TimingStatus: "ok" },
      ),
    ).toBe(true);
  });
});

describe("optional geolocation / canPlan", () => {
  const routes = {
    leg1: { co: "KMB", route: "1A", bound: "O", serviceType: "1" },
    leg2: { co: "KMB", route: "5", bound: "O", serviceType: "1" },
  };

  it("allows manual planning when geolocation denied/unavailable/timeout messages are shown", () => {
    expect(geoErrorMessage({ code: 1 }, { geolocationAvailable: true, isSecureContext: true })).toContain(
      GEO_FAIL_HINT,
    );
    expect(geoErrorMessage({ code: 2 }, { geolocationAvailable: true, isSecureContext: true })).toContain(
      GEO_FAIL_HINT,
    );
    expect(geoErrorMessage({ code: 3 }, { geolocationAvailable: true, isSecureContext: true })).toContain(
      GEO_FAIL_HINT,
    );
    expect(
      canPlanWith({
        boardingMode: "manual_stop",
        origin: null,
        boardStopId: "A1",
        boardStopSeq: 1,
        ...routes,
      }),
    ).toBe(true);
  });

  it("blocks location mode without origin but not manual mode", () => {
    expect(
      canPlanWith({
        boardingMode: "location",
        origin: null,
        boardStopId: null,
        boardStopSeq: null,
        ...routes,
      }),
    ).toBe(false);
    expect(
      canPlanWith({
        boardingMode: "manual_stop",
        origin: null,
        boardStopId: "A1",
        boardStopSeq: 2,
        ...routes,
      }),
    ).toBe(true);
  });

  it("invalidates plan when boarding mode changes in shouldApplyResponse", () => {
    const snap = {
      boardingMode: "location",
      origin: { lat: 22.3, long: 114.17 },
      boardStopId: null,
      boardStopSeq: null,
      minutesToBoardStop: null,
      ...routes,
      mode: "fastest",
      preferredBoard1Eta: null,
    };
    const current = { ...snap, boardingMode: "manual_stop", boardStopId: "A1", boardStopSeq: 1 };
    expect(shouldApplyResponse(1, 1, snap, current)).toBe(false);
  });
});
