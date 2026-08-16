/**
 * Macro templates: literal text mixed with `{token}` special keys/chords and
 * `{{field}}` fill-in fields (see MacroPanel for the UI).
 *
 * Pure module — no BLE/DOM imports beyond protocol.ts; unit-tested in
 * macros.test.ts. Encoding targets the InputStick packet protocol (v6):
 * every segment compiles to framed packets (keyboard-short state reports,
 * absolute pointer, …) that are sent as-is over NUS.
 *
 * Tokens (single braces, case-insensitive, inner whitespace trimmed):
 *   {tab} {enter}                        → Tab / Enter key taps
 *   {esc} {up} {down} {left} {right} {del} {home} {end} {pgup} {pgdn} {f1}–{f12}
 *                                        → special-key taps (HID keycodes)
 *   {ctrl+x} {ctrl+shift+t} {alt+f4}     → one [mask, key] press + release
 *   {{field name}}                       → fill-in field (double braces)
 *   {click 80% 90%}                      → left-click at that percent of the actual
 *                                          screen (via the calibration map)
 *   {click "Save button"}                → left-click at a saved landmark (name
 *                                          matching is case-insensitive)
 *
 * Click tokens encode as an absolute-pointer press+release pair; an
 * unresolvable landmark encodes as zero bytes, never a throw.
 *
 * Unknown or malformed `{...}` tokens are kept as literal text — a macro must
 * never crash and never silently drop user text.
 */
import {
  MODIFIER_BITS,
  encodeAbsolute,
  encodeEditByte,
  encodeSpecialKey,
  encodeText,
  type ModifierKey,
  type SpecialKey,
} from './protocol';
import { IDENTITY_MAP, screenFractionToNorm, type CalibrationMap } from './calibration';

export type ClickTarget =
  | { kind: 'percent'; fx: number; fy: number }
  | { kind: 'landmark'; name: string };

export interface ClickContext {
  map?: CalibrationMap; // default IDENTITY_MAP
  landmark?: (name: string) => { x: number; y: number } | undefined;
}

export type MacroSegment =
  | { type: 'text'; text: string }
  | { type: 'key'; key: SpecialKey }
  | { type: 'byte'; byte: number }
  | { type: 'chord'; mask: number; target: ChordTarget }
  | { type: 'click'; target: ClickTarget }
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
 * Parse a `{click ...}` token. The `click` keyword is case-insensitive;
 * percent values are 0..100 (decimals allowed), landmark names keep their
 * case inside the quotes (matching at encode time is case-insensitive).
 */
function parseClick(inner: string): MacroSegment | null {
  const percent = /^click\s+(\d+(?:\.\d+)?)%\s+(\d+(?:\.\d+)?)%$/i.exec(inner);
  if (percent) {
    const fx = Number(percent[1]);
    const fy = Number(percent[2]);
    if (fx > 100 || fy > 100) return null;
    return { type: 'click', target: { kind: 'percent', fx, fy } };
  }
  const landmark = /^click\s+"([^"]+)"$/i.exec(inner);
  if (landmark) return { type: 'click', target: { kind: 'landmark', name: landmark[1] } };
  return null;
}

/**
 * Parse the inside of a single-brace token. Returns null for unknown or
 * malformed content — the caller then keeps the raw `{...}` as literal text.
 */
function parseToken(raw: string): MacroSegment | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^click\s/i.test(trimmed) || /^click$/i.test(trimmed)) return parseClick(trimmed);
  const inner = trimmed.toLowerCase();
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

function encodeChordTarget(target: ChordTarget, mask: number): Uint8Array {
  switch (target.type) {
    case 'char':
      // encodeText handles the shift needed by the character itself.
      return encodeText(target.char, mask);
    case 'key':
      return encodeSpecialKey(target.key, mask);
    case 'byte':
      return encodeEditByte(target.byte, mask);
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

/** Click = absolute-pointer press then release at the spot (left button). */
function encodeClick(target: ClickTarget, ctx: ClickContext): Uint8Array {
  let pos: { x: number; y: number } | undefined;
  if (target.kind === 'percent') {
    pos = screenFractionToNorm(ctx.map ?? IDENTITY_MAP, target.fx / 100, target.fy / 100);
  } else {
    // No resolver or unknown landmark: encode nothing — never throw.
    pos = ctx.landmark?.(target.name);
    if (!pos) return new Uint8Array(0);
  }
  return concatBytes([encodeAbsolute(0x01, pos.x, pos.y), encodeAbsolute(0, pos.x, pos.y)]);
}

/** Encode one segment; a missing field value encodes as empty text. */
export function encodeSegment(
  segment: MacroSegment,
  values: Record<string, string> = {},
  ctx: ClickContext = {},
): Uint8Array {
  switch (segment.type) {
    case 'text':
      return encodeText(segment.text);
    case 'field':
      return encodeText(values[segment.name] ?? '');
    case 'key':
      return encodeSpecialKey(segment.key);
    case 'byte':
      return encodeEditByte(segment.byte);
    case 'chord':
      return encodeChordTarget(segment.target, segment.mask);
    case 'click':
      return encodeClick(segment.target, ctx);
  }
}

/** Full template → protocol bytes, fields substituted from `values`. */
export function encodeMacro(
  template: string,
  values: Record<string, string> = {},
  ctx: ClickContext = {},
): Uint8Array {
  return concatBytes(tokenizeMacro(template).map((s) => encodeSegment(s, values, ctx)));
}
