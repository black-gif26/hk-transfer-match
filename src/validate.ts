import type { Bound, Company } from "./hk-transit";
import type { PlanMode } from "./transfer-plan";

/** Hong Kong service-area bounds used for request validation. */
export const HK_LAT_MIN = 22.1;
export const HK_LAT_MAX = 22.6;
export const HK_LONG_MIN = 113.8;
export const HK_LONG_MAX = 114.5;

export class ValidationError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export function isCompany(value: unknown): value is Company {
  return value === "KMB" || value === "CTB";
}

export function isBound(value: unknown): value is Bound {
  return value === "O" || value === "I";
}

export function isPlanMode(value: unknown): value is PlanMode {
  return value === "shortest_walk" || value === "fastest" || value === "manual";
}

export function requireCompany(value: unknown, label = "co"): Company {
  if (!isCompany(value)) throw new ValidationError(`需要 ${label}=KMB 或 CTB`);
  return value;
}

export function requireBound(value: unknown, label = "bound"): Bound {
  if (!isBound(value)) throw new ValidationError(`需要 ${label}=O 或 I`);
  return value;
}

export function requireNonEmptyString(
  value: unknown,
  label: string,
  maxLen = 64,
): string {
  if (typeof value !== "string") throw new ValidationError(`需要 ${label}`);
  const trimmed = value.trim();
  if (!trimmed) throw new ValidationError(`需要 ${label}`);
  if (trimmed.length > maxLen) throw new ValidationError(`${label} 過長`);
  return trimmed;
}

export function optionalString(
  value: unknown,
  label: string,
  maxLen = 64,
): string | undefined {
  if (value == null || value === "") return undefined;
  return requireNonEmptyString(value, label, maxLen);
}

/** Valid finite HK coordinates; rejects 0,0 and NaN. */
export function requireHkCoord(lat: unknown, long: unknown): { lat: number; long: number } {
  if (typeof lat !== "number" || typeof long !== "number") {
    throw new ValidationError("需要出發地 origin.lat / origin.long");
  }
  if (!Number.isFinite(lat) || !Number.isFinite(long)) {
    throw new ValidationError("座標必須係有效數字");
  }
  if (lat === 0 && long === 0) {
    throw new ValidationError("座標無效");
  }
  if (lat < HK_LAT_MIN || lat > HK_LAT_MAX || long < HK_LONG_MIN || long > HK_LONG_MAX) {
    throw new ValidationError("位置似乎唔喺香港範圍");
  }
  return { lat, long };
}

export function requireFiniteNumber(
  value: unknown,
  label: string,
  opts?: { min?: number; max?: number; integer?: boolean },
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ValidationError(`${label} 必須係有效數字`);
  }
  if (opts?.integer && !Number.isInteger(value)) {
    throw new ValidationError(`${label} 必須係整數`);
  }
  if (opts?.min != null && value < opts.min) {
    throw new ValidationError(`${label} 唔可以細過 ${opts.min}`);
  }
  if (opts?.max != null && value > opts.max) {
    throw new ValidationError(`${label} 唔可以大過 ${opts.max}`);
  }
  return value;
}

export function optionalFiniteNumber(
  value: unknown,
  label: string,
  opts?: { min?: number; max?: number; integer?: boolean },
): number | undefined {
  if (value == null || value === "") return undefined;
  return requireFiniteNumber(value, label, opts);
}

export function optionalEtaIso(value: unknown, label = "preferredBoard1Eta"): string | null {
  if (value == null || value === "") return null;
  if (typeof value !== "string") throw new ValidationError(`${label} 格式唔正確`);
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > 40) throw new ValidationError(`${label} 過長`);
  const ms = Date.parse(trimmed);
  if (!Number.isFinite(ms)) throw new ValidationError(`${label} 唔係有效時間`);
  return trimmed;
}

export function parseJsonBody(raw: unknown): Record<string, unknown> {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ValidationError("請求 JSON 格式唔正確");
  }
  return raw as Record<string, unknown>;
}

export function parseRouteLeg(
  value: unknown,
  label: string,
): { co: Company; route: string; bound: Bound; serviceType: string; stopId?: string } {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError(`需要 ${label}`);
  }
  const obj = value as Record<string, unknown>;
  const co = requireCompany(obj.co, `${label}.co`);
  const route = requireNonEmptyString(obj.route, `${label}.route`, 16);
  const bound = requireBound(obj.bound, `${label}.bound`);
  const serviceType = optionalString(obj.serviceType, `${label}.serviceType`, 8) ?? "1";
  const stopId = optionalString(obj.stopId, `${label}.stopId`, 64);
  return stopId ? { co, route, bound, serviceType, stopId } : { co, route, bound, serviceType };
}

export function isValidStopCoord(lat: number, long: number): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(long) &&
    !(lat === 0 && long === 0) &&
    lat >= HK_LAT_MIN &&
    lat <= HK_LAT_MAX &&
    long >= HK_LONG_MIN &&
    long <= HK_LONG_MAX
  );
}

export type BoardingMode = "location" | "manual_stop";

export interface ParsedBoardingInput {
  mode: BoardingMode;
  origin: { lat: number; long: number } | null;
  boardStopId: string | null;
  boardStopSeq: number | null;
  minutesToBoardStop: number | null;
}

/** Parse location-based or manual-stop boarding input. Origin not required in manual_stop. */
export function parseBoardingInput(body: Record<string, unknown>): ParsedBoardingInput {
  const modeRaw = body.boardingMode;
  let mode: BoardingMode;
  if (modeRaw === "location" || modeRaw === "manual_stop") {
    mode = modeRaw;
  } else if (modeRaw === null || modeRaw === "") {
    mode = body.origin != null ? "location" : "manual_stop";
  } else {
    throw new ValidationError("boardingMode 只可以係 location 或 manual_stop");
  }

  if (mode === "location") {
    const originRaw = body.origin;
    if (originRaw == null || typeof originRaw !== "object" || Array.isArray(originRaw)) {
      throw new ValidationError("定位模式需要出發地 origin.lat / origin.long");
    }
    const o = originRaw as Record<string, unknown>;
    const origin = requireHkCoord(o.lat, o.long);
    return {
      mode,
      origin,
      boardStopId: null,
      boardStopSeq: null,
      minutesToBoardStop: null,
    };
  }

  const boardStopId = requireNonEmptyString(body.boardStopId, "boardStopId", 64);
  const boardStopSeq = requireFiniteNumber(body.boardStopSeq, "boardStopSeq", {
    min: 1,
    max: 500,
    integer: true,
  });
  const minutesToBoardStop =
    optionalFiniteNumber(body.minutesToBoardStop, "minutesToBoardStop", {
      min: 0,
      max: 180,
    }) ?? null;

  return {
    mode,
    origin: null,
    boardStopId,
    boardStopSeq,
    minutesToBoardStop,
  };
}
