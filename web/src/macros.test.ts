import { describe, expect, it } from 'vitest';
import { encodeMacro, encodeSegment, macroFields, tokenizeMacro, type ClickContext } from './macros';
import {
  CMD,
  KEY,
  MODIFIER_BITS,
  PacketParser,
  encodeText,
  type KbdReport,
} from './protocol';
import type { CalibrationMap } from './calibration';

/** Decode all packets in an encoded buffer. */
function parseAll(data: Uint8Array) {
  return new PacketParser().feed(data);
}

/** Extract [modifiers, keycode] reports from the 0x2C packets in `data`. */
function kbdReports(data: Uint8Array): KbdReport[] {
  const reports: KbdReport[] = [];
  for (const p of parseAll(data)) {
    expect(p.cmd).toBe(CMD.HidKeyboardShort);
    for (let i = 0; i + 1 < (p.param ?? 0) * 2; i += 2) {
      reports.push([p.data[i], p.data[i + 1]]);
    }
  }
  return reports;
}

/** Extract the 6-byte reports from the 0x26 touchscreen packets in `data`. */
function touchReports(data: Uint8Array): number[][] {
  return parseAll(data).map((p) => {
    expect(p.cmd).toBe(CMD.HidTouch);
    return [...p.data.slice(0, 6)];
  });
}

describe('tokenizeMacro', () => {
  it('keeps plain text as a single text segment', () => {
    expect(tokenizeMacro('hello world')).toEqual([{ type: 'text', text: 'hello world' }]);
  });

  it('parses {tab} and {enter} as raw bytes', () => {
    expect(tokenizeMacro('{tab}')).toEqual([{ type: 'byte', byte: 0x09 }]);
    expect(tokenizeMacro('{enter}')).toEqual([{ type: 'byte', byte: 0x0a }]);
  });

  it('parses special-key tokens, case-insensitive with trimmed whitespace', () => {
    expect(tokenizeMacro('{esc}')).toEqual([{ type: 'key', key: 'esc' }]);
    expect(tokenizeMacro('{ UP }')).toEqual([{ type: 'key', key: 'up' }]);
    expect(tokenizeMacro('{del}')).toEqual([{ type: 'key', key: 'delete' }]);
    expect(tokenizeMacro('{pgup}')).toEqual([{ type: 'key', key: 'pageUp' }]);
    expect(tokenizeMacro('{PgDn}')).toEqual([{ type: 'key', key: 'pageDown' }]);
    expect(tokenizeMacro('{F12}')).toEqual([{ type: 'key', key: 'f12' }]);
  });

  it('parses modifier chords with a character target', () => {
    expect(tokenizeMacro('{ctrl+x}')).toEqual([
      { type: 'chord', mask: MODIFIER_BITS.ctrl, target: { type: 'char', char: 'x' } },
    ]);
    expect(tokenizeMacro('{ctrl+shift+t}')).toEqual([
      {
        type: 'chord',
        mask: MODIFIER_BITS.ctrl | MODIFIER_BITS.shift,
        target: { type: 'char', char: 't' },
      },
    ]);
  });

  it('parses chords with special-key and byte targets', () => {
    expect(tokenizeMacro('{alt+f4}')).toEqual([
      { type: 'chord', mask: MODIFIER_BITS.alt, target: { type: 'key', key: 'f4' } },
    ]);
    expect(tokenizeMacro('{ctrl+enter}')).toEqual([
      { type: 'chord', mask: MODIFIER_BITS.ctrl, target: { type: 'byte', byte: 0x0a } },
    ]);
  });

  it('lowercases single-letter chord targets ({ctrl+X} = ctrl+x)', () => {
    expect(tokenizeMacro('{CTRL+X}')).toEqual([
      { type: 'chord', mask: MODIFIER_BITS.ctrl, target: { type: 'char', char: 'x' } },
    ]);
  });

  it('parses fill-in fields with trimmed names', () => {
    expect(tokenizeMacro('{{chief complaint}}')).toEqual([
      { type: 'field', name: 'chief complaint' },
    ]);
  });

  it('keeps unknown tokens as literal text', () => {
    expect(tokenizeMacro('a {bogus} b')).toEqual([{ type: 'text', text: 'a {bogus} b' }]);
  });

  it('keeps malformed tokens as literal text', () => {
    expect(tokenizeMacro('unclosed {tab')).toEqual([{ type: 'text', text: 'unclosed {tab' }]);
    expect(tokenizeMacro('{ctrl+}')).toEqual([{ type: 'text', text: '{ctrl+}' }]);
    expect(tokenizeMacro('{}')).toEqual([{ type: 'text', text: '{}' }]);
    expect(tokenizeMacro('{{}}')).toEqual([{ type: 'text', text: '{{}}' }]);
    expect(tokenizeMacro('{{unclosed')).toEqual([{ type: 'text', text: '{{unclosed' }]);
  });

  it('tokenizes a mixed template end to end', () => {
    expect(tokenizeMacro('Hi {{name}},{enter}Regards{ctrl+s}')).toEqual([
      { type: 'text', text: 'Hi ' },
      { type: 'field', name: 'name' },
      { type: 'text', text: ',' },
      { type: 'byte', byte: 0x0a },
      { type: 'text', text: 'Regards' },
      { type: 'chord', mask: MODIFIER_BITS.ctrl, target: { type: 'char', char: 's' } },
    ]);
  });

  it('parses {click X% Y%} percent tokens, case-insensitive with flexible whitespace', () => {
    expect(tokenizeMacro('{click 80% 90%}')).toEqual([
      { type: 'click', target: { kind: 'percent', fx: 80, fy: 90 } },
    ]);
    expect(tokenizeMacro('{ CLICK  12.5%   0% }')).toEqual([
      { type: 'click', target: { kind: 'percent', fx: 12.5, fy: 0 } },
    ]);
  });

  it('parses {click "name"} landmark tokens, keeping the quoted case', () => {
    expect(tokenizeMacro('{click "Save button"}')).toEqual([
      { type: 'click', target: { kind: 'landmark', name: 'Save button' } },
    ]);
    expect(tokenizeMacro('{CLICK "Tray"}')).toEqual([
      { type: 'click', target: { kind: 'landmark', name: 'Tray' } },
    ]);
  });

  it('keeps malformed click tokens as literal text', () => {
    expect(tokenizeMacro('{click 80}')).toEqual([{ type: 'text', text: '{click 80}' }]);
    expect(tokenizeMacro('{click 80%}')).toEqual([{ type: 'text', text: '{click 80%}' }]);
    expect(tokenizeMacro('{click 101% 50%}')).toEqual([{ type: 'text', text: '{click 101% 50%}' }]);
    expect(tokenizeMacro('{click "unclosed}')).toEqual([{ type: 'text', text: '{click "unclosed}' }]);
    expect(tokenizeMacro('{click}')).toEqual([{ type: 'text', text: '{click}' }]);
  });
});

describe('macroFields', () => {
  it('returns unique field names in first-use order', () => {
    expect(macroFields('{{a}} x {{b}} y {{a}}')).toEqual(['a', 'b']);
  });

  it('returns an empty list when there are no fields', () => {
    expect(macroFields('no fields {enter} here')).toEqual([]);
  });
});

describe('encodeMacro / encodeSegment', () => {
  it('encodes literal text via encodeText', () => {
    expect([...encodeMacro('hello')]).toEqual([...encodeText('hello')]);
  });

  it('encodes {esc} as a press+release of the Esc HID keycode', () => {
    expect(kbdReports(encodeMacro('{esc}'))).toEqual([
      [0, 0x29],
      [0, 0],
    ]);
  });

  it('encodes {tab} and {enter} as Tab/Enter key taps', () => {
    expect(kbdReports(encodeMacro('{tab}'))).toEqual([
      [0, KEY.tab],
      [0, 0],
    ]);
    expect(kbdReports(encodeMacro('{enter}'))).toEqual([
      [0, KEY.enter],
      [0, 0],
    ]);
  });

  it('encodes {ctrl+x} as one ctrl+x press and release', () => {
    expect(kbdReports(encodeMacro('{ctrl+x}'))).toEqual([
      [MODIFIER_BITS.ctrl, 0x1b], // x
      [0, 0],
    ]);
  });

  it('encodes {alt+f4} as one alt+F4 press and release', () => {
    expect(kbdReports(encodeMacro('{alt+f4}'))).toEqual([
      [MODIFIER_BITS.alt, 0x3d], // F4
      [0, 0],
    ]);
  });

  it('substitutes field values (per-segment packets, same keystrokes as inline text)', () => {
    // Segments encode as separate packets, so compare the keystroke stream,
    // not the raw framing.
    expect(kbdReports(encodeMacro('Hello {{name}}!', { name: 'Ada' }))).toEqual(
      kbdReports(encodeText('Hello Ada!')),
    );
  });

  it('encodes a missing field value as empty text', () => {
    expect(kbdReports(encodeMacro('[{{name}}]'))).toEqual(kbdReports(encodeText('[]')));
  });

  it('passes unknown tokens through as literal text', () => {
    expect([...encodeMacro('{bogus}')]).toEqual([...encodeText('{bogus}')]);
  });

  it('concatenates a mixed template in order', () => {
    expect(kbdReports(encodeMacro('a{tab}b'))).toEqual([
      [0, 0x04], // a
      [0, 0],
      [0, KEY.tab],
      [0, 0],
      [0, 0x05], // b
      [0, 0],
    ]);
  });

  it('encodeSegment encodes a single field with its value', () => {
    expect(kbdReports(encodeSegment({ type: 'field', name: 'n' }, { n: 'x' }))).toEqual([
      [0, 0x1b],
      [0, 0],
    ]);
  });
});

describe('click tokens', () => {
  // round(0.8 * 32767) = 26214 → ×2 on the wire = 52428 = 0xCCCC
  // round(0.9 * 32767) = 29490 → ×2 on the wire = 58980 = 0xE664
  const click8090 = [
    [4, 0x03, 0xcc, 0xcc, 0x64, 0xe6], // press (tip down)
    [4, 0x02, 0xcc, 0xcc, 0x64, 0xe6], // release
  ];

  it('encodes a percent click with the identity map as press + release', () => {
    expect(touchReports(encodeMacro('{click 80% 90%}'))).toEqual(click8090);
  });

  it('applies a non-identity calibration map to percent clicks', () => {
    const map: CalibrationMap = { minX: 8192, maxX: 24576, minY: 0, maxY: 32767 };
    // fx=0.5 → 16384 → wire 32768 = 0x8000; fy=1 → 32767 → wire 65534 = 0xFFFE
    expect(touchReports(encodeMacro('{click 50% 100%}', {}, { map }))).toEqual([
      [4, 0x03, 0x00, 0x80, 0xfe, 0xff],
      [4, 0x02, 0x00, 0x80, 0xfe, 0xff],
    ]);
  });

  it('resolves landmark clicks through ctx.landmark, case-insensitively', () => {
    const landmarks = [{ name: 'Save button', x: 100, y: 200 }];
    const ctx: ClickContext = {
      landmark: (name) => landmarks.find((l) => l.name.toLowerCase() === name.toLowerCase()),
    };
    expect(touchReports(encodeMacro('{click "save button"}', {}, ctx))).toEqual([
      [4, 0x03, 200, 0, 400 & 0xff, 400 >> 8],
      [4, 0x02, 200, 0, 400 & 0xff, 400 >> 8],
    ]);
  });

  it('encodes an unresolved landmark as zero bytes, never a throw', () => {
    const ctx: ClickContext = { landmark: () => undefined };
    expect(encodeMacro('{click "missing"}', {}, ctx)).toHaveLength(0);
    expect(encodeMacro('{click "no resolver"}')).toHaveLength(0);
  });

  it('keeps malformed click tokens as literal text', () => {
    expect([...encodeMacro('{click 80}')]).toEqual([...encodeText('{click 80}')]);
  });

  it('mixes text, click and chord in one template', () => {
    const encoded = encodeMacro('go{click 80% 90%}{ctrl+s}');
    const packets = parseAll(encoded);
    expect(packets.map((p) => p.cmd)).toEqual([
      CMD.HidKeyboardShort, // 'go'
      CMD.HidTouch, // click press
      CMD.HidTouch, // click release
      CMD.HidKeyboardShort, // ctrl+s
    ]);
  });
});
