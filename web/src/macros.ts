/**
 * Macro templates: literal text mixed with `{token}` special keys/chords and
 * `{{field}}` fill-in fields (see MacroPanel for the UI).
 *
 * Pure module — no BLE/DOM imports beyond protocol.ts; unit-tested in
 * macros.test.ts.
 *
 * Tokens (single braces, case-insensitive, inner whitespace trimmed):
 *   {tab} {enter}                        → raw bytes 0x09 / 0x0a
 *   {esc} {up} {down} {left} {right} {del} {home} {end} {pgup} {pgdn} {f1}–{f12}
 *                                        → SPECIAL_KEYS escape sequences
 *   {ctrl+x} {ctrl+shift+t} {alt+f4}     → encodeStickyArm(mask) + key encoding
 *   {{field name}}                       → fill-in field (double braces)
 *
 * Unknown or malformed `{...}` tokens are kept as literal text — a macro must
 * never crash and never silently drop user text.
 */
import {
  MODIFIER_BITS,
  encodeSpecialKey,
  encodeStickyArm,
  encodeText,
  type ModifierKey,
  type SpecialKey,
} from './protocol';

export type MacroSegment =
  | { type: 'text'; text: string }
  | { type: 'key'; key: SpecialKey }
  | { type: 'byte'; byte: number }
  | { type: 'chord'; mask: number; target: ChordTarget }
  | { type: 'field'; name: string };

export type ChordTarget =
  | { type: 'char'; char: string }
  | { type: 'key'; key: SpecialKey }
  | { type: 'byte'; byte: number };

const TAB = 0x09;
const ENTER = 0x0a;

/** Single-brace token name (lowercase) → special key. */
const KEY_TOKENS: Record<string, SpecialKey> = {
  esc: 'esc',
  up: 'up',
  down: 'down',
  left: 'left',
  right: 'right',
  del: 'delete',
  delete: 'delete',
  home: 'home',
  end: 'end',
  pgup: 'pageUp',
  pageup: 'pageUp',
  pgdn: 'pageDown',
  pagedown: 'pageDown',
  f1: 'f1',
  f2: 'f2',
  f3: 'f3',
  f4: 'f4',
  f5: 'f5',
  f6: 'f6',
  f7: 'f7',
  f8: 'f8',
  f9: 'f9',
  f10: 'f10',
  f11: 'f11',
  f12: 'f12',
};

/** Single-brace token name (lowercase) → raw byte. */
const BYTE_TOKENS: Record<string, number> = {
  tab: TAB,
  enter: ENTER,
};

/** A plain (modifier-less) token, or null when the name is unknown. */
function lookupSimple(name: string): MacroSegment | null {
  const key = KEY_TOKENS[name];
  if (key) return { type: 'key', key };
  const byte = BYTE_TOKENS[name];
  if (byte !== undefined) return { type: 'byte', byte };
  return null;
}

/** The final part of a chord: a token name or a single character. */
function chordTarget(name: string): ChordTarget | null {
  const key = KEY_TOKENS[name];
  if (key) return { type: 'key', key };
  const byte = BYTE_TOKENS[name];
  if (byte !== undefined) return { type: 'byte', byte };
  // Single character typed via encodeText (code-point count, so emoji count
  // as one). Letters are lowercased — {ctrl+X} means ctrl+x.
  if ([...name].length === 1) return { type: 'char', char: name.toLowerCase() };
  return null;
}

/**
 * Parse the inside of a single-brace token. Returns null for unknown or
 * malformed content — the caller then keeps the raw `{...}` as literal text.
 */
function parseToken(raw: string): MacroSegment | null {
  const inner = raw.trim().toLowerCase();
  if (!inner) return null;
  if (!inner.includes('+')) return lookupSimple(inner);

  const parts = inner.split('+').map((p) => p.trim());
  // An empty part (e.g. "{ctrl+}") has no encoding — treat as literal.
  if (parts.some((p) => p === '')) return null;

  let mask = 0;
  for (const part of parts.slice(0, -1)) {
    const bit = MODIFIER_BITS[part as ModifierKey];
    if (bit === undefined) return null;
    mask |= bit;
  }
  const target = chordTarget(parts[parts.length - 1]);
  if (!target) return null;
  return { type: 'chord', mask, target };
}

/** Split a template into segments; adjacent literal text is coalesced. */
export function tokenizeMacro(template: string): MacroSegment[] {
  const segments: MacroSegment[] = [];
  let text = '';
  const flush = () => {
    if (text) {
      segments.push({ type: 'text', text });
      text = '';
    }
  };

  let i = 0;
  while (i < template.length) {
    if (template[i] === '{') {
      if (template[i + 1] === '{') {
        // Fill-in field: {{field name}}
        const end = template.indexOf('}}', i + 2);
        if (end !== -1) {
          const name = template.slice(i + 2, end).trim();
          if (name) {
            flush();
            segments.push({ type: 'field', name });
            i = end + 2;
            continue;
          }
        }
        // Not a well-formed field — fall through and keep it literal.
      } else {
        const end = template.indexOf('}', i + 1);
        if (end !== -1) {
          const segment = parseToken(template.slice(i + 1, end));
          if (segment) {
            flush();
            segments.push(segment);
            i = end + 1;
            continue;
          }
        }
      }
    }
    text += template[i];
    i++;
  }
  flush();
  return segments;
}

/** Unique field names in first-use order (a repeated field is asked once). */
export function macroFields(template: string): string[] {
  const names: string[] = [];
  for (const segment of tokenizeMacro(template)) {
    if (segment.type === 'field' && !names.includes(segment.name)) names.push(segment.name);
  }
  return names;
}

function encodeChordTarget(target: ChordTarget): Uint8Array {
  switch (target.type) {
    case 'char':
      return encodeText(target.char);
    case 'key':
      return encodeSpecialKey(target.key);
    case 'byte':
      return new Uint8Array([target.byte]);
  }
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Encode one segment; a missing field value encodes as empty text. */
export function encodeSegment(segment: MacroSegment, values: Record<string, string> = {}): Uint8Array {
  switch (segment.type) {
    case 'text':
      return encodeText(segment.text);
    case 'field':
      return encodeText(values[segment.name] ?? '');
    case 'key':
      return encodeSpecialKey(segment.key);
    case 'byte':
      return new Uint8Array([segment.byte]);
    case 'chord':
      // Sticky arm auto-releases after one keystroke (v2 protocol).
      return concatBytes([encodeStickyArm(segment.mask), encodeChordTarget(segment.target)]);
  }
}

/** Full template → protocol bytes, fields substituted from `values`. */
export function encodeMacro(template: string, values: Record<string, string> = {}): Uint8Array {
  return concatBytes(tokenizeMacro(template).map((s) => encodeSegment(s, values)));
}
