/**
 * localStorage persistence for user macros, plus example seeding and
 * import/export helpers. Kept DOM-free except for localStorage so the panel
 * stays thin.
 */

export interface Macro {
  id: string;
  name: string;
  template: string;
  /**
   * Dongle slot (0–15) when this macro is stored on the v5 dongle; absent
   * for local drafts that still need to be pushed. Persisted as part of the
   * localStorage read-through cache; re-validated against MACRO_LIST on
   * every connect.
   */
  slot?: number;
}

const STORAGE_KEY = 'voicekb.macros';

/**
 * Offline deletions: when a synced macro is deleted (or a synced macro is
 * edited) while no v5 dongle is connected, the dongle still holds the old
 * copy. We record a tombstone — name + compiled byte length identifies the
 * dongle slot closely enough — and the next sync issues the del op before
 * merging, so offline edits/deletes don't resurrect or duplicate.
 */
const DELETES_STORAGE_KEY = 'voicekb.macroDeletes';

export interface MacroTombstone {
  name: string;
  len: number;
}

export function loadTombstones(): MacroTombstone[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(DELETES_STORAGE_KEY) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (t): t is MacroTombstone =>
        typeof t === 'object' &&
        t !== null &&
        typeof (t as MacroTombstone).name === 'string' &&
        typeof (t as MacroTombstone).len === 'number',
    );
  } catch {
    return [];
  }
}

export function saveTombstones(tombstones: MacroTombstone[]): void {
  try {
    localStorage.setItem(DELETES_STORAGE_KEY, JSON.stringify(tombstones));
  } catch {
    /* storage unavailable — non-fatal */
  }
}

export function addTombstone(tombstone: MacroTombstone): void {
  saveTombstones([...loadTombstones(), tombstone]);
}

export function newMacroId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    /* fall through to the manual id */
  }
  return `macro-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** First-launch examples, clearly marked as such. */
function exampleMacros(): Macro[] {
  return [
    {
      id: newMacroId(),
      name: 'SOAP note (example)',
      template:
        'S:{enter}{{chief complaint}}{enter}{enter}' +
        'O:{enter}{{exam findings}}{enter}{enter}' +
        'A:{enter}{{assessment}}{enter}{enter}' +
        'P:{enter}{{plan}}{enter}',
    },
    {
      id: newMacroId(),
      name: 'Login burst (example)',
      template: '{{username}}{tab}{{password}}{enter}',
    },
  ];
}

function isStoredMacro(value: unknown): value is Macro {
  if (typeof value !== 'object' || value === null) return false;
  const o = value as Record<string, unknown>;
  return typeof o.id === 'string' && typeof o.name === 'string' && typeof o.template === 'string';
}

/** Load macros, seeding the two examples on first load (key absent). */
export function loadMacros(): Macro[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) {
      const seeded = exampleMacros();
      localStorage.setItem(STORAGE_KEY, JSON.stringify(seeded));
      return seeded;
    }
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isStoredMacro);
  } catch {
    return [];
  }
}

export function saveMacros(macros: Macro[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(macros));
  } catch {
    /* storage unavailable — non-fatal */
  }
}

/** Pretty JSON used for export (ids included; import assigns fresh ones). */
export function exportMacrosJson(macros: Macro[]): string {
  return JSON.stringify(macros, null, 2);
}

/**
 * Parse an import file. Throws an Error with a readable message for bad
 * files; the caller appends the result with fresh ids.
 */
export function parseMacrosImport(text: string): { name: string; template: string }[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('That file is not valid JSON.');
  }
  if (!Array.isArray(parsed)) {
    throw new Error('Expected a JSON array of macros.');
  }
  return parsed.map((item, index) => {
    if (typeof item !== 'object' || item === null) {
      throw new Error(`Macro ${index + 1} must be an object with "name" and "template" strings.`);
    }
    const o = item as Record<string, unknown>;
    if (typeof o.name !== 'string' || typeof o.template !== 'string') {
      throw new Error(`Macro ${index + 1} must be an object with "name" and "template" strings.`);
    }
    return { name: o.name, template: o.template };
  });
}
