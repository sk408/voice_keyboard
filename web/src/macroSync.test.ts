import { describe, expect, it } from 'vitest';
import {
  GetAssembler,
  MACRO_MAX_PAYLOAD,
  MACRO_SLOTS,
  MACRO_STORE_BYTES,
  bytesToTemplate,
  compiledLength,
  decodeBytes,
  encodeBytes,
  encodeDelete,
  encodeGetRequest,
  encodePutChunks,
  fetchMacroBytes,
  macroFootprint,
  parseGetResponse,
  parseMacroList,
  planCopy,
  pushMacro,
  storageUsed,
  type MacroListEntry,
  type MacroStoreIO,
} from './macroSync';
import { encodeMacro, encodeSegment, tokenizeMacro } from './macros';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function parseChunk(payload: Uint8Array): Record<string, unknown> {
  return JSON.parse(decoder.decode(payload)) as Record<string, unknown>;
}

/* --- byte ↔ data-string codec --- */

describe('byte ↔ JSON-string codec', () => {
  it('round-trips all 256 byte values', () => {
    const all = new Uint8Array(256);
    for (let i = 0; i < 256; i++) all[i] = i;
    expect(decodeBytes(encodeBytes(all))).toEqual(all);
  });

  it('passes printable safe ASCII through unchanged', () => {
    expect(encodeBytes(encoder.encode('Hello, World! 123'))).toBe('Hello, World! 123');
  });

  it('escapes quote, backslash, control and high bytes', () => {
    expect(encodeBytes(new Uint8Array([0x22, 0x5c, 0x00, 0x0a, 0x80, 0xff]))).toBe(
      '\\"\\\\\\u0000\\u000A\\u0080\\u00FF',
    );
  });

  it('decodes \\u00XX (any hex case), legacy \\XX, and literal U+00xx chars', () => {
    expect(decodeBytes('\\u000a')).toEqual(new Uint8Array([0x0a]));
    expect(decodeBytes('\\u00E9')).toEqual(new Uint8Array([0xe9]));
    expect(decodeBytes('\\0a')).toEqual(new Uint8Array([0x0a]));
    // JSON.parse turns "\u00e9" into the literal char — decodeBytes must too.
    expect(decodeBytes('é')).toEqual(new Uint8Array([0xe9]));
  });

  it('throws on malformed escapes and chars above U+00FF', () => {
    expect(() => decodeBytes('\\0')).toThrow();
    expect(() => decodeBytes('\\ZZ')).toThrow();
    expect(() => decodeBytes('\\u0100')).toThrow();
    expect(() => decodeBytes('Ā')).toThrow();
  });
});

/* --- put chunking --- */

describe('encodePutChunks', () => {
  it('emits a single named fin chunk for a small macro', () => {
    const chunks = encodePutChunks(3, 'Note', encoder.encode('hello'));
    expect(chunks).toHaveLength(1);
    const obj = parseChunk(chunks[0]);
    expect(obj).toMatchObject({ op: 'put', i: 3, name: 'Note', off: 0, data: 'hello', fin: true });
  });

  it('emits one chunk for an empty template', () => {
    const chunks = encodePutChunks(0, 'Empty', new Uint8Array(0));
    expect(chunks).toHaveLength(1);
    expect(parseChunk(chunks[0])).toMatchObject({ name: 'Empty', off: 0, data: '', fin: true });
  });

  it('splits long macros into ≤180-byte payloads with cumulative offsets', () => {
    const bytes = new Uint8Array(1000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = 0x41 + (i % 26);
    const chunks = encodePutChunks(1, 'Big', bytes);
    expect(chunks.length).toBeGreaterThan(3);
    let expectedOff = 0;
    chunks.forEach((payload, idx) => {
      expect(payload.length).toBeLessThanOrEqual(MACRO_MAX_PAYLOAD);
      const obj = parseChunk(payload);
      expect(obj.off).toBe(expectedOff);
      expectedOff += decodeBytes(obj.data as string).length;
      if (idx === 0) expect(obj.name).toBe('Big');
      else expect(obj.name).toBeUndefined();
      if (idx === chunks.length - 1) expect(obj.fin).toBe(true);
      else expect(obj.fin).toBeUndefined();
    });
    expect(expectedOff).toBe(bytes.length);
  });

  it('keeps payloads ≤180 bytes even with a 60-char name', () => {
    const name = 'N'.repeat(60);
    const bytes = new Uint8Array(500).fill(0x00); // worst case: 6 chars/byte
    for (const payload of encodePutChunks(15, name, bytes)) {
      expect(payload.length).toBeLessThanOrEqual(MACRO_MAX_PAYLOAD);
    }
  });

  it('reassembles the exact bytes when chunk boundaries split UTF-8 characters', () => {
    // "é" is 2 bytes (0xC3 0xA5), emoji "😀" is 4 — a small payload cap
    // forces boundaries to land mid-character. Each chunk must still be
    // valid JSON and reassemble to the exact original bytes.
    const text = 'abé😀cdé😀efé😀ghé😀ijé😀kl';
    const bytes = encoder.encode(text);
    const chunks = encodePutChunks(0, 'UTF8', bytes, 80);
    expect(chunks.length).toBeGreaterThan(3);
    let reassembled: number[] = [];
    for (const payload of chunks) {
      expect(payload.length).toBeLessThanOrEqual(80);
      const obj = parseChunk(payload); // throws if any chunk is invalid JSON
      reassembled = reassembled.concat([...decodeBytes(obj.data as string)]);
    }
    expect(new Uint8Array(reassembled)).toEqual(bytes);
    expect(decoder.decode(new Uint8Array(reassembled))).toBe(text);
  });

  it('decodes chunk splits that fall mid-UTF-8 and mid-escape-sequence exactly', () => {
    // Deterministic version: split the byte stream by hand at offsets that
    // land inside a multi-byte char (é = C3 A5) and inside a 0x00 escape
    // sequence (00 06 = {del}). Each piece is encoded on its own — the
    // property the chunked protocol relies on.
    const bytes = new Uint8Array([0x61, 0xc3, 0xa5, 0x62, 0x00, 0x06, 0x63]);
    const splitPoints = [1, 2, 4, 5]; // before é, mid-é, before esc, mid-esc
    for (const cut of splitPoints) {
      const first = bytes.slice(0, cut);
      const second = bytes.slice(cut);
      const joined = new Uint8Array([
        ...decodeBytes(encodeBytes(first)),
        ...decodeBytes(encodeBytes(second)),
      ]);
      expect(joined).toEqual(bytes);
    }
  });

  it('round-trips a macro with escapes through small put chunks without loss', () => {
    const macro = 'x{del}y{ctrl+z}{enter}{esc}';
    const bytes = encodeMacro(macro);
    const chunks = encodePutChunks(2, 'Esc', bytes, 80);
    expect(chunks.length).toBeGreaterThan(1);
    const perChunk = chunks.map((p) => decodeBytes(parseChunk(p).data as string));
    const reassembled = new Uint8Array(perChunk.reduce((n, c) => n + c.length, 0));
    let pos = 0;
    for (const c of perChunk) {
      reassembled.set(c, pos);
      pos += c.length;
    }
    expect(reassembled).toEqual(bytes);
  });
});

/* --- del --- */

describe('encodeDelete', () => {
  it('encodes the del op', () => {
    expect(decoder.decode(encodeDelete(2))).toBe('{"op":"del","i":2}');
  });
});

/* --- get --- */

describe('get request/response', () => {
  it('encodes get requests', () => {
    expect(decoder.decode(encodeGetRequest(0, 412))).toBe('{"op":"get","i":0,"off":412}');
  });

  it('parses a get response and decodes its data', () => {
    const chunk = parseGetResponse('{"op":"get","i":1,"off":5,"len":20,"data":"a\\00b","fin":true}');
    expect(chunk.index).toBe(1);
    expect(chunk.offset).toBe(5);
    expect(chunk.total).toBe(20);
    expect(chunk.data).toEqual(new Uint8Array([0x61, 0x00, 0x62]));
    expect(chunk.fin).toBe(true);
  });

  it('treats a missing fin flag as false', () => {
    expect(parseGetResponse('{"op":"get","i":0,"off":0,"len":9,"data":"x"}').fin).toBe(false);
  });

  it('rejects malformed responses', () => {
    expect(() => parseGetResponse('not json')).toThrow();
    expect(() => parseGetResponse('{"op":"put"}')).toThrow();
    expect(() => parseGetResponse('{"op":"get","i":0,"off":0,"len":1}')).toThrow();
  });
});

describe('GetAssembler', () => {
  const mk = (off: number, total: number, data: number[], fin = false) => ({
    index: 0,
    offset: off,
    total,
    data: new Uint8Array(data),
    fin,
  });

  it('reassembles chunks and requires fin to complete the total', () => {
    const a = new GetAssembler(0);
    expect(a.push(mk(0, 5, [1, 2]))).toBeNull();
    expect(a.nextOffset).toBe(2);
    expect(a.push(mk(2, 5, [3, 4, 5], true))).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
  });

  it('throws on offset gaps, slot mismatch, and changing totals', () => {
    expect(() => new GetAssembler(0).push(mk(3, 5, [1]))).toThrow(/offset/);
    expect(() => new GetAssembler(1).push(mk(0, 5, [1]))).toThrow(/slot/);
    const a = new GetAssembler(0);
    a.push(mk(0, 5, [1]));
    expect(() => a.push(mk(1, 6, [2]))).toThrow(/total/);
  });

  it('throws when fin arrives before the announced total', () => {
    const a = new GetAssembler(0);
    expect(() => a.push(mk(0, 5, [1, 2], true))).toThrow(/total/);
  });
});

/* --- simulated dongle: put → get round trip --- */

/**
 * In-memory stand-in for the dongle store: accepts put/del writes and serves
 * chunked get reads with its own arbitrary split points.
 */
function makeFakeDongleStore(getChunkBytes = 100) {
  const slots = new Map<number, { name: string; bytes: Uint8Array }>();
  let pendingGet: { index: number; offset: number } | null = null;

  const io: MacroStoreIO = {
    async write(payload: Uint8Array) {
      const obj = JSON.parse(decoder.decode(payload)) as Record<string, unknown>;
      if (obj.op === 'put') {
        const i = obj.i as number;
        const slot = slots.get(i) ?? { name: '', bytes: new Uint8Array(0) };
        if (obj.off === 0) {
          slot.bytes = new Uint8Array(0);
          slot.name = (obj.name as string) ?? slot.name;
        }
        if (obj.off !== slot.bytes.length) throw new Error('put offset mismatch');
        const data = decodeBytes(obj.data as string);
        const next = new Uint8Array(slot.bytes.length + data.length);
        next.set(slot.bytes);
        next.set(data, slot.bytes.length);
        slot.bytes = next;
        slots.set(i, slot);
      } else if (obj.op === 'del') {
        slots.delete(obj.i as number);
      } else if (obj.op === 'get') {
        pendingGet = { index: obj.i as number, offset: obj.off as number };
      }
    },
    async read() {
      if (!pendingGet) throw new Error('read without get');
      const { index, offset } = pendingGet;
      const slot = slots.get(index);
      if (!slot) throw new Error('no such slot');
      const slice = slot.bytes.slice(offset, offset + getChunkBytes);
      const fin = offset + slice.length >= slot.bytes.length;
      return JSON.stringify({
        op: 'get',
        i: index,
        off: offset,
        len: slot.bytes.length,
        data: encodeBytes(slice),
        ...(fin ? { fin: true } : {}),
      });
    },
  };
  return { io, slots };
}

describe('put → get round trip against a simulated dongle', () => {
  it('round-trips a multi-chunk macro with escapes and multi-byte chars', async () => {
    const template =
      'SOAP:{enter}{{field}} plain text é😀 {ctrl+shift+t}{del}{f5}' + 'x'.repeat(600);
    const bytes = encodeMacro(template); // fields compile to empty
    expect(bytes.length).toBeGreaterThan(500);

    const { io, slots } = makeFakeDongleStore(97); // odd split points on purpose
    await pushMacro(io, 4, 'SOAP note', bytes);

    const stored = slots.get(4);
    expect(stored?.name).toBe('SOAP note');
    expect(stored?.bytes).toEqual(bytes);

    const fetched = await fetchMacroBytes(io, 4);
    expect(fetched).toEqual(bytes);
  });

  it('round-trips with 1-byte get chunks (every boundary case at once)', async () => {
    const bytes = encodeMacro('aé{enter}{ctrl+x}😀{esc}b');
    const { io } = makeFakeDongleStore(1);
    await pushMacro(io, 0, 'Tiny', bytes);
    expect(await fetchMacroBytes(io, 0)).toEqual(bytes);
  });

  it('delete removes the slot', async () => {
    const { io, slots } = makeFakeDongleStore();
    await pushMacro(io, 2, 'A', encoder.encode('a'));
    expect(slots.has(2)).toBe(true);
    await io.write(encodeDelete(2));
    expect(slots.has(2)).toBe(false);
  });

  it('prefers an atomic getRoundtrip transport when offered', async () => {
    const { io, slots } = makeFakeDongleStore(2);
    const bytes = encodeMacro('aé{enter}b');
    await pushMacro(io, 1, 'RT', bytes);
    expect(slots.get(1)?.bytes).toEqual(bytes);

    const calls: string[] = [];
    const roundtripIo: MacroStoreIO = {
      write: async (payload) => {
        calls.push('write');
        return io.write(payload);
      },
      read: async () => {
        calls.push('read');
        return io.read();
      },
      getRoundtrip: async (payload) => {
        calls.push('roundtrip');
        await io.write(payload);
        return io.read();
      },
    };
    expect(await fetchMacroBytes(roundtripIo, 1)).toEqual(bytes);
    // Every chunk went through the atomic path; no bare read was used.
    expect(calls.filter((c) => c !== 'roundtrip')).toEqual([]);
    expect(calls.length).toBeGreaterThan(2); // multi-chunk get
  });
});

/* --- MACRO_LIST --- */

describe('parseMacroList', () => {
  it('parses an empty list', () => {
    expect(parseMacroList('[]')).toEqual([]);
  });

  it('parses entries and sorts by slot', () => {
    expect(parseMacroList('[{"i":3,"name":"B","len":5},{"i":0,"name":"A","len":412}]')).toEqual([
      { i: 0, name: 'A', len: 412 },
      { i: 3, name: 'B', len: 5 },
    ]);
  });

  it('skips malformed entries but keeps valid ones', () => {
    expect(parseMacroList('[{"i":0,"name":"A","len":1},{"i":99},{"name":"x","len":1}]')).toEqual([
      { i: 0, name: 'A', len: 1 },
    ]);
  });

  it('throws on non-array JSON', () => {
    expect(() => parseMacroList('{}')).toThrow();
    expect(() => parseMacroList('nope')).toThrow();
  });
});

/* --- storage accounting & copy planning --- */

describe('storage accounting', () => {
  it('counts name bytes + template bytes per macro', () => {
    expect(macroFootprint('AB', 10)).toBe(12);
    expect(macroFootprint('é', 0)).toBe(2); // UTF-8 name bytes
    const entries: MacroListEntry[] = [
      { i: 0, name: 'AB', len: 10 },
      { i: 1, name: 'C', len: 5 },
    ];
    expect(storageUsed(entries)).toBe(18);
  });

  it('planCopy fills free slots first-fit and reports what does not fit', () => {
    const existing: MacroListEntry[] = [{ i: 0, name: 'A', len: 100 }];
    const candidates = [
      { name: 'one', templateByteLen: 50 },
      { name: 'two', templateByteLen: MACRO_STORE_BYTES }, // too big
      { name: 'three', templateByteLen: 60 },
    ];
    const plan = planCopy(candidates, existing);
    expect(plan.placements).toEqual([
      { candidate: 0, slot: 1 },
      { candidate: 2, slot: 2 },
    ]);
    expect(plan.skipped).toEqual([1]);
  });

  it('planCopy stops placing when all 16 slots are taken', () => {
    const existing: MacroListEntry[] = [];
    const candidates = Array.from({ length: MACRO_SLOTS + 2 }, (_, k) => ({
      name: `m${k}`,
      templateByteLen: 1,
    }));
    const plan = planCopy(candidates, existing);
    expect(plan.placements).toHaveLength(MACRO_SLOTS);
    expect(plan.skipped).toEqual([MACRO_SLOTS, MACRO_SLOTS + 1]);
  });
});

/* --- bytesToTemplate --- */

describe('bytesToTemplate', () => {
  it('decodes what encodeMacro produces for app-authored macros', () => {
    const template = 'Hi there{enter}{tab}line2{esc}{ctrl+a}{del}{f12}';
    expect(bytesToTemplate(encodeMacro(template))).toBe(template);
  });

  it('decodes a click press+release pair back to a percent click', () => {
    const bytes = encodeSegment(tokenizeMacro('{click 50% 25%}')[0]);
    expect(bytesToTemplate(bytes)).toBe('{click 50% 25%}');
  });

  it('keeps multi-byte UTF-8 text intact', () => {
    expect(bytesToTemplate(encoder.encode('héllo 😀'))).toBe('héllo 😀');
  });

  it('renders unknown escape bytes as visible placeholders, never drops them', () => {
    expect(bytesToTemplate(new Uint8Array([0x41, 0x00, 0x77, 0x42]))).toBe('A{0x00 0x77}B');
  });
});

describe('compiledLength', () => {
  it('matches encodeMacro output length', () => {
    expect(compiledLength('ab{enter}{ctrl+x}')).toBe(encodeMacro('ab{enter}{ctrl+x}').length);
  });
});
