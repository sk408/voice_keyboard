import { beforeEach, describe, expect, it } from 'vitest';
import {
  IDENTITY_MAP,
  clearCalibration,
  deriveCalibration,
  loadCalibration,
  normToScreenFraction,
  saveCalibration,
  screenFractionToNorm,
  type CalibrationMap,
} from './calibration';

// Minimal in-memory localStorage for the node test environment.
function memoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (key: string) => store.get(key) ?? null,
    key: (index: number) => [...store.keys()][index] ?? null,
    removeItem: (key: string) => {
      store.delete(key);
    },
    setItem: (key: string, value: string) => {
      store.set(key, String(value));
    },
  };
}

if (typeof globalThis.localStorage === 'undefined') {
  Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true });
}

const DEVICE = 'test-device';

beforeEach(() => {
  localStorage.clear();
});

describe('screenFractionToNorm', () => {
  it('identity map: fraction → 0..32767', () => {
    expect(screenFractionToNorm(IDENTITY_MAP, 0, 0)).toEqual({ x: 0, y: 0 });
    expect(screenFractionToNorm(IDENTITY_MAP, 1, 1)).toEqual({ x: 32767, y: 32767 });
    expect(screenFractionToNorm(IDENTITY_MAP, 0.5, 0.5)).toEqual({ x: 16384, y: 16384 });
  });

  it('applies a known offset/scale map', () => {
    const map: CalibrationMap = { minX: 8192, maxX: 24576, minY: 8192, maxY: 24576 };
    expect(screenFractionToNorm(map, 0, 0)).toEqual({ x: 8192, y: 8192 });
    expect(screenFractionToNorm(map, 1, 1)).toEqual({ x: 24576, y: 24576 });
    expect(screenFractionToNorm(map, 0.5, 0.5)).toEqual({ x: 16384, y: 16384 });
  });

  it('clamps the result to 0..32767', () => {
    const map: CalibrationMap = { minX: -1000, maxX: 40000, minY: 0, maxY: 32767 };
    expect(screenFractionToNorm(map, 0, 2)).toEqual({ x: 0, y: 32767 });
    expect(screenFractionToNorm(map, 1, -1)).toEqual({ x: 32767, y: 0 });
  });

  it('rounds fractional results', () => {
    const map: CalibrationMap = { minX: 0, maxX: 101, minY: 0, maxY: 101 };
    expect(screenFractionToNorm(map, 0.5, 0.5)).toEqual({ x: 51, y: 51 }); // 50.5 rounds up
  });
});

describe('normToScreenFraction', () => {
  it('is the exact inverse of screenFractionToNorm', () => {
    const map: CalibrationMap = { minX: 1000, maxX: 30000, minY: 2000, maxY: 10000 };
    const { x, y } = screenFractionToNorm(map, 0.25, 0.75);
    const { fx, fy } = normToScreenFraction(map, x, y);
    expect(fx).toBeCloseTo(0.25, 3);
    expect(fy).toBeCloseTo(0.75, 3);
  });

  it('identity map round-trips the corners', () => {
    for (const [fx, fy] of [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ]) {
      const { x, y } = screenFractionToNorm(IDENTITY_MAP, fx, fy);
      expect(normToScreenFraction(IDENTITY_MAP, x, y)).toEqual({ fx, fy });
    }
  });

  it('guards a zero-span axis against divide-by-zero', () => {
    const map: CalibrationMap = { minX: 100, maxX: 100, minY: 0, maxY: 32767 };
    expect(normToScreenFraction(map, 100, 16384)).toEqual({ fx: 0, fy: 16384 / 32767 });
  });
});

describe('deriveCalibration', () => {
  it('reproduces a known offset/scale map from four corners', () => {
    const trueMap: CalibrationMap = { minX: 2048, maxX: 30719, minY: 4096, maxY: 28671 };
    const corners = [
      { fx: 0, fy: 0 },
      { fx: 1, fy: 0 },
      { fx: 0, fy: 1 },
      { fx: 1, fy: 1 },
    ].map((c) => ({ ...c, ...screenFractionToNorm(trueMap, c.fx, c.fy) }));
    const derived = deriveCalibration(corners);
    expect(derived.minX).toBeCloseTo(trueMap.minX, 0);
    expect(derived.maxX).toBeCloseTo(trueMap.maxX, 0);
    expect(derived.minY).toBeCloseTo(trueMap.minY, 0);
    expect(derived.maxY).toBeCloseTo(trueMap.maxY, 0);
  });

  it('fits the virtual-desktop-span case (screen maps to half the extent)', () => {
    // Primary screen only: actual screen fx 0..1 lands on norm 0..16383.
    const samples = [
      { fx: 0, fy: 0, x: 0, y: 0 },
      { fx: 1, fy: 0, x: 16383, y: 0 },
      { fx: 0, fy: 1, x: 0, y: 16383 },
      { fx: 1, fy: 1, x: 16383, y: 16383 },
    ];
    const derived = deriveCalibration(samples);
    expect(derived.minX).toBeCloseTo(0, 5);
    expect(derived.maxX).toBeCloseTo(16383, 5);
    expect(derived.minY).toBeCloseTo(0, 5);
    expect(derived.maxY).toBeCloseTo(16383, 5);
    // Round-trip through the derived map lands back on the sampled coords.
    expect(screenFractionToNorm(derived, 1, 1)).toEqual({ x: 16383, y: 16383 });
  });

  it('least-squares over redundant samples averages noise', () => {
    const samples = [
      { fx: 0, fy: 0, x: 10, y: 20 },
      { fx: 0, fy: 0, x: 12, y: 20 },
      { fx: 1, fy: 1, x: 32760, y: 32760 },
      { fx: 1, fy: 1, x: 32762, y: 32760 },
    ];
    const derived = deriveCalibration(samples);
    expect(derived.minX).toBeCloseTo(11, 5);
    expect(derived.maxX).toBeCloseTo(32761, 5);
  });

  it('falls back to identity for an axis with insufficient spread', () => {
    // All samples on the left edge: fx never varies.
    const samples = [
      { fx: 0, fy: 0, x: 100, y: 50 },
      { fx: 0, fy: 1, x: 100, y: 30000 },
    ];
    const derived = deriveCalibration(samples);
    expect(derived.minX).toBe(IDENTITY_MAP.minX);
    expect(derived.maxX).toBe(IDENTITY_MAP.maxX);
    expect(derived.minY).toBeCloseTo(50, 5);
    expect(derived.maxY).toBeCloseTo(30000, 5);
  });

  it('falls back to full identity with fewer than two samples', () => {
    expect(deriveCalibration([])).toEqual(IDENTITY_MAP);
    expect(deriveCalibration([{ fx: 0.5, fy: 0.5, x: 100, y: 200 }])).toEqual(IDENTITY_MAP);
  });
});

describe('calibration storage', () => {
  it('returns null when nothing is stored', () => {
    expect(loadCalibration(DEVICE)).toBeNull();
  });

  it('round-trips a saved map per device', () => {
    const map: CalibrationMap = { minX: 1, maxX: 2, minY: 3, maxY: 4 };
    saveCalibration(DEVICE, map);
    expect(loadCalibration(DEVICE)).toEqual(map);
    expect(loadCalibration('other-device')).toBeNull();
  });

  it('clearCalibration removes the saved map', () => {
    saveCalibration(DEVICE, { minX: 1, maxX: 2, minY: 3, maxY: 4 });
    clearCalibration(DEVICE);
    expect(loadCalibration(DEVICE)).toBeNull();
  });

  it('returns null on corrupt JSON', () => {
    localStorage.setItem('voicekb.calibration.' + DEVICE, '{not json');
    expect(loadCalibration(DEVICE)).toBeNull();
  });

  it('returns null on structurally invalid data', () => {
    localStorage.setItem('voicekb.calibration.' + DEVICE, JSON.stringify({ minX: 5, maxX: 1, minY: 0, maxY: 10 }));
    expect(loadCalibration(DEVICE)).toBeNull(); // minX >= maxX
    localStorage.setItem('voicekb.calibration.' + DEVICE, JSON.stringify({ minX: 'a', maxX: 1, minY: 0, maxY: 10 }));
    expect(loadCalibration(DEVICE)).toBeNull(); // non-number
    localStorage.setItem('voicekb.calibration.' + DEVICE, JSON.stringify([1, 2, 3, 4]));
    expect(loadCalibration(DEVICE)).toBeNull(); // not an object
  });
});
