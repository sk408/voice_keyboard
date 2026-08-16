/**
 * Voice Keyboard — InputStick packet protocol client (firmware v6+).
 *
 * Pure encoding/parsing helpers, unit-tested in protocol.test.ts.
 * Authoritative references: ../INPUTSTICK_EMULATION_SPEC.md and
 * ../firmware/src/inputstick.c (the dongle's own packet layer).
 *
 * This replaces the v1–v5 raw ASCII/escape byte stream. Firmware v6 speaks
 * framed InputStick packets only:
 *
 *   byte 0       : 0x55 start tag
 *   byte 1       : header = (payload length in 16-byte blocks, bits 0..5)
 *                        | flags (0x80 response requested, 0x40 encrypted,
 *                        |        0x20 HMAC — we never set 0x40/0x20)
 *   bytes 2..N-1 : payload, 16*blocks bytes, zero-padded:
 *                     payload[0..3]  CRC32 (IEEE 802.3 / "zlib") big-endian,
 *                                    over payload[4..end]
 *                     payload[4]     command
 *                     payload[5]     param (= report count for HID data)
 *                     payload[6..]   data
 *                  Notifications (dongle → app, e.g. 0x2F) omit the param
 *                  byte: data starts at payload[5].
 *
 * The dongle's RX parser is a byte-stream state machine, so packets may be
 * written to the NUS RX characteristic in arbitrary ≤20-byte chunks.
 */

export const NUS_SERVICE_UUID = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
export const NUS_RX_UUID = '6e400002-b5a3-f393-e0a9-e50e24dcca9e'; // central → dongle
export const NUS_TX_UUID = '6e400003-b5a3-f393-e0a9-e50e24dcca9e'; // dongle → central (notify)

/** v6 firmware advertises with the fixed name "InputStick" (ble.c). */
export const ADVERTISED_NAME_PREFIX = 'InputStick';

/* --- framing (spec §3, inputstick.c) --- */

export const IS_TAG = 0x55;
export const IS_FLAG_HMAC = 0x20;
export const IS_FLAG_ENCRYPTED = 0x40;
export const IS_FLAG_RESPONSE = 0x80;
const IS_BLOCK = 16;
const IS_MAX_BLOCKS = 17;

/* --- commands (spec §4) — the subset this app sends or parses --- */

export const CMD = {
  RunFirmware: 0x04,
  GetFirmwareInfo: 0x10,
  Init: 0x11, // Android CMD_INIT = iOS WdgReset
  HidRequestStatus: 0x20,
  HidKeyboard: 0x21,
  HidConsumer: 0x22,
  HidMouse: 0x23,
  HidTouch: 0x26,
  HidClear: 0x2a,
  HidKeyboardShort: 0x2c,
  HidStatusNotification: 0x2f,
  SetUpdateInterval: 0x31,
} as const;

/** Response code the dongle uses for success. */
export const RESP_OK = 0x01;

/** USB state values carried in HIDStatusNotification data[0] (spec §8). */
export const USB_DISCONNECTED = 0x00;
export const USB_CONFIGURED = 0x05;

/* --- CRC32 (IEEE 802.3, reflected, init/xorout 0xFFFFFFFF) --- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/** crc32('123456789') === 0xCBF43926. */
export function crc32(data: Uint8Array, start = 0, end = data.length): number {
  let crc = 0xffffffff;
  for (let i = start; i < end; i++) {
    crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/* --- packet building --- */

/**
 * Build one framed packet: CRC + command + param + data, zero-padded to a
 * 16-byte block multiple. `response` sets the 0x80 flag (handshake packets
 * the dongle must answer).
 */
export function buildPacket(
  cmd: number,
  param: number,
  data: Uint8Array = new Uint8Array(0),
  response = false,
): Uint8Array {
  const payloadLen = 6 + data.length;
  const blocks = Math.floor((payloadLen - 1) / IS_BLOCK) + 1;
  if (blocks > IS_MAX_BLOCKS) throw new Error('packet too large');
  const total = blocks * IS_BLOCK;
  const out = new Uint8Array(2 + total);
  out[0] = IS_TAG;
  out[1] = blocks | (response ? IS_FLAG_RESPONSE : 0);
  const pl = 2; // payload starts at out[2]
  out[pl + 4] = cmd;
  out[pl + 5] = param;
  out.set(data, pl + 6);
  const crc = crc32(out, pl + 4, pl + total);
  out[pl + 0] = (crc >>> 24) & 0xff;
  out[pl + 1] = (crc >>> 16) & 0xff;
  out[pl + 2] = (crc >>> 8) & 0xff;
  out[pl + 3] = crc & 0xff;
  return out;
}

/* --- packet parsing (TX notifications) --- */

export interface RxPacket {
  cmd: number;
  /** param/response code; null for notifications (0x2F & friends have none). */
  param: number | null;
  /** Data after cmd (+param). Includes trailing zero padding. */
  data: Uint8Array;
  /** Sender set the response-requested flag. */
  responseFlag: boolean;
}

/** Commands the dongle sends as notifications (no param byte, data at [5]). */
const NOTIFICATION_COMMANDS = new Set([CMD.HidStatusNotification, 0x1e, 0x1f]);

/**
 * Byte-stream packet parser, mirroring the firmware's inputstick_feed().
 * Feed arbitrary chunks (notifications arrive in ≤20-byte pieces); complete,
 * CRC-valid packets are returned. Garbage and CRC failures are skipped.
 */
export class PacketParser {
  private state: 'tag' | 'header' | 'payload' = 'tag';
  private flags = 0;
  private total = 0;
  private buf = new Uint8Array(IS_MAX_BLOCKS * IS_BLOCK);
  private len = 0;

  feed(chunk: Uint8Array): RxPacket[] {
    const out: RxPacket[] = [];
    for (const b of chunk) {
      switch (this.state) {
        case 'tag':
          if (b === IS_TAG) this.state = 'header';
          break;
        case 'header': {
          const blocks = b & 0x3f;
          this.flags = b & 0xe0;
          if (blocks < 1 || blocks > IS_MAX_BLOCKS) {
            this.state = 'tag';
            break;
          }
          this.total = blocks * IS_BLOCK;
          this.len = 0;
          this.state = 'payload';
          break;
        }
        case 'payload':
          this.buf[this.len++] = b;
          if (this.len === this.total) {
            const packet = this.decode();
            if (packet) out.push(packet);
            this.state = 'tag';
          }
          break;
      }
    }
    return out;
  }

  private decode(): RxPacket | null {
    const pl = this.buf.subarray(0, this.total);
    const crcRx =
      ((pl[0] << 24) | (pl[1] << 16) | (pl[2] << 8) | pl[3]) >>> 0;
    if (crcRx !== crc32(pl, 4, this.total)) return null;
    const cmd = pl[4];
    if (NOTIFICATION_COMMANDS.has(cmd)) {
      return {
        cmd,
        param: null,
        data: pl.slice(5, this.total),
        responseFlag: (this.flags & IS_FLAG_RESPONSE) !== 0,
      };
    }
    return {
      cmd,
      param: pl[5],
      data: pl.slice(6, this.total),
      responseFlag: (this.flags & IS_FLAG_RESPONSE) !== 0,
    };
  }
}

/* --- HID keyboard: US-layout text → [modifiers, keycode] ----------------
 *
 * Firmware v6 forwards every KeyboardShort (0x2C) report 1:1 as a USB
 * keyboard *state* report: the next report replaces/releases the previous
 * key. Typing a character therefore takes two reports — press [mods, key],
 * then release back to the held state [heldMods, 0] — and a [mods, 0]
 * release report must never be skipped (inputstick.c:313-323).
 */

/** HID boot-protocol modifier bits (left-hand). Unchanged from v2. */
export const MODIFIER_BITS = {
  ctrl: 0x01,
  shift: 0x02,
  alt: 0x04,
  gui: 0x08,
} as const;

export type ModifierKey = keyof typeof MODIFIER_BITS;

const SHIFT = MODIFIER_BITS.shift;

/** USB HID usage IDs (page 0x07) for named keys. */
export const KEY = {
  backspace: 0x2a,
  tab: 0x2b,
  enter: 0x28,
  esc: 0x29,
  space: 0x2c,
} as const;

/**
 * Special keys → HID keycodes (page 0x07). Key names are stable UI
 * identifiers shared with macros.ts; the values are standard HID.
 */
export const SPECIAL_KEYS = {
  esc: 0x29,
  up: 0x52,
  down: 0x51,
  left: 0x50,
  right: 0x4f,
  delete: 0x4c,
  home: 0x4a,
  end: 0x4d,
  pageUp: 0x4b,
  pageDown: 0x4e,
  f1: 0x3a,
  f2: 0x3b,
  f3: 0x3c,
  f4: 0x3d,
  f5: 0x3e,
  f6: 0x3f,
  f7: 0x40,
  f8: 0x41,
  f9: 0x42,
  f10: 0x43,
  f11: 0x44,
  f12: 0x45,
} as const;

export type SpecialKey = keyof typeof SPECIAL_KEYS;

/** Unshifted printable ASCII → keycode. */
const UNSHIFTED: Record<string, number> = {
  ' ': KEY.space,
  "'": 0x34,
  ',': 0x36,
  '-': 0x2d,
  '.': 0x37,
  '/': 0x38,
  '0': 0x27,
  ';': 0x33,
  '=': 0x2e,
  '[': 0x2f,
  '\\': 0x31,
  ']': 0x30,
  '`': 0x35,
};
for (let i = 0; i < 26; i++) {
  UNSHIFTED[String.fromCharCode(97 + i)] = 0x04 + i; // a–z
}
for (let d = 1; d <= 9; d++) {
  UNSHIFTED[String(d)] = 0x1d + d; // 1–9
}

/** Shifted printable ASCII → keycode (sent with left shift). */
const SHIFTED: Record<string, number> = {
  '!': 0x1e,
  '@': 0x1f,
  '#': 0x20,
  $: 0x21,
  '%': 0x22,
  '^': 0x23,
  '&': 0x24,
  '*': 0x25,
  '(': 0x26,
  ')': 0x27,
  _: 0x2d,
  '+': 0x2e,
  '{': 0x2f,
  '}': 0x30,
  '|': 0x31,
  ':': 0x33,
  '"': 0x34,
  '~': 0x35,
  '<': 0x36,
  '>': 0x37,
  '?': 0x38,
};

export interface KeyStroke {
  /** Extra modifier bits this stroke needs (shift for capitals/symbols). */
  shift: number;
  key: number;
}

/**
 * Map one character to its US-layout keystroke, or null when it cannot be
 * typed with a plain US HID keyboard (emoji, accented letters, CJK… — the
 * dictation path drops those, exactly like the pre-v6 firmware dropped
 * non-ASCII it could not type).
 */
export function charToKey(ch: string): KeyStroke | null {
  if (ch === '\n' || ch === '\r') return { shift: 0, key: KEY.enter };
  if (ch === '\t') return { shift: 0, key: KEY.tab };
  if (ch === '\b') return { shift: 0, key: KEY.backspace };
  if (ch >= 'A' && ch <= 'Z') return { shift: SHIFT, key: 0x04 + ch.charCodeAt(0) - 65 };
  const unshifted = UNSHIFTED[ch];
  if (unshifted !== undefined) return { shift: 0, key: unshifted };
  const shifted = SHIFTED[ch];
  if (shifted !== undefined) return { shift: SHIFT, key: shifted };
  return null;
}

/** One keyboard-short report: [modifiers, keycode]. */
export type KbdReport = [number, number];

/**
 * Text → press/release report pairs. Each character becomes
 * [pressMods | charShift, key] then [releaseMods, 0] (the firmware forwards
 * state reports 1:1, so the release is how the key comes back up; with held
 * modifiers the release restores them instead of dropping to 0).
 * Characters with no US-layout mapping are dropped.
 */
export function textToReports(text: string, pressMods = 0, releaseMods = 0): KbdReport[] {
  const reports: KbdReport[] = [];
  for (const ch of text) {
    const stroke = charToKey(ch);
    if (!stroke) continue;
    reports.push([(pressMods | stroke.shift) & 0xff, stroke.key]);
    reports.push([releaseMods & 0xff, 0]);
  }
  return reports;
}

/**
 * Max reports per 0x2C packet. Keeps packets small enough that the
 * app-side free-space model (capacity 128/interface) can always fit one,
 * and bounds how much one stalled packet holds up.
 */
export const MAX_REPORTS_PER_PACKET = 32;

/** Reports → one or more framed HIDDataKeyboardShort (0x2C) packets. */
export function packetKeyboardShort(reports: KbdReport[]): Uint8Array {
  const parts: Uint8Array[] = [];
  for (let i = 0; i < reports.length; i += MAX_REPORTS_PER_PACKET) {
    const slice = reports.slice(i, i + MAX_REPORTS_PER_PACKET);
    const data = new Uint8Array(slice.length * 2);
    for (let j = 0; j < slice.length; j++) {
      data[j * 2] = slice[j][0];
      data[j * 2 + 1] = slice[j][1];
    }
    parts.push(buildPacket(CMD.HidKeyboardShort, slice.length, data));
  }
  return concatBytes(parts);
}

/** Dictation/compose path: text → framed 0x2C packets (press+release per char). */
export function encodeText(text: string, pressMods = 0, releaseMods = 0): Uint8Array {
  return packetKeyboardShort(textToReports(text, pressMods, releaseMods));
}

/** One special key tap (press + release) as a 0x2C packet. */
export function encodeSpecialKey(key: SpecialKey, pressMods = 0, releaseMods = 0): Uint8Array {
  return packetKeyboardShort([
    [pressMods & 0xff, SPECIAL_KEYS[key]],
    [releaseMods & 0xff, 0],
  ]);
}

/**
 * Set the held modifier state without a key: a single [mask, 0] report.
 * This is both "hold these modifiers" and (mask 0) "release everything" —
 * the state-report model needs no separate opcodes.
 */
export function encodeModifierState(mask: number): Uint8Array {
  return packetKeyboardShort([[mask & 0xff, 0]]);
}

/**
 * Editing keys that the old protocol carried as raw bytes (macros use these
 * for {tab}/{enter} tokens): byte → keycode, or null if not an editing byte.
 */
const EDIT_BYTE_KEYS: Record<number, number> = {
  0x08: KEY.backspace,
  0x09: KEY.tab,
  0x0a: KEY.enter,
};

/** One editing byte (0x08/0x09/0x0a) as a tap; other bytes encode as empty. */
export function encodeEditByte(byte: number, pressMods = 0, releaseMods = 0): Uint8Array {
  const key = EDIT_BYTE_KEYS[byte];
  if (key === undefined) return new Uint8Array(0);
  return packetKeyboardShort([
    [pressMods & 0xff, key],
    [releaseMods & 0xff, 0],
  ]);
}

/* --- live-edit diffing (unchanged from v1: pure string math) --- */

/**
 * Compute the edit operations that turn `prev` into `next`, in protocol
 * order: N backspaces followed by inserted text. Diffing on the JS string
 * is what makes Gboard dictation/autocorrect rewrites safe (see v1 notes).
 */
export function diffEdits(prev: string, next: string): { backspaces: number; insert: string } {
  let start = 0;
  const maxStart = Math.min(prev.length, next.length);
  while (start < maxStart && prev[start] === next[start]) start++;

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

/** Encode an edit as packets: backspace taps, then the inserted text. */
export function encodeEdit(prev: string, next: string, pressMods = 0, releaseMods = 0): Uint8Array {
  const { backspaces, insert } = diffEdits(prev, next);
  const reports: KbdReport[] = [];
  for (let i = 0; i < backspaces; i++) {
    reports.push([pressMods & 0xff, KEY.backspace], [releaseMods & 0xff, 0]);
  }
  return packetKeyboardShort([...reports, ...textToReports(insert, pressMods, releaseMods)]);
}

/* --- mouse / absolute pointer / consumer --- */

export const MOUSE_BUTTON_LEFT = 0x01;
export const MOUSE_BUTTON_RIGHT = 0x02;
export const MOUSE_BUTTON_MIDDLE = 0x04;

/** Deltas are signed int8; the HID descriptor declares -127..127. */
function clampAxis(v: number): number {
  return Math.max(-127, Math.min(127, Math.round(v)));
}

/** One relative mouse report as a HIDDataMouse (0x23) packet: [buttons, dx, dy, scroll]. */
export function encodeMouse(buttons: number, dx: number, dy: number, wheel: number): Uint8Array {
  return buildPacket(
    CMD.HidMouse,
    1,
    new Uint8Array([buttons & 0xff, clampAxis(dx) & 0xff, clampAxis(dy) & 0xff, clampAxis(wheel) & 0xff]),
  );
}

/**
 * One absolute pointer report as a HIDDataTouchScreen (0x26) packet:
 * [reportID 4, tip+in_range, x_lsb, x_msb, y_lsb, y_msb].
 *
 * Callers use the app's normalized 0..32767 coordinates; the InputStick
 * wire format is 16-bit and the firmware scales back down by one bit
 * (inputstick.c hid_touch), so we scale up ×2 here. `buttons` bit 0 is the
 * tip switch (left click); the in-range bit is always set.
 */
export function encodeAbsolute(buttons: number, x: number, y: number): Uint8Array {
  const tip = buttons & 0x01 ? 0x01 : 0x00;
  const sx = Math.max(0, Math.min(32767, Math.round(x))) * 2;
  const sy = Math.max(0, Math.min(32767, Math.round(y))) * 2;
  return buildPacket(
    CMD.HidTouch,
    1,
    new Uint8Array([0x04, 0x02 | tip, sx & 0xff, (sx >> 8) & 0xff, sy & 0xff, (sy >> 8) & 0xff]),
  );
}

/** One consumer-control report (media keys) as a HIDDataConsumer (0x22) packet. */
export function encodeConsumer(usage: number): Uint8Array {
  return buildPacket(CMD.HidConsumer, 1, new Uint8Array([0x01, usage & 0xff, (usage >> 8) & 0xff]));
}

/** Common consumer usages (HID consumer page 0x0C). */
export const CONSUMER_USAGE = {
  playPause: 0x00cd,
  nextTrack: 0x00b5,
  prevTrack: 0x00b6,
  mute: 0x00e2,
  volumeUp: 0x00e9,
  volumeDown: 0x00ea,
} as const;

/* --- HIDStatusNotification (0x2F) parsing + flow-control model --- */

export interface HidStatus {
  usbState: number;
  keyboardLeds: number;
  keyboardEmpty: boolean;
  mouseEmpty: boolean;
  consumerEmpty: boolean;
  /** Reports drained to USB since the previous notification (spec §6.1). */
  keyboardSent: number;
  mouseSent: number;
  consumerSent: number;
}

/**
 * Parse the data of a HIDStatusNotification (offsets per spec §7; the
 * firmware's 11-byte layout has the 0xFF gate at data[10] — we don't gate
 * on it, drain counts at data[7..9] are always valid from our firmware).
 */
export function parseHidStatus(data: Uint8Array): HidStatus {
  const b = (i: number) => (i < data.length ? data[i] : 0);
  return {
    usbState: b(0),
    keyboardLeds: b(1),
    keyboardEmpty: b(3) !== 0,
    mouseEmpty: b(5) !== 0,
    consumerEmpty: b(6) !== 0,
    keyboardSent: b(7),
    mouseSent: b(8),
    consumerSent: b(9),
  };
}

/**
 * Per-interface flow-control identity. The dongle's HID report queue is a
 * single 256-deep FIFO, but the protocol models per-interface free space of
 * 128 keyboard + 64 mouse + 64 consumer reports (usb_kbd.c). Absolute
 * pointer (0x26) reports drain into the consumer counter firmware-side, so
 * they are accounted against 'consumer' here.
 */
export type HidInterface = 'keyboard' | 'mouse' | 'consumer';

export const HID_BUFFER_CAPACITY: Record<HidInterface, number> = {
  keyboard: 128,
  mouse: 64,
  consumer: 64,
};

/** Which interface a HID data command debits, or null for non-HID commands. */
export function packetInterface(cmd: number): HidInterface | null {
  switch (cmd) {
    case CMD.HidKeyboard:
    case CMD.HidKeyboardShort:
      return 'keyboard';
    case CMD.HidMouse:
      return 'mouse';
    case CMD.HidConsumer:
    case CMD.HidTouch:
      return 'consumer';
    default:
      return null;
  }
}

/* --- byte utilities --- */

export function concatBytes(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * Split framed bytes into ATT-write-sized chunks. The dongle's RX parser is
 * a byte-stream state machine and the negotiated MTU stays at the 20-byte
 * floor, so chunks are plain 20-byte slices — packet boundaries don't matter.
 */
export function chunkPayload(data: Uint8Array, chunkSize = 20): Uint8Array[] {
  if (chunkSize < 1) throw new Error('chunkSize must be positive');
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < data.length; offset += chunkSize) {
    chunks.push(data.slice(offset, offset + chunkSize));
  }
  return chunks;
}

/**
 * Walk a buffer of concatenated framed packets, yielding each packet slice
 * plus its command and param. Throws on malformed framing — all bytes sent
 * through the BLE layer must be whole InputStick packets.
 */
export function* iteratePackets(data: Uint8Array): Generator<{ packet: Uint8Array; cmd: number; param: number }> {
  let offset = 0;
  while (offset < data.length) {
    if (data[offset] !== IS_TAG || offset + 2 > data.length) {
      throw new Error('malformed InputStick packet stream (bad tag)');
    }
    const blocks = data[offset + 1] & 0x3f;
    if (blocks < 1 || blocks > IS_MAX_BLOCKS) {
      throw new Error('malformed InputStick packet stream (bad block count)');
    }
    const len = 2 + blocks * IS_BLOCK;
    if (offset + len > data.length) {
      throw new Error('malformed InputStick packet stream (truncated packet)');
    }
    const packet = data.slice(offset, offset + len);
    yield { packet, cmd: packet[6], param: packet[7] };
    offset += len;
  }
}
