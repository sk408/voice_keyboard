import { describe, expect, it } from 'vitest';
import {
  BACKSPACE,
  MODIFIER_BITS,
  MOUSE_BUTTON_LEFT,
  MOUSE_BUTTON_MIDDLE,
  MOUSE_BUTTON_RIGHT,
  SPECIAL_KEYS,
  chunkPayload,
  diffEdits,
  encodeAbsolute,
  encodeEdit,
  encodeModifierHold,
  encodeModifierRelease,
  encodeMouse,
  encodeSpecialKey,
  encodeStickyArm,
  encodeText,
  parseStatus,
} from './protocol';

function bytes(...nums: number[]): Uint8Array {
  return new Uint8Array(nums);
}

describe('encodeText', () => {
  it('passes ASCII through unchanged', () => {
    expect([...encodeText('hello')]).toEqual([...bytes(104, 101, 108, 108, 111)]);
  });

  it('maps newline, tab, backspace to their protocol bytes', () => {
    expect([...encodeText('\n')]).toEqual([0x0a]);
    expect([...encodeText('\t')]).toEqual([0x09]);
    expect([...encodeText('\b')]).toEqual([0x08]);
  });

  it('encodes non-ASCII as UTF-8', () => {
    expect([...encodeText('é')]).toEqual([0xc3, 0xa9]);
    expect([...encodeText('中')]).toEqual([0xe4, 0xb8, 0xad]);
  });

  it('drops NUL bytes so they cannot be misread as the escape prefix', () => {
    expect([...encodeText('a\u0000b')]).toEqual([...bytes(97, 98)]);
  });
});

describe('encodeSpecialKey', () => {
  it('emits 0x00 followed by the protocol code', () => {
    expect([...encodeSpecialKey('esc')]).toEqual([0x00, 0x01]);
    expect([...encodeSpecialKey('right')]).toEqual([0x00, 0x05]);
    expect([...encodeSpecialKey('delete')]).toEqual([0x00, 0x06]);
    expect([...encodeSpecialKey('f12')]).toEqual([0x00, 0x1b]);
  });

  it('covers every key the protocol defines', () => {
    expect(Object.keys(SPECIAL_KEYS)).toHaveLength(10 + 12);
  });
});

describe('modifier encodings (v2)', () => {
  it('sticky-arm is 0x00 0x81 <mask>', () => {
    expect([...encodeStickyArm(MODIFIER_BITS.ctrl)]).toEqual([0x00, 0x81, 0x01]);
  });

  it('composes chords into a single bitmask', () => {
    const mask = MODIFIER_BITS.ctrl | MODIFIER_BITS.shift;
    expect([...encodeStickyArm(mask)]).toEqual([0x00, 0x81, 0x03]);
  });

  it('covers the left-hand HID modifier bits', () => {
    expect(MODIFIER_BITS).toEqual({ ctrl: 0x01, shift: 0x02, alt: 0x04, gui: 0x08 });
  });

  it('hold is 0x00 0x82 <mask>, release-all is 0x00 0x83', () => {
    expect([...encodeModifierHold(MODIFIER_BITS.gui)]).toEqual([0x00, 0x82, 0x08]);
    expect([...encodeModifierRelease()]).toEqual([0x00, 0x83]);
  });
});

describe('encodeMouse (v2)', () => {
  it('emits 0x00 0x90 <buttons> <dx> <dy> <wheel>', () => {
    expect([...encodeMouse(MOUSE_BUTTON_LEFT, 10, -20, 0)]).toEqual([0x00, 0x90, 0x01, 10, 0xec, 0]);
  });

  it('encodes negative deltas as two’s complement int8', () => {
    expect([...encodeMouse(0, -1, -127, -5)]).toEqual([0x00, 0x90, 0, 0xff, 0x81, 0xfb]);
  });

  it('clamps deltas to the descriptor range -127..127', () => {
    expect([...encodeMouse(0, 500, -500, 128)]).toEqual([0x00, 0x90, 0, 127, 0x81, 127]);
  });

  it('button bits are left/right/middle = bit0/bit1/bit2', () => {
    expect(MOUSE_BUTTON_LEFT).toBe(0x01);
    expect(MOUSE_BUTTON_RIGHT).toBe(0x02);
    expect(MOUSE_BUTTON_MIDDLE).toBe(0x04);
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

  it('handles full replacement', () => {
    expect(diffEdits('abc', 'xyz')).toEqual({ backspaces: 3, insert: 'xyz' });
  });

  it('handles empty states', () => {
    expect(diffEdits('', 'hi')).toEqual({ backspaces: 0, insert: 'hi' });
    expect(diffEdits('hi', '')).toEqual({ backspaces: 2, insert: '' });
    expect(diffEdits('same', 'same')).toEqual({ backspaces: 0, insert: '' });
  });
});

describe('encodeEdit', () => {
  it('emits backspaces before inserted text', () => {
    expect([...encodeEdit('abc', 'axc')]).toEqual([BACKSPACE, ...encodeText('x')]);
  });

  it('emits nothing for no change', () => {
    expect(encodeEdit('same', 'same')).toHaveLength(0);
  });

  it('handles dictation-style multi-word insert', () => {
    expect([...encodeEdit('', 'hello world')]).toEqual([...encodeText('hello world')]);
  });
});

describe('encodeAbsolute (v4)', () => {
  it('emits 0x00 0x91 <buttons> <x_lo> <x_hi> <y_lo> <y_hi>', () => {
    expect([...encodeAbsolute(0x01, 0x1234, 0x5678)]).toEqual([
      0x00, 0x91, 0x01, 0x34, 0x12, 0x78, 0x56,
    ]);
  });

  it('rounds fractional coordinates', () => {
    expect([...encodeAbsolute(0, 100.4, 100.6)]).toEqual([0x00, 0x91, 0, 100, 0, 101, 0]);
  });

  it('clamps out-of-range coordinates to 0..32767', () => {
    expect([...encodeAbsolute(0, -5, 40000)]).toEqual([0x00, 0x91, 0, 0, 0, 0xff, 0x7f]);
  });

  it('button bits are left/right/middle = bit0/bit1/bit2', () => {
    expect(encodeAbsolute(0x07, 0, 0)[2]).toBe(0x07);
  });
});

describe('chunkPayload', () => {
  it('returns a single chunk for small payloads', () => {
    const chunks = chunkPayload(bytes(1, 2, 3), 20);
    expect(chunks).toHaveLength(1);
    expect([...chunks[0]]).toEqual([1, 2, 3]);
  });

  it('splits at the chunk size', () => {
    const data = new Uint8Array(50).fill(0x61);
    const chunks = chunkPayload(data, 20);
    expect(chunks.map((c) => c.length)).toEqual([20, 20, 10]);
  });

  it('never splits a UTF-8 sequence across chunks', () => {
    // 9 ASCII bytes + one 3-byte char (中 = e4 b8 ad) + fill
    const data = new Uint8Array([...encodeText('aaaaaaaaa中'), 0x61, 0x61, 0x61]);
    const chunks = chunkPayload(data, 10);
    for (const chunk of chunks) {
      expect(() => new TextDecoder('utf-8', { fatal: true }).decode(chunk)).not.toThrow();
    }
    expect(Uint8Array.from(chunks.flatMap((c) => [...c]))).toEqual(data);
  });

  it('never splits the 0x00 escape pair across chunks', () => {
    const esc = encodeSpecialKey('esc'); // 00 01
    const pad = new Uint8Array(9).fill(0x61);
    const data = new Uint8Array([...pad, ...esc, ...pad]);
    const chunks = chunkPayload(data, 10);
    for (const chunk of chunks) {
      for (let i = 0; i < chunk.length; i++) {
        if (chunk[i] === 0x00) expect(i + 1).toBeLessThan(chunk.length);
      }
    }
  });

  it('never splits a 0x90 mouse packet across chunks', () => {
    // Mouse packet straddling the nominal chunk boundary.
    const pad = new Uint8Array(8).fill(0x61);
    const data = new Uint8Array([...pad, ...encodeMouse(1, 2, 3, 4), ...pad, ...encodeMouse(0, -1, -2, 0)]);
    const chunks = chunkPayload(data, 10);
    for (const chunk of chunks) {
      for (let i = 0; i < chunk.length; i++) {
        if (chunk[i] === 0x00 && chunk[i + 1] === 0x90) {
          // Whole 6-byte packet must be inside this chunk.
          expect(i + 6).toBeLessThanOrEqual(chunk.length);
        }
      }
    }
    expect(Uint8Array.from(chunks.flatMap((c) => [...c]))).toEqual(data);
  });

  it('never splits a 0x91 absolute-pointer packet across chunks', () => {
    // Text mixed with absolute-pointer packets at awkward offsets.
    const pad = new Uint8Array(8).fill(0x61);
    const data = new Uint8Array([
      ...pad,
      ...encodeAbsolute(1, 12345, 6789),
      ...encodeText('abc'),
      ...encodeAbsolute(0, 0, 32767),
      ...pad,
    ]);
    for (let size = 7; size <= 20; size++) {
      const chunks = chunkPayload(data, size);
      for (const chunk of chunks) {
        for (let i = 0; i < chunk.length; i++) {
          if (chunk[i] === 0x00 && chunk[i + 1] === 0x91) {
            // Whole 7-byte packet must be inside this chunk.
            expect(i + 7).toBeLessThanOrEqual(chunk.length);
          }
        }
      }
      expect(Uint8Array.from(chunks.flatMap((c) => [...c]))).toEqual(data);
    }
  });

  it('rejects chunk sizes smaller than the longest escape sequence', () => {
    expect(() => chunkPayload(bytes(1, 2, 3), 6)).toThrow(/too small/);
    expect(() => chunkPayload(bytes(1, 2, 3), 7)).not.toThrow();
  });

  it('never splits a 0x81/0x82 modifier sequence across chunks', () => {
    const pad = new Uint8Array(9).fill(0x61);
    const data = new Uint8Array([
      ...pad,
      ...encodeStickyArm(0x03),
      ...encodeModifierHold(0x01),
      ...encodeModifierRelease(),
      ...pad,
    ]);
    const chunks = chunkPayload(data, 10);
    for (const chunk of chunks) {
      for (let i = 0; i < chunk.length; i++) {
        if (chunk[i] !== 0x00) continue;
        const len = chunk[i + 1] === 0x81 || chunk[i + 1] === 0x82 ? 3 : 2;
        expect(i + len).toBeLessThanOrEqual(chunk.length);
      }
    }
    expect(Uint8Array.from(chunks.flatMap((c) => [...c]))).toEqual(data);
  });

  it('round-trips the concatenation', () => {
    const data = encodeText('The quick brown fox jumps over the lazy dog. 1234567890');
    const chunks = chunkPayload(data, 20);
    expect(Uint8Array.from(chunks.flatMap((c) => [...c]))).toEqual(data);
  });
});

describe('parseStatus', () => {
  it('maps 0x00/0x01 and treats 0xE0+ as error', () => {
    expect(parseStatus(new DataView(bytes(0x00).buffer))).toBe('idle');
    expect(parseStatus(new DataView(bytes(0x01).buffer))).toBe('busy');
    expect(parseStatus(new DataView(bytes(0xe0).buffer))).toBe('error');
    expect(parseStatus(new DataView(bytes(0xff).buffer))).toBe('error');
  });
});
