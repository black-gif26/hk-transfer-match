import { describe, expect, it } from "vitest";
import {
  ValidationError,
  isPlanMode,
  parseRouteLeg,
  requireBound,
  requireFiniteNumber,
} from "./validate";

describe("API request guards", () => {
  it("accepts valid route legs and rejects bad enums", () => {
    expect(
      parseRouteLeg(
        { co: "KMB", route: "1A", bound: "O", serviceType: "1" },
        "leg1",
      ),
    ).toMatchObject({ co: "KMB", route: "1A", bound: "O" });

    expect(() => requireBound("X")).toThrow(ValidationError);
    expect(isPlanMode("fastest")).toBe(true);
    expect(isPlanMode("teleport")).toBe(false);
  });

  it("rejects non-finite / negative buffers", () => {
    expect(() => requireFiniteNumber(Number.NaN, "bufferMinutes")).toThrow(ValidationError);
    expect(() => requireFiniteNumber(-1, "bufferMinutes", { min: 0 })).toThrow(ValidationError);
    expect(requireFiniteNumber(2, "bufferMinutes", { min: 0, max: 30 })).toBe(2);
  });
});
