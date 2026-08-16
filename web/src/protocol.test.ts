import { describe, expect, it } from 'vitest';
import {
  CMD,
  HID_BUFFER_CAPACITY,
  IS_FLAG_RESPONSE,
  IS_TAG,
  KEY,
  MODIFIER_BITS,
  MOUSE_BUTTON_LEFT,
  MOUSE_BUTTON_MIDDLE,
  MOUSE_BUTTON_RIGHT,
  PacketParser,
  SPECIAL_KEYS,
  buildPacket,
  charToKey,
  chunkPayload,
  crc32,
  diffEdits,
  encodeAbsolute,
  encodeConsumer,
  encodeEdit,
  encodeEditByte,
  encodeModifierState,
  encodeMouse,
  encodeSpecialKey,
  encodeText,
  iteratePackets,
  packetInterface,
  parseHidStatus,
  textToReports,
  type KbdReport,
} from './protocol';

function bytes(...nums: number[]): Uint8Array {
  return new Uint8Array(nums);
}

/** Parse a buffer of framed packets into decoded packet objects. */
function parseAll(data: Uint8Array) {
  return new PacketParser().feed(data);
}

/** Decode 0x2C packet bytes into their [modifiers, keycode] reports. */
function reportsOf(data: Uint8Array): KbdReport[] {
  const packets = parseAll(data);
  const reports: KbdReport[] = [];
  for (const p of packets) {
    expect(p.cmd).toBe(CMD.HidKeyboardShort);
    expect(p.param).not.toBeNull();
    for (let i = 0; i + 1 < (p.param ?? 0) * 2; i += 2) {
      reports.push([p.data[i], p.data[i + 1]]);
    }
  }
  return reports;
}

describe('crc32', () => {
  it('matches the known IEEE vector crc32("123456789") = 0xCBF43926', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });
});

describe('buildPacket framing', () => {
  it('starts with the 0x55 tag and block-count header', () => {
    const pkt = buildPacket(CMD.RunFirmware, 0);
    expect(pkt[0]).toBe(IS_TAG);
    expect(pkt[1]).toBe(1); // 6-byte payload → 1 block
    expect(pkt).toHaveLength(2 + 16);
  });

  it('pads the payload to a 16-byte multiple', () => {
    // 6 + 12 = 18 payload bytes → 2 blocks
    const pkt = buildPacket(CMD.HidMouse, 1, new Uint8Array(12));
    expect(pkt[1]).toBe(2);
    expect(pkt).toHaveLength(2 + 32);
  });

  it('sets the response-requested flag in the header', () => {
    const pkt = buildPacket(CMD.RunFirmware, 0, undefined, true);
    expect(pkt[1] & IS_FLAG_RESPONSE).toBe(IS_FLAG_RESPONSE);
    expect(pkt[1] & 0x3f).toBe(1);
  });

  it('stores the CRC32 big-endian over payload[4..]', () => {
    const pkt = buildPacket(CMD.HidMouse, 1, bytes(1, 2, 3, 4));
    const payload = pkt.slice(2);
    const crcRx = ((payload[0] << 24) | (payload[1] << 16) | (payload[2] << 8) | payload[3]) >>> 0;
    expect(crcRx).toBe(crc32(payload.slice(4)));
  });
});

describe('PacketParser', () => {
  it('round-trips a normal packet (cmd, param, data)', () => {
    const data = bytes(9, 8, 7);
    const [pkt] = parseAll(buildPacket(CMD.HidMouse, 3, data));
    expect(pkt.cmd).toBe(CMD.HidMouse);
    expect(pkt.param).toBe(3);
    expect([...pkt.data.slice(0, 3)]).toEqual([9, 8, 7]);
  });

  it('parses notification packets with no param byte (data at payload[5])', () => {
    // Hand-build a 0x2F notification: payload = crc(4) + cmd + 11 data bytes
    // = 16 bytes, one block. Mirror of the firmware's build_notification().
    const pl = new Uint8Array(16);
    pl[4] = CMD.HidStatusNotification;
    pl[5] = 0x05; // data[0] = USBConfigured
    pl[5 + 7] = 12; // data[7] = keyboard drain count
    const crc = crc32(pl.slice(4));
    pl[0] = (crc >>> 24) & 0xff;
    pl[1] = (crc >>> 16) & 0xff;
    pl[2] = (crc >>> 8) & 0xff;
    pl[3] = crc & 0xff;
    const [pkt] = parseAll(new Uint8Array([IS_TAG, 1, ...pl]));
    expect(pkt.cmd).toBe(CMD.HidStatusNotification);
    expect(pkt.param).toBeNull();
    expect(pkt.data[0]).toBe(0x05);
    expect(pkt.data[7]).toBe(12);
  });

  it('handles byte-at-a-time delivery (chunked notifications)', () => {
    const parser = new PacketParser();
    const framed = buildPacket(CMD.RunFirmware, 1);
    const found = [];
    for (const b of framed) {
      found.push(...parser.feed(bytes(b)));
    }
    expect(found).toHaveLength(1);
    expect(found[0].cmd).toBe(CMD.RunFirmware);
  });

  it('skips garbage before the tag and bad-CRC packets', () => {
    const parser = new PacketParser();
    expect(parser.feed(bytes(0x00, 0x13, 0x37))).toHaveLength(0);
    const bad = buildPacket(CMD.HidMouse, 1, bytes(1, 2, 3, 4));
    bad[10] ^= 0xff; // corrupt the payload
    expect(parser.feed(bad)).toHaveLength(0);
    // …and the parser recovers for the next valid packet.
    expect(parser.feed(buildPacket(CMD.HidMouse, 1, bytes(1, 2, 3, 4)))).toHaveLength(1);
  });

  it('rejects an invalid block count in the header', () => {
    expect(new PacketParser().feed(bytes(IS_TAG, 0))).toHaveLength(0);
  });
});

describe('charToKey (US layout)', () => {
  it('maps lowercase letters without shift', () => {
    expect(charToKey('a')).toEqual({ shift: 0, key: 0x04 });
    expect(charToKey('z')).toEqual({ shift: 0, key: 0x1d });
  });

  it('maps uppercase letters with shift', () => {
    expect(charToKey('A')).toEqual({ shift: MODIFIER_BITS.shift, key: 0x04 });
    expect(charToKey('Z')).toEqual({ shift: MODIFIER_BITS.shift, key: 0x1d });
  });

  it('maps digits and their shifted symbols', () => {
    expect(charToKey('1')).toEqual({ shift: 0, key: 0x1e });
    expect(charToKey('0')).toEqual({ shift: 0, key: 0x27 });
    expect(charToKey('!')).toEqual({ shift: MODIFIER_BITS.shift, key: 0x1e });
    expect(charToKey(')')).toEqual({ shift: MODIFIER_BITS.shift, key: 0x27 });
    expect(charToKey('?')).toEqual({ shift: MODIFIER_BITS.shift, key: 0x38 });
  });

  it('maps editing characters to their keys', () => {
    expect(charToKey('\n')).toEqual({ shift: 0, key: KEY.enter });
    expect(charToKey('\t')).toEqual({ shift: 0, key: KEY.tab });
    expect(charToKey('\b')).toEqual({ shift: 0, key: KEY.backspace });
    expect(charToKey(' ')).toEqual({ shift: 0, key: KEY.space });
  });

  it('maps unshifted punctuation', () => {
    expect(charToKey('-')).toEqual({ shift: 0, key: 0x2d });
    expect(charToKey('=')).toEqual({ shift: 0, key: 0x2e });
    expect(charToKey("'")).toEqual({ shift: 0, key: 0x34 });
    expect(charToKey('.')).toEqual({ shift: 0, key: 0x37 });
  });

  it('returns null for characters a US keyboard cannot type', () => {
    expect(charToKey('é')).toBeNull();
    expect(charToKey('中')).toBeNull();
    expect(charToKey('😀')).toBeNull();
  });
});

describe('textToReports / encodeText (dictation path)', () => {
  it('emits press + release per character (state-report model)', () => {
    expect(textToReports('a')).toEqual([
      [0, 0x04],
      [0, 0],
    ]);
  });

  it('adds shift to the press but not the release', () => {
    expect(textToReports('A')).toEqual([
      [MODIFIER_BITS.shift, 0x04],
      [0, 0],
    ]);
  });

  it('ORs held modifiers into presses and releases back to them', () => {
    expect(textToReports('ab', MODIFIER_BITS.ctrl, MODIFIER_BITS.ctrl)).toEqual([
      [MODIFIER_BITS.ctrl, 0x04],
      [MODIFIER_BITS.ctrl, 0],
      [MODIFIER_BITS.ctrl, 0x05],
      [MODIFIER_BITS.ctrl, 0],
    ]);
  });

  it('drops untypable characters without dropping the rest', () => {
    expect(textToReports('aéb')).toEqual([
      [0, 0x04],
      [0, 0],
      [0, 0x05],
      [0, 0],
    ]);
  });

  it('packs reports into 0x2C packets with param = report count', () => {
    const packets = parseAll(encodeText('hi'));
    expect(packets).toHaveLength(1);
    expect(packets[0].cmd).toBe(CMD.HidKeyboardShort);
    expect(packets[0].param).toBe(4); // 2 chars × (press + release)
  });

  it('splits long text into multiple packets', () => {
    const packets = parseAll(encodeText('x'.repeat(40))); // 80 reports
    expect(packets.length).toBeGreaterThan(1);
    for (const p of packets) expect(p.cmd).toBe(CMD.HidKeyboardShort);
  });
});

describe('encodeSpecialKey', () => {
  it('taps the HID keycode (press + release) in a 0x2C packet', () => {
    expect(reportsOf(encodeSpecialKey('esc'))).toEqual([
      [0, 0x29],
      [0, 0],
    ]);
    expect(reportsOf(encodeSpecialKey('f12'))).toEqual([
      [0, 0x45],
      [0, 0],
    ]);
  });

  it('carries pressed modifiers on the press only', () => {
    expect(reportsOf(encodeSpecialKey('left', MODIFIER_BITS.ctrl))).toEqual([
      [MODIFIER_BITS.ctrl, 0x50],
      [0, 0],
    ]);
  });

  it('covers every key the UI exposes', () => {
    expect(Object.keys(SPECIAL_KEYS)).toHaveLength(10 + 12);
  });
});

describe('encodeModifierState', () => {
  it('is a single [mask, 0] report — hold and release in one opcode', () => {
    expect(reportsOf(encodeModifierState(MODIFIER_BITS.ctrl | MODIFIER_BITS.alt))).toEqual([
      [MODIFIER_BITS.ctrl | MODIFIER_BITS.alt, 0],
    ]);
    expect(reportsOf(encodeModifierState(0))).toEqual([[0, 0]]);
  });
});

describe('encodeEditByte', () => {
  it('maps the macro editing bytes to key taps', () => {
    expect(reportsOf(encodeEditByte(0x09))).toEqual([
      [0, KEY.tab],
      [0, 0],
    ]);
    expect(reportsOf(encodeEditByte(0x0a))).toEqual([
      [0, KEY.enter],
      [0, 0],
    ]);
  });

  it('encodes unknown bytes as nothing', () => {
    expect(encodeEditByte(0x41)).toHaveLength(0);
  });
});

describe('diffEdits', () => {
  it('appends at the end', () => {
    expect(diffEdits('hel', 'hello')).toEqual({ backspaces: 0, insert: 'lo' });
  });

  it('backspaces at the end', () => {
    expect(diffEdits('hello', 'hel')).toEqual({ backspaces: 2, insert: '' });
  });

  it('rewrites a middle span (autocorrect / dictation)', () => {
    expect(diffEdits('teh cat', 'the cat')).toEqual({ backspaces: 2, insert: 'he' });
  });

  it('handles full replacement and empty states', () => {
    expect(diffEdits('abc', 'xyz')).toEqual({ backspaces: 3, insert: 'xyz' });
    expect(diffEdits('', 'hi')).toEqual({ backspaces: 0, insert: 'hi' });
    expect(diffEdits('same', 'same')).toEqual({ backspaces: 0, insert: '' });
  });
});

describe('encodeEdit', () => {
  it('emits backspace taps before the inserted text', () => {
    expect(reportsOf(encodeEdit('abc', 'axc'))).toEqual([
      [0, KEY.backspace],
      [0, 0],
      [0, 0x1b], // x
      [0, 0],
    ]);
  });

  it('emits nothing for no change', () => {
    expect(encodeEdit('same', 'same')).toHaveLength(0);
  });

  it('handles dictation-style multi-word insert', () => {
    const reports = reportsOf(encodeEdit('', 'hello world'));
    expect(reports).toHaveLength(22); // 11 chars × 2 reports
  });
});

describe('encodeMouse', () => {
  it('builds a 0x23 packet with [buttons, dx, dy, wheel]', () => {
    const [pkt] = parseAll(encodeMouse(MOUSE_BUTTON_LEFT, 10, -20, 0));
    expect(pkt.cmd).toBe(CMD.HidMouse);
    expect(pkt.param).toBe(1);
    expect([...pkt.data.slice(0, 4)]).toEqual([0x01, 10, 0xec, 0]);
  });

  it('clamps deltas to -127..127', () => {
    const [pkt] = parseAll(encodeMouse(0, 500, -500, 128));
    expect([...pkt.data.slice(0, 4)]).toEqual([0, 127, 0x81, 127]);
  });

  it('button bits are left/right/middle = bit0/bit1/bit2', () => {
    expect(MOUSE_BUTTON_LEFT).toBe(0x01);
    expect(MOUSE_BUTTON_RIGHT).toBe(0x02);
    expect(MOUSE_BUTTON_MIDDLE).toBe(0x04);
  });
});

describe('encodeAbsolute', () => {
  it('builds a 0x26 touchscreen packet (report ID 4, tip+in-range, 16-bit LE coords)', () => {
    const [pkt] = parseAll(encodeAbsolute(0x01, 0x1234, 0x5678));
    expect(pkt.cmd).toBe(CMD.HidTouch);
    expect(pkt.param).toBe(1);
    const d = pkt.data;
    expect(d[0]).toBe(4); // report ID
    expect(d[1]).toBe(0x03); // tip + in-range
    // Coordinates are scaled ×2 into the 16-bit wire range.
    expect(d[2] | (d[3] << 8)).toBe(0x1234 * 2);
    expect(d[4] | (d[5] << 8)).toBe(0x5678 * 2);
  });

  it('clears the tip bit when no button is pressed', () => {
    const [pkt] = parseAll(encodeAbsolute(0, 100, 200));
    expect(pkt.data[1]).toBe(0x02);
  });

  it('clamps coordinates to 0..32767 before scaling', () => {
    const [pkt] = parseAll(encodeAbsolute(0, -5, 40000));
    expect(pkt.data[2] | (pkt.data[3] << 8)).toBe(0);
    expect(pkt.data[4] | (pkt.data[5] << 8)).toBe(65534);
  });
});

describe('encodeConsumer', () => {
  it('builds a 0x22 packet with [reportID 1, usage LSB, usage MSB]', () => {
    const [pkt] = parseAll(encodeConsumer(0x00e9));
    expect(pkt.cmd).toBe(CMD.HidConsumer);
    expect(pkt.param).toBe(1);
    expect([...pkt.data.slice(0, 3)]).toEqual([1, 0xe9, 0x00]);
  });
});

describe('parseHidStatus', () => {
  it('reads the firmware v6.7 layout (11 data bytes, drain counts at 7..9)', () => {
    const data = bytes(0x05, 0x00, 0x01, 0x01, 0x01, 0x01, 0x01, 12, 3, 7, 0xff);
    expect(parseHidStatus(data)).toEqual({
      usbState: 0x05,
      keyboardLeds: 0,
      keyboardEmpty: true,
      mouseEmpty: true,
      consumerEmpty: true,
      keyboardSent: 12,
      mouseSent: 3,
      consumerSent: 7,
    });
  });

  it('tolerates short data', () => {
    const status = parseHidStatus(bytes(0x05));
    expect(status.usbState).toBe(0x05);
    expect(status.keyboardSent).toBe(0);
  });
});

describe('flow-control model', () => {
  it('maps HID commands to their buffer interface', () => {
    expect(packetInterface(CMD.HidKeyboardShort)).toBe('keyboard');
    expect(packetInterface(CMD.HidKeyboard)).toBe('keyboard');
    expect(packetInterface(CMD.HidMouse)).toBe('mouse');
    // Abs-pointer reports drain into the consumer counter firmware-side.
    expect(packetInterface(CMD.HidTouch)).toBe('consumer');
    expect(packetInterface(CMD.HidConsumer)).toBe('consumer');
    expect(packetInterface(CMD.RunFirmware)).toBeNull();
  });

  it('uses the firmware-documented capacities (128 + 64 + 64 = queue 256)', () => {
    expect(HID_BUFFER_CAPACITY).toEqual({ keyboard: 128, mouse: 64, consumer: 64 });
  });
});

describe('chunkPayload', () => {
  it('returns a single chunk for small payloads', () => {
    expect(chunkPayload(bytes(1, 2, 3), 20)).toHaveLength(1);
  });

  it('splits at the chunk size — the dongle reassembles the byte stream', () => {
    const chunks = chunkPayload(new Uint8Array(50).fill(0x61), 20);
    expect(chunks.map((c) => c.length)).toEqual([20, 20, 10]);
  });
});

describe('iteratePackets', () => {
  it('splits concatenated packets and exposes cmd + param', () => {
    const stream = new Uint8Array([
      ...buildPacket(CMD.RunFirmware, 0),
      ...encodeMouse(1, 2, 3, 4),
      ...encodeText('hi'),
    ]);
    const parts = [...iteratePackets(stream)];
    expect(parts.map((p) => p.cmd)).toEqual([CMD.RunFirmware, CMD.HidMouse, CMD.HidKeyboardShort]);
    expect(parts[1].param).toBe(1);
    expect(parts[2].param).toBe(4);
    expect(Uint8Array.from(parts.flatMap((p) => [...p.packet]))).toEqual(stream);
  });

  it('throws on non-packet bytes', () => {
    expect(() => [...iteratePackets(bytes(0x61, 0x62))]).toThrow(/bad tag/);
    expect(() => [...iteratePackets(bytes(IS_TAG, 1, 0, 0))]).toThrow(/truncated/);
  });
});
