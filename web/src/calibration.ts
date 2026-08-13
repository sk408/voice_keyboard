/**
 * Calibration mapping between actual-screen fractions (fx, fy in 0..1,
 * origin top-left) and the normalized 0..32767 coordinates sent on the wire
 * (PROTOCOL.md v4 "Absolute pointer"). Needed when Windows spans the
 * pointer's logical extent over a virtual desktop larger than the target
 * screen. Persisted per device in localStorage.
 *
 * Pure module — DOM-free except for localStorage; unit-tested in
 * calibration.test.ts.
 */

export interface CalibrationMap {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export const IDENTITY_MAP: CalibrationMap = { minX: 0, maxX: 32767, minY: 0, maxY: 32767 };

const NORM_MAX = 32767;
const STORAGE_PREFIX = 'voicekb.calibration.';

/** Map an actual-screen fraction (0..1) to normalized wire coords. */
export function screenFractionToNorm(
  map: CalibrationMap,
  fx: number,
  fy: number,
): { x: number; y: number } {
  const x = map.minX + fx * (map.maxX - map.minX);
  const y = map.minY + fy * (map.maxY - map.minY);
  return {
    x: Math.max(0, Math.min(NORM_MAX, Math.round(x))),
    y: Math.max(0, Math.min(NORM_MAX, Math.round(y))),
  };
}

/** Inverse of screenFractionToNorm: normalized wire coords → screen fraction. */
export function normToScreenFraction(
  map: CalibrationMap,
  x: number,
  y: number,
): { fx: number; fy: number } {
  const spanX = map.maxX - map.minX;
  const spanY = map.maxY - map.minY;
  return {
    fx: spanX === 0 ? 0 : (x - map.minX) / spanX,
    fy: spanY === 0 ? 0 : (y - map.minY) / spanY,
  };
}

/**
 * Least-squares fit of `norm = min + fraction * (max - min)` for one axis.
 * Needs at least two samples with distinct fractions; returns null when the
 * axis has insufficient spread (caller falls back to identity for that axis).
 */
function fitAxis(samples: { f: number; n: number }[]): { min: number; max: number } | null {
  const distinct = new Set(samples.map((s) => s.f));
  if (samples.length < 2 || distinct.size < 2) return null;
  // Fit n = a + b*f by least squares.
  const count = samples.length;
  const sumF = samples.reduce((acc, s) => acc + s.f, 0);
  const sumN = samples.reduce((acc, s) => acc + s.n, 0);
  const sumFF = samples.reduce((acc, s) => acc + s.f * s.f, 0);
  const sumFN = samples.reduce((acc, s) => acc + s.f * s.n, 0);
  const denom = count * sumFF - sumF * sumF;
  if (denom === 0) return null;
  const b = (count * sumFN - sumF * sumN) / denom;
  const a = (sumN - b * sumF) / count;
  return { min: a, max: a + b };
}

/**
 * Learn-mode fit: samples are corners the user dragged to — fx/fy = the
 * corner's true screen fraction (0 or 1), x/y = the normalized coords that
 * actually landed there. An axis without at least two distinct samples falls
 * back to the identity mapping for that axis.
 */
export function deriveCalibration(
  samples: { fx: number; fy: number; x: number; y: number }[],
): CalibrationMap {
  const fitX = fitAxis(samples.map((s) => ({ f: s.fx, n: s.x })));
  const fitY = fitAxis(samples.map((s) => ({ f: s.fy, n: s.y })));
  return {
    minX: fitX ? fitX.min : IDENTITY_MAP.minX,
    maxX: fitX ? fitX.max : IDENTITY_MAP.maxX,
    minY: fitY ? fitY.min : IDENTITY_MAP.minY,
    maxY: fitY ? fitY.max : IDENTITY_MAP.maxY,
  };
}

function isValidMap(value: unknown): value is CalibrationMap {
  if (typeof value !== 'object' || value === null) return false;
  const o = value as Record<string, unknown>;
  const { minX, maxX, minY, maxY } = o;
  if (
    typeof minX !== 'number' ||
    typeof maxX !== 'number' ||
    typeof minY !== 'number' ||
    typeof maxY !== 'number'
  ) {
    return false;
  }
  if (![minX, maxX, minY, maxY].every(Number.isFinite)) return false;
  return minX < maxX && minY < maxY;
}

/** Load the saved calibration for a device, or null when absent/invalid. */
export function loadCalibration(deviceKey: string): CalibrationMap | null {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + deviceKey);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isValidMap(parsed)) return null;
    return { minX: parsed.minX, maxX: parsed.maxX, minY: parsed.minY, maxY: parsed.maxY };
  } catch {
    return null;
  }
}

export function saveCalibration(deviceKey: string, map: CalibrationMap): void {
  try {
    localStorage.setItem(STORAGE_PREFIX + deviceKey, JSON.stringify(map));
  } catch {
    /* storage unavailable — non-fatal */
  }
}

export function clearCalibration(deviceKey: string): void {
  try {
    localStorage.removeItem(STORAGE_PREFIX + deviceKey);
  } catch {
    /* storage unavailable — non-fatal */
  }
}
