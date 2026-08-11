import { describe, expect, it } from 'vitest';
import { encodeMacro, encodeSegment, macroFields, tokenizeMacro, type ClickContext } from './macros';
import { MODIFIER_BITS, encodeText } from './protocol';
import type { CalibrationMap } from './calibration';

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

  it('encodes {esc} as its two-byte escape sequence', () => {
    expect([...encodeMacro('{esc}')]).toEqual([0x00, 0x01]);
  });

  it('encodes {tab} and {enter} as raw bytes', () => {
    expect([...encodeMacro('{tab}')]).toEqual([0x09]);
    expect([...encodeMacro('{enter}')]).toEqual([0x0a]);
  });

  it('encodes {ctrl+x} as sticky-arm ctrl + x', () => {
    expect([...encodeMacro('{ctrl+x}')]).toEqual([0x00, 0x81, 0x01, 0x78]);
  });

  it('encodes {alt+f4} as sticky-arm alt + f4 escape', () => {
    expect([...encodeMacro('{alt+f4}')]).toEqual([0x00, 0x81, 0x04, 0x00, 0x13]);
  });

  it('substitutes field values via encodeText', () => {
    expect([...encodeMacro('Hello {{name}}!', { name: 'Ada' })]).toEqual([
      ...encodeText('Hello Ada!'),
    ]);
  });

  it('encodes a missing field value as empty text', () => {
    expect([...encodeMacro('[{{name}}]')]).toEqual([...encodeText('[]')]);
  });

  it('passes unknown tokens through as literal text bytes', () => {
    expect([...encodeMacro('{bogus}')]).toEqual([...encodeText('{bogus}')]);
  });

  it('concatenates a mixed template in order', () => {
    expect([...encodeMacro('A{tab}B')]).toEqual([...encodeText('A'), 0x09, ...encodeText('B')]);
  });

  it('encodeSegment encodes a single field with its value', () => {
    expect([...encodeSegment({ type: 'field', name: 'n' }, { n: 'x' })]).toEqual([0x78]);
  });
});

describe('click tokens (v4)', () => {
  // round(0.8 * 32767) = 26214 = 0x6666; round(0.9 * 32767) = 29490 = 0x7332
  const click8090 = [
    0x00, 0x91, 0x01, 0x66, 0x66, 0x32, 0x73, // press (left button)
    0x00, 0x91, 0x00, 0x66, 0x66, 0x32, 0x73, // release
  ];

  it('encodes a percent click with the identity map as press + release', () => {
    expect([...encodeMacro('{click 80% 90%}')]).toEqual(click8090);
  });

  it('applies a non-identity calibration map to percent clicks', () => {
    const map: CalibrationMap = { minX: 8192, maxX: 24576, minY: 0, maxY: 32767 };
    // fx=0.5 → 8192 + 0.5*16384 = 16384 = 0x4000; fy=1 → 32767 = 0x7fff
    expect([...encodeMacro('{click 50% 100%}', {}, { map })]).toEqual([
      0x00, 0x91, 0x01, 0x00, 0x40, 0xff, 0x7f,
      0x00, 0x91, 0x00, 0x00, 0x40, 0xff, 0x7f,
    ]);
  });

  it('resolves landmark clicks through ctx.landmark, case-insensitively', () => {
    const landmarks = [{ name: 'Save button', x: 100, y: 200 }];
    const ctx: ClickContext = {
      landmark: (name) => landmarks.find((l) => l.name.toLowerCase() === name.toLowerCase()),
    };
    expect([...encodeMacro('{click "save button"}', {}, ctx)]).toEqual([
      0x00, 0x91, 0x01, 100, 0, 200, 0,
      0x00, 0x91, 0x00, 100, 0, 200, 0,
    ]);
  });

  it('encodes an unresolved landmark as zero bytes, never a throw', () => {
    const ctx: ClickContext = { landmark: () => undefined };
    expect(encodeMacro('{click "missing"}', {}, ctx)).toHaveLength(0);
    expect(encodeMacro('{click "no resolver"}')).toHaveLength(0);
  });

  it('keeps malformed click tokens as literal text bytes', () => {
    expect([...encodeMacro('{click 80}')]).toEqual([...encodeText('{click 80}')]);
  });

  it('mixes text, click and chord in one template', () => {
    expect([...encodeMacro('Go{click 80% 90%}{ctrl+s}')]).toEqual([
      ...encodeText('Go'),
      ...click8090,
      0x00, 0x81, 0x01, 0x73, // sticky-arm ctrl + 's'
    ]);
  });
});
