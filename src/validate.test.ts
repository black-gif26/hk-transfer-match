import { describe, expect, it } from "vitest";
import {
  ValidationError,
  isValidStopCoord,
  optionalEtaIso,
  parseJsonBody,
  requireCompany,
  requireHkCoord,
} from "./validate";

describe("validate", () => {
  it("rejects invalid company with ValidationError", () => {
    expect(() => requireCompany("MTR")).toThrow(ValidationError);
  });

  it("rejects malformed JSON body shape", () => {
    expect(() => parseJsonBody(null)).toThrow(ValidationError);
    expect(() => parseJsonBody([])).toThrow(ValidationError);
  });

  it("rejects coords outside HK / 0,0", () => {
    expect(() => requireHkCoord(0, 0)).toThrow(ValidationError);
    expect(() => requireHkCoord(51.5, -0.1)).toThrow(ValidationError);
    expect(requireHkCoord(22.3, 114.17)).toEqual({ lat: 22.3, long: 114.17 });
  });

  it("isValidStopCoord rejects missing geometry fallbacks", () => {
    expect(isValidStopCoord(0, 0)).toBe(false);
    expect(isValidStopCoord(Number.NaN, 114)).toBe(false);
    expect(isValidStopCoord(22.3, 114.17)).toBe(true);
  });

  it("validates optional ETA timestamps", () => {
    expect(optionalEtaIso(null)).toBeNull();
    expect(optionalEtaIso("2026-10-16T12:00:00+08:00")).toBe("2026-10-16T12:00:00+08:00");
    expect(() => optionalEtaIso("not-a-date")).toThrow(ValidationError);
  });
});
