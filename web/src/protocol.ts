/**
 * Voice Keyboard BLE Protocol v1 — see ../PROTOCOL.md.
 *
 * Pure encoding helpers, unit-tested in protocol.test.ts.
 * The dongle types bytes as they arrive, rate-limited in firmware.
 */

export const NUS_SERVICE_UUID = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
export const NUS_RX_UUID = '6e400002-b5a3-f393-e0a9-e50e24dcca9e'; // central → dongle
export const NUS_TX_UUID = '6e400003-b5a3-f393-e0a9-e50e24dcca9e'; // dongle → central (notify)
export const ADVERTISED_NAME_PREFIX = 'VoiceKB';

/** TX status notification values. */
export const STATUS_IDLE = 0x00;
export const STATUS_BUSY = 0x01;

const ESCAPE = 0x00;

/**
 * Special keys sent as `0x00 <code>`. Maps UI key id → protocol code.
 * Codes are fixed by PROTOCOL.md — do not renumber.
 */
export const SPECIAL_KEYS = {
  esc: 0x01,
  up: 0x02,
  down: 0x03,
  left: 0x04,
  right: 0x05,
  delete: 0x06,
  home: 0x07,
  end: 0x08,
  pageUp: 0x09,
  pageDown: 0x0a,
  f1: 0x10,
  f2: 0x11,
  f3: 0x12,
  f4: 0x13,
  f5: 0x14,
  f6: 0x15,
  f7: 0x16,
  f8: 0x17,
  f9: 0x18,
  f10: 0x19,
  f11: 0x1a,
  f12: 0x1b,
} as const;

export type SpecialKey = keyof typeof SPECIAL_KEYS;

/** Encode one special key as its two-byte escaped sequence. */
export function encodeSpecialKey(key: SpecialKey): Uint8Array {
  return new Uint8Array([ESCAPE, SPECIAL_KEYS[key]]);
}

const encoder = new TextEncoder();

/**
 * Encode text for the RX payload.
 *
 * Printable UTF-8 passes through; `\n` → Enter, `\t` → Tab, `0x08` →
 * Backspace are already single bytes and pass through unchanged.
 * A literal NUL in the input would be misread by the dongle as the escape
 * prefix, so it is dropped (there is no way to type one anyway).
 */
export function encodeText(text: string): Uint8Array {
  const clean = text.replace(/\u0000/g, '');
  return encoder.encode(clean);
}

/** Backspace as produced by the editing diff. */
export const BACKSPACE = 0x08;

/**
 * Compute the edit operations that turn `prev` into `next`, in protocol
 * order: N backspaces followed by inserted text. Returns the byte count
 * of the tail of `prev` that must be deleted and the replacement text.
 *
 * This is what live mode uses: Gboard dictation, autocorrect and
 * suggestions can rewrite arbitrary spans (not just append at the end),
 * so a naive "send the new char" approach corrupts the PC-side text.
 * Diffing on the JS string (UTF-16) is safe because backspace and text
 * edits are code-point level and we re-encode the inserted span.
 */
export function diffEdits(prev: string, next: string): { backspaces: number; insert: string } {
  // Longest common prefix.
  let start = 0;
  const maxStart = Math.min(prev.length, next.length);
  while (start < maxStart && prev[start] === next[start]) start++;

  // Longest common suffix that doesn't overlap the prefix.
  let endPrev = prev.length;
  let endNext = next.length;
  while (endPrev > start && endNext > start && prev[endPrev - 1] === next[endNext - 1]) {
    endPrev--;
    endNext--;
  }

  return {
    backspaces: endPrev - start,
    insert: next.slice(start, endNext),
  };
}

/** Encode an edit as protocol bytes: backspaces then inserted text. */
export function encodeEdit(prev: string, next: string): Uint8Array {
  const { backspaces, insert } = diffEdits(prev, next);
  const text = encodeText(insert);
  const out = new Uint8Array(backspaces + text.length);
  out.fill(BACKSPACE, 0, backspaces);
  out.set(text, backspaces);
  return out;
}

/**
 * Split a payload into chunks small enough for a single ATT write.
 * Web Bluetooth does not expose the negotiated MTU; 20 bytes is the
 * ATT_MTU 23 payload floor and works on every link. Chunks are never
 * split mid UTF-8 sequence (encoder output is byte-level, so we just
 * avoid cutting inside a multi-byte char by chunking the string first —
 * here we chunk bytes but callers encode whole code points, so a cut can
 * only fall inside a multi-byte sequence if the payload exceeds the chunk
 * size mid-character; scanning for UTF-8 continuation bytes keeps each
 * write decodable on its own).
 */
export function chunkPayload(data: Uint8Array, chunkSize = 20): Uint8Array[] {
  if (chunkSize < 4) throw new Error('chunkSize too small for UTF-8 safety');
  const chunks: Uint8Array[] = [];
  let offset = 0;
  while (offset < data.length) {
    let end = Math.min(offset + chunkSize, data.length);
    // Don't split inside a UTF-8 multi-byte sequence or the 0x00 escape pair.
    while (end > offset && end < data.length) {
      const b = data[end];
      const isContinuation = (b & 0xc0) === 0x80;
      const prevIsEscape = data[end - 1] === ESCAPE && isSpecialCode(b);
      if (!isContinuation && !prevIsEscape) break;
      end--;
    }
    if (end === offset) end = Math.min(offset + chunkSize, data.length); // pathological; just cut
    chunks.push(data.slice(offset, end));
    offset = end;
  }
  return chunks;
}

function isSpecialCode(b: number): boolean {
  return (b >= 0x01 && b <= 0x0a) || (b >= 0x10 && b <= 0x1b);
}

/** Parse a TX status notification. */
export function parseStatus(value: DataView): 'idle' | 'busy' | 'error' {
  const b = value.getUint8(0);
  if (b === STATUS_IDLE) return 'idle';
  if (b === STATUS_BUSY) return 'busy';
  return 'error';
}
