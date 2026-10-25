import { describe, expect, it } from "vitest";
import { distanceMeters, stopOccurrenceKey } from "./hk-transit";

describe("coordinates", () => {
  it("does not produce NaN distance for valid HK coords", () => {
    const d = distanceMeters({ lat: 22.3, long: 114.17 }, { lat: 22.31, long: 114.18 });
    expect(Number.isFinite(d)).toBe(true);
    expect(d).toBeGreaterThan(0);
  });

  it("returns NaN for invalid 0,0 geometry instead of treating as real", () => {
    const d = distanceMeters({ lat: 0, long: 0 }, { lat: 22.3, long: 114.17 });
    expect(Number.isNaN(d)).toBe(true);
  });
});

describe("stop occurrence", () => {
  it("keys include seq so repeats are distinct", () => {
    expect(stopOccurrenceKey({ stopId: "A2", seq: 2 })).not.toBe(
      stopOccurrenceKey({ stopId: "A2", seq: 4 }),
    );
  });
});
