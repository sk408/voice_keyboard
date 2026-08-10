import { describe, expect, it } from 'vitest';
import {
  BACKSPACE,
  SPECIAL_KEYS,
  chunkPayload,
  diffEdits,
  encodeEdit,
  encodeSpecialKey,
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
