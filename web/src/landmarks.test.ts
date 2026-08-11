import { beforeEach, describe, expect, it } from 'vitest';
import { deleteLandmark, findLandmark, loadLandmarks, saveLandmark } from './landmarks';

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

describe('landmarks storage', () => {
  it('returns an empty list when nothing is stored', () => {
    expect(loadLandmarks(DEVICE)).toEqual([]);
  });

  it('saves and loads landmarks per device', () => {
    saveLandmark(DEVICE, { name: 'Save button', x: 100, y: 200 });
    saveLandmark(DEVICE, { name: 'Tray', x: 30000, y: 31000 });
    expect(loadLandmarks(DEVICE)).toEqual([
      { name: 'Save button', x: 100, y: 200 },
      { name: 'Tray', x: 30000, y: 31000 },
    ]);
    expect(loadLandmarks('other-device')).toEqual([]);
  });

  it('upserts by name, case-insensitively', () => {
    saveLandmark(DEVICE, { name: 'Save button', x: 100, y: 200 });
    const updated = saveLandmark(DEVICE, { name: 'save BUTTON', x: 500, y: 600 });
    expect(updated).toEqual([{ name: 'save BUTTON', x: 500, y: 600 }]);
    expect(loadLandmarks(DEVICE)).toHaveLength(1);
  });

  it('returns the new list from saveLandmark', () => {
    const list = saveLandmark(DEVICE, { name: 'A', x: 1, y: 2 });
    expect(list).toEqual([{ name: 'A', x: 1, y: 2 }]);
  });

  it('deletes by name, case-insensitively', () => {
    saveLandmark(DEVICE, { name: 'A', x: 1, y: 2 });
    saveLandmark(DEVICE, { name: 'B', x: 3, y: 4 });
    const remaining = deleteLandmark(DEVICE, 'a');
    expect(remaining).toEqual([{ name: 'B', x: 3, y: 4 }]);
    expect(loadLandmarks(DEVICE)).toEqual([{ name: 'B', x: 3, y: 4 }]);
  });

  it('finds a landmark by name, case-insensitively', () => {
    saveLandmark(DEVICE, { name: 'Save button', x: 100, y: 200 });
    expect(findLandmark(DEVICE, 'save button')).toEqual({ name: 'Save button', x: 100, y: 200 });
    expect(findLandmark(DEVICE, 'SAVE BUTTON')).toEqual({ name: 'Save button', x: 100, y: 200 });
    expect(findLandmark(DEVICE, 'missing')).toBeUndefined();
  });

  it('returns [] on corrupt JSON', () => {
    localStorage.setItem('voicekb.landmarks.' + DEVICE, '{not json');
    expect(loadLandmarks(DEVICE)).toEqual([]);
  });

  it('returns [] when the stored value is not an array', () => {
    localStorage.setItem('voicekb.landmarks.' + DEVICE, JSON.stringify({ name: 'A', x: 1, y: 2 }));
    expect(loadLandmarks(DEVICE)).toEqual([]);
  });

  it('skips entries with empty names or out-of-range coords on load', () => {
    localStorage.setItem(
      'voicekb.landmarks.' + DEVICE,
      JSON.stringify([
        { name: '', x: 1, y: 2 },
        { name: 'neg', x: -1, y: 2 },
        { name: 'big', x: 1, y: 32768 },
        { name: 'nan', x: Number.NaN, y: 0 },
        { name: 'ok', x: 0, y: 32767 },
      ]),
    );
    expect(loadLandmarks(DEVICE)).toEqual([{ name: 'ok', x: 0, y: 32767 }]);
  });
});
