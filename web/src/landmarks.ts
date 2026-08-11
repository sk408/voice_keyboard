/**
 * Named saved pointer positions ("landmarks") in normalized 0..32767 wire
 * coordinates (PROTOCOL.md v4 "Absolute pointer"), persisted per device in
 * localStorage. Used by the `{click "name"}` macro token and the UI.
 *
 * Pure module — DOM-free except for localStorage; unit-tested in
 * landmarks.test.ts.
 */

export interface Landmark {
  name: string;
  x: number; // normalized 0..32767
  y: number; // normalized 0..32767
}

const NORM_MAX = 32767;
const STORAGE_PREFIX = 'voicekb.landmarks.';

function isValidLandmark(value: unknown): value is Landmark {
  if (typeof value !== 'object' || value === null) return false;
  const o = value as Record<string, unknown>;
  if (typeof o.name !== 'string' || o.name.length === 0) return false;
  if (typeof o.x !== 'number' || typeof o.y !== 'number') return false;
  if (!Number.isFinite(o.x) || !Number.isFinite(o.y)) return false;
  return o.x >= 0 && o.x <= NORM_MAX && o.y >= 0 && o.y <= NORM_MAX;
}

/** Load all landmarks for a device; invalid entries are skipped. */
export function loadLandmarks(deviceKey: string): Landmark[] {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + deviceKey);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidLandmark).map((l) => ({ name: l.name, x: l.x, y: l.y }));
  } catch {
    return [];
  }
}

function saveAll(deviceKey: string, landmarks: Landmark[]): void {
  try {
    localStorage.setItem(STORAGE_PREFIX + deviceKey, JSON.stringify(landmarks));
  } catch {
    /* storage unavailable — non-fatal */
  }
}

/** Upsert by name (case-insensitive match replaces the existing entry). */
export function saveLandmark(deviceKey: string, lm: Landmark): Landmark[] {
  const landmarks = loadLandmarks(deviceKey);
  const index = landmarks.findIndex((l) => l.name.toLowerCase() === lm.name.toLowerCase());
  if (index === -1) landmarks.push(lm);
  else landmarks[index] = lm;
  saveAll(deviceKey, landmarks);
  return landmarks;
}

/** Delete by name (case-insensitive); returns the updated list. */
export function deleteLandmark(deviceKey: string, name: string): Landmark[] {
  const lower = name.toLowerCase();
  const landmarks = loadLandmarks(deviceKey).filter((l) => l.name.toLowerCase() !== lower);
  saveAll(deviceKey, landmarks);
  return landmarks;
}

/** Find a landmark by name (case-insensitive). */
export function findLandmark(deviceKey: string, name: string): Landmark | undefined {
  const lower = name.toLowerCase();
  return loadLandmarks(deviceKey).find((l) => l.name.toLowerCase() === lower);
}
