/**
 * v5 dongle macro store — chunked codec and sync helpers.
 *
 * Pure module: no WebBluetooth imports (mirrors the protocol.ts / ble.ts
 * split). BLE plumbing lives in ble.ts; the store orchestrates. Unit-tested
 * in macroSync.test.ts.
 *
 * The dongle persists macros in flash (16 slots, 16 KB total) and is the
 * source of truth. Two vendor characteristics on the same custom service as
 * the v3 config char:
 *
 *   MACRO_LIST  read + notify — JSON array [{"i":0,"name":"...","len":412}]
 *   MACRO_RW    write-with-response + read — chunked JSON protocol:
 *     put: {"op":"put","i":0,"name":"...","off":0,"data":"..."} (+ "fin":true
 *          on the last chunk; `off` is the cumulative byte offset into the
 *          compiled template, `name` only on the first chunk)
 *     del: {"op":"del","i":2}
 *     get: write {"op":"get","i":0,"off":N} then READ →
 *          {"op":"get","i":0,"off":N,"len":TOTAL,"data":"...","fin":true?}
 *
 * `data` encoding: the compiled macro byte stream (UTF-8 text + 0x00 escape
 * tokens, as macros.ts produces) is mapped byte-by-byte into a JSON string.
 * Printable safe ASCII passes through, `"` and `\` use the JSON escapes,
 * every other byte becomes one \u00XX escape (uppercase hex) — strict JSON,
 * so both JSON.parse and the dongle's minimal JSON walker accept it. Because
 * byte maps to its own representation, chunks may split the BYTE stream at
 * any offset — mid-UTF-8-character or mid-escape-sequence — and every chunk
 * is still a valid JSON string on its own. Decode each chunk to bytes and
 * concatenate.
 */
import { SPECIAL_KEYS, type SpecialKey } from './protocol';
import { encodeMacro } from './macros';

export const MACRO_LIST_UUID = '5a1b0002-8c4d-4e2f-9a3b-7c6d5e4f3a2b';
export const MACRO_RW_UUID = '5a1b0003-8c4d-4e2f-9a3b-7c6d5e4f3a2b';

/** Dongle store capacity: 16 slots, 16 KB total. */
export const MACRO_SLOTS = 16;
export const MACRO_STORE_BYTES = 16 * 1024;

/**
 * Hard cap for one ATT payload on MACRO_RW. The spec allows 180; the
 * chunker additionally reserves room for the `"fin":true` flag on every
 * measurement (worst case) plus a fixed safety margin, so generated writes
 * never hug the limit.
 */
export const MACRO_MAX_PAYLOAD = 180;
const PAYLOAD_MARGIN = 8;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function jsonByteLength(value: unknown): number {
  return textEncoder.encode(JSON.stringify(value)).length;
}

/* --- byte ↔ JSON-string `data` encoding --- */

/** Map one byte to its JSON-string representation (see module header). */
export function encodeByte(b: number): string {
  if (b === 0x22) return '\\"';
  if (b === 0x5c) return '\\\\';
  if (b >= 0x20 && b <= 0x7e) return String.fromCharCode(b);
  return '\\u00' + b.toString(16).toUpperCase().padStart(2, '0');
}

/** Encode a byte stream into the `data` string form. */
export function encodeBytes(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += encodeByte(b);
  return out;
}

const HEX = /^[0-9A-Fa-f]{2}$/;
const HEX4 = /^[0-9A-Fa-f]{4}$/;

/**
 * Decode one chunk's `data` string back to bytes. Handles the canonical
 * \u00XX escapes plus the JSON escapes `\"` and `\\`; a literal char with
 * code ≤ 0xFF (what JSON.parse yields for \u00XX) maps to that byte.
 * The legacy \XX form is accepted for robustness. Throws on malformed
 * escapes or characters above U+00FF.
 */
export function decodeBytes(data: string): Uint8Array {
  const out: number[] = [];
  let i = 0;
  while (i < data.length) {
    const ch = data[i];
    if (ch === '\\') {
      const next = data[i + 1];
      if (next === '"') {
        out.push(0x22);
        i += 2;
      } else if (next === '\\') {
        out.push(0x5c);
        i += 2;
      } else if (next === 'u') {
        const hex = data.slice(i + 2, i + 6);
        if (!HEX4.test(hex)) throw new Error(`Bad escape in macro data at ${i}`);
        const value = parseInt(hex, 16);
        if (value > 0xff) throw new Error(`\\u escape above 0xFF in macro data at ${i}`);
        out.push(value);
        i += 6;
      } else {
        const hex = data.slice(i + 1, i + 3);
        if (!HEX.test(hex)) throw new Error(`Bad escape in macro data at ${i}`);
        out.push(parseInt(hex, 16));
        i += 3;
      }
    } else {
      const code = data.charCodeAt(i);
      if (code > 0xff) throw new Error(`Char above U+00FF in macro data at ${i}`);
      out.push(code);
      i++;
    }
  }
  return new Uint8Array(out);
}

/* --- put --- */

export interface PutChunk {
  op: 'put';
  i: number;
  name?: string;
  off: number;
  data: string;
  fin?: boolean;
}

/**
 * Split a compiled macro into put-chunk payloads (UTF-8 encoded JSON), each
 * ≤ maxPayload bytes. `name` rides on the first chunk, `"fin":true` on the
 * last. Chunk boundaries may fall anywhere in the byte stream (mid-UTF-8 or
 * mid-escape-sequence) — see the module header for why that is safe.
 */
export function encodePutChunks(
  index: number,
  name: string,
  bytes: Uint8Array,
  maxPayload = MACRO_MAX_PAYLOAD,
): Uint8Array[] {
  const chunks: PutChunk[] = [];
  let off = 0;
  // An empty template still needs one chunk (name + fin, empty data).
  do {
    const chunkOff = off;
    let data = '';
    while (off < bytes.length) {
      const candidate = data + encodeByte(bytes[off]);
      // Measure the worst case: fin present on every chunk.
      const size = jsonByteLength({
        op: 'put',
        i: index,
        ...(chunks.length === 0 ? { name } : {}),
        off: chunkOff,
        data: candidate,
        fin: true,
      } satisfies PutChunk);
      if (size > maxPayload - PAYLOAD_MARGIN) break;
      data = candidate;
      off++;
    }
    if (data === '' && off < bytes.length) {
      throw new Error('Macro name leaves no room for data in a put chunk');
    }
    chunks.push({
      op: 'put',
      i: index,
      ...(chunks.length === 0 ? { name } : {}),
      off: chunkOff,
      data,
    });
  } while (off < bytes.length);
  chunks[chunks.length - 1].fin = true;
  return chunks.map((c) => textEncoder.encode(JSON.stringify(c)));
}

/* --- del --- */

export function encodeDelete(index: number): Uint8Array {
  return textEncoder.encode(JSON.stringify({ op: 'del', i: index }));
}

/* --- get --- */

export function encodeGetRequest(index: number, offset: number): Uint8Array {
  return textEncoder.encode(JSON.stringify({ op: 'get', i: index, off: offset }));
}

export interface GetChunk {
  index: number;
  offset: number;
  /** Total template byte length (`len` on the wire). */
  total: number;
  data: Uint8Array;
  fin: boolean;
}

/**
 * The `\XX` byte encoding is not valid strict JSON (`\0` is not a JSON
 * escape), so a dongle that emits it verbatim produces response text that
 * JSON.parse rejects. Normalize first: a backslash directly followed by two
 * hex digits (and not itself escaped) gets escaped, turning `\00` into
 * `\\00`. Strictly-encoded responses (`\\00` on the wire) pass through
 * unchanged — after JSON.parse both forms yield the same `data` string for
 * decodeBytes.
 */
function sanitizeByteEscapes(raw: string): string {
  return raw.replace(/(?<!\\)\\(?=[0-9A-Fa-f]{2})/g, '\\\\');
}

/** Parse one MACRO_RW read response. Throws on malformed payloads. */
export function parseGetResponse(text: string): GetChunk {
  let parsed: unknown;
  try {
    parsed = JSON.parse(sanitizeByteEscapes(text));
  } catch {
    throw new Error('Macro get response is not valid JSON');
  }
  const o = parsed as Record<string, unknown>;
  if (
    typeof o !== 'object' ||
    o === null ||
    o.op !== 'get' ||
    typeof o.i !== 'number' ||
    typeof o.off !== 'number' ||
    typeof o.len !== 'number' ||
    typeof o.data !== 'string'
  ) {
    throw new Error('Malformed macro get response');
  }
  return {
    index: o.i,
    offset: o.off,
    total: o.len,
    data: decodeBytes(o.data),
    fin: o.fin === true,
  };
}

/**
 * Reassembles get chunks for one macro. Verifies cumulative offsets and a
 * stable total; returns the full byte stream once `fin` arrives (and
 * requires it to exactly complete the announced total).
 */
export class GetAssembler {
  private expected = 0;
  private total = -1;
  private parts: Uint8Array[] = [];

  constructor(private readonly index: number) {}

  get nextOffset(): number {
    return this.expected;
  }

  push(chunk: GetChunk): Uint8Array | null {
    if (chunk.index !== this.index) {
      throw new Error(`Get response for slot ${chunk.index}, expected slot ${this.index}`);
    }
    if (chunk.offset !== this.expected) {
      throw new Error(`Get chunk offset ${chunk.offset}, expected ${this.expected}`);
    }
    if (this.total === -1) {
      this.total = chunk.total;
    } else if (chunk.total !== this.total) {
      throw new Error(`Get chunk total changed mid-transfer (${chunk.total} vs ${this.total})`);
    }
    this.parts.push(chunk.data);
    this.expected += chunk.data.length;
    if (!chunk.fin) return null;
    if (this.expected !== this.total) {
      throw new Error(`Final get chunk ended at ${this.expected}, announced total ${this.total}`);
    }
    const out = new Uint8Array(this.total);
    let pos = 0;
    for (const part of this.parts) {
      out.set(part, pos);
      pos += part.length;
    }
    return out;
  }
}

/* --- MACRO_LIST --- */

export interface MacroListEntry {
  i: number;
  name: string;
  /** Compiled template byte length. */
  len: number;
}

/** Parse a MACRO_LIST value (`[]` when the store is empty). */
export function parseMacroList(text: string): MacroListEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Macro list is not valid JSON');
  }
  if (!Array.isArray(parsed)) throw new Error('Macro list is not an array');
  const entries: MacroListEntry[] = [];
  for (const item of parsed) {
    const o = item as Record<string, unknown>;
    if (
      typeof o === 'object' &&
      o !== null &&
      Number.isInteger(o.i) &&
      (o.i as number) >= 0 &&
      (o.i as number) < MACRO_SLOTS &&
      typeof o.name === 'string' &&
      typeof o.len === 'number' &&
      o.len >= 0
    ) {
      entries.push({ i: o.i as number, name: o.name, len: o.len });
    }
    // Skip malformed entries rather than failing the whole sync.
  }
  entries.sort((a, b) => a.i - b.i);
  return entries;
}

/* --- storage accounting --- */

/**
 * Byte footprint of one macro in the dongle store: UTF-8 name bytes plus the
 * compiled template bytes. MACRO_LIST reports only template lengths, so the
 * storage meter derives usage as Σ(len + utf8(name)). Any per-slot metadata
 * overhead inside the dongle is not reported and therefore not counted — the
 * meter is a lower bound, and the 16-slot limit is enforced separately.
 */
export function macroFootprint(name: string, templateByteLen: number): number {
  return textEncoder.encode(name).length + templateByteLen;
}

/** Total bytes used according to a MACRO_LIST snapshot (see macroFootprint). */
export function storageUsed(entries: MacroListEntry[]): number {
  return entries.reduce((sum, e) => sum + macroFootprint(e.name, e.len), 0);
}

export interface CopyCandidate {
  name: string;
  templateByteLen: number;
}

export interface CopyPlan {
  /** Candidate index → assigned slot. */
  placements: { candidate: number; slot: number }[];
  /** Candidate indices that did not fit (no free slot or store full). */
  skipped: number[];
}

/**
 * Greedily place candidates into the free slots of an existing store
 * snapshot, first-fit by slot order, respecting both limits. Pure — used for
 * migration ("Copy macros to dongle") and for pushing offline drafts.
 */
export function planCopy(candidates: CopyCandidate[], existing: MacroListEntry[]): CopyPlan {
  const usedSlots = new Set(existing.map((e) => e.i));
  let used = storageUsed(existing);
  const placements: CopyPlan['placements'] = [];
  const skipped: number[] = [];
  let nextSlot = 0;
  for (let c = 0; c < candidates.length; c++) {
    while (nextSlot < MACRO_SLOTS && usedSlots.has(nextSlot)) nextSlot++;
    const footprint = macroFootprint(candidates[c].name, candidates[c].templateByteLen);
    if (nextSlot >= MACRO_SLOTS || used + footprint > MACRO_STORE_BYTES) {
      skipped.push(c);
      continue;
    }
    placements.push({ candidate: c, slot: nextSlot });
    usedSlots.add(nextSlot);
    used += footprint;
  }
  return { placements, skipped };
}

/* --- template decode (dongle bytes → editable template) --- */

/** Reverse of SPECIAL_KEYS for decode: protocol code → token name. */
const CODE_TO_TOKEN = new Map<number, string>();
{
  // Prefer the UI's canonical token spellings where macros.ts has aliases.
  const preferred: Partial<Record<SpecialKey, string>> = {
    delete: 'del',
    pageUp: 'pgup',
    pageDown: 'pgdn',
  };
  for (const [key, code] of Object.entries(SPECIAL_KEYS)) {
    CODE_TO_TOKEN.set(code, preferred[key as SpecialKey] ?? key);
  }
}

const MOD_TOKEN_ORDER: [number, string][] = [
  [0x01, 'ctrl'],
  [0x02, 'shift'],
  [0x04, 'alt'],
  [0x08, 'gui'],
];

function modifierTokens(mask: number): string[] {
  return MOD_TOKEN_ORDER.filter(([bit]) => mask & bit).map(([, name]) => name);
}

/**
 * Best-effort decode of a compiled macro byte stream back into an editable
 * template. Macros authored in this app round-trip: text passes through,
 * 0x09/0x0a become {tab}/{enter}, special keys become {token}, sticky-arm
 * chords (0x81 mask + one key/char) become {ctrl+x}-style tokens, and a
 * click press+release pair (0x91 down/up at one spot) becomes
 * {click x% y%} (percent of screen, identity calibration — the only frame
 * that makes sense on the dongle). Anything unrecognized is rendered as a
 * readable {0xNN} placeholder comment rather than dropped, so the user can
 * see there was content even though re-encoding it is lossy.
 *
 * Note: {{field}} placeholders compile to their (empty) values before
 * upload, so a template fetched back from the dongle has fields expanded —
 * the app keeps the original template for macros it uploaded itself and only
 * falls back to this decode for macros that appear on the dongle from
 * elsewhere.
 */
export function bytesToTemplate(bytes: Uint8Array): string {
  let out = '';
  let text: number[] = [];
  const flushText = () => {
    if (text.length) {
      out += textDecoder.decode(new Uint8Array(text));
      text = [];
    }
  };

  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i];
    if (b === 0x09) {
      flushText();
      out += '{tab}';
      i++;
    } else if (b === 0x0a) {
      flushText();
      out += '{enter}';
      i++;
    } else if (b !== 0x00) {
      text.push(b);
      i++;
      continue;
    } else {
      // 0x00 escape sequences.
      const code = bytes[i + 1];
      const special = CODE_TO_TOKEN.get(code);
      if (special !== undefined) {
        flushText();
        out += `{${special}}`;
        i += 2;
      } else if (code === 0x81 && i + 2 < bytes.length) {
        // Sticky-arm chord: mask + one target (special key or single char).
        flushText();
        const mask = bytes[i + 2];
        const mods = modifierTokens(mask);
        const next = bytes[i + 3];
        const targetSpecial = next === 0x00 ? CODE_TO_TOKEN.get(bytes[i + 4]) : undefined;
        let target = '';
        let consumed = 0;
        if (targetSpecial !== undefined) {
          target = targetSpecial;
          consumed = 2;
        } else if (next === 0x09) {
          target = 'tab';
          consumed = 1;
        } else if (next === 0x0a) {
          target = 'enter';
          consumed = 1;
        } else if (next !== undefined && next !== 0x00) {
          // One UTF-8 encoded code point.
          const len = next < 0x80 ? 1 : next < 0xe0 ? 2 : next < 0xf0 ? 3 : 4;
          target = textDecoder.decode(bytes.slice(i + 3, i + 3 + len));
          consumed = len;
        }
        if (target && mods.length) {
          out += `{${[...mods, target].join('+')}}`;
          i += 3 + consumed;
        } else {
          out += `{0x00 0x81 0x${mask.toString(16).toUpperCase().padStart(2, '0')}}`;
          i += 3;
        }
      } else if (
        code === 0x91 &&
        i + 13 < bytes.length &&
        bytes[i + 7] === 0x00 &&
        bytes[i + 8] === 0x91
      ) {
        // Click: press then release; decode as {click x% y%} when the pair
        // matches encodeClick's shape (press buttons=1, release buttons=0,
        // same coordinates).
        const read = (at: number) => ({
          buttons: bytes[at + 2],
          x: bytes[at + 3] | (bytes[at + 4] << 8),
          y: bytes[at + 5] | (bytes[at + 6] << 8),
        });
        const down = read(i);
        const up = read(i + 7);
        if (down.buttons === 0x01 && up.buttons === 0 && down.x === up.x && down.y === up.y) {
          flushText();
          const pct = (v: number) => Math.round((v / 32767) * 1000) / 10;
          out += `{click ${pct(down.x)}% ${pct(down.y)}%}`;
          i += 14;
        } else {
          flushText();
          out += '{0x00 0x91 …}';
          i += 7;
        }
      } else {
        // Unknown or truncated escape: keep it visible, not silent.
        flushText();
        out += code === undefined ? '{0x00}' : `{0x00 0x${code.toString(16).toUpperCase().padStart(2, '0')}}`;
        i += code === undefined ? 1 : 2;
      }
    }
  }
  flushText();
  return out;
}

/* --- IO-injected transfer helpers (BLE plumbing stays in ble.ts) --- */

/** Minimal transport the transfer helpers need; ble.ts provides it. */
export interface MacroStoreIO {
  write(payload: Uint8Array): Promise<void>;
  read(): Promise<string>;
  /**
   * Optional atomic get round-trip (write the get request + read the
   * response as one serialized unit). Preferred over separate write/read
   * calls when the transport offers it — a write from a concurrent macro
   * operation landing between the two would consume the pending get state.
   */
  getRoundtrip?(payload: Uint8Array): Promise<string>;
}

/** Upload one macro as put chunks, in order. */
export async function pushMacro(
  io: MacroStoreIO,
  index: number,
  name: string,
  bytes: Uint8Array,
): Promise<void> {
  for (const chunk of encodePutChunks(index, name, bytes)) {
    await io.write(chunk);
  }
}

/** Safety bound so a misbehaving dongle cannot loop us forever. */
const MAX_GET_CHUNKS = 1024;

/** Download one macro's full byte stream via chunked get. */
export async function fetchMacroBytes(io: MacroStoreIO, index: number): Promise<Uint8Array> {
  const assembler = new GetAssembler(index);
  for (let n = 0; n < MAX_GET_CHUNKS; n++) {
    const request = encodeGetRequest(index, assembler.nextOffset);
    let response: string;
    if (io.getRoundtrip) {
      response = await io.getRoundtrip(request);
    } else {
      await io.write(request);
      response = await io.read();
    }
    const done = assembler.push(parseGetResponse(response));
    if (done) return done;
  }
  throw new Error('Macro get did not finish');
}

/** Compiled byte length of a template as the dongle will store it. */
export function compiledLength(template: string): number {
  return encodeMacro(template).length;
}
