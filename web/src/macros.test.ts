import { describe, expect, it } from 'vitest';
import { encodeMacro, encodeSegment, macroFields, tokenizeMacro } from './macros';
import { MODIFIER_BITS, encodeText } from './protocol';

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
