import { useState } from 'react';
import type { Macro } from '../macroStorage';

interface Props {
  /** null → creating a new macro. */
  initial: Macro | null;
  onSave(name: string, template: string): void;
  onCancel(): void;
}

const TOKEN_HINT =
  'Tokens: {tab} {enter} {esc} {up} {down} {left} {right} {del} {home} {end} {pgup} {pgdn} {f1}–{f12}. ' +
  'Chords: {ctrl+x}, {ctrl+shift+t}, {alt+f4}. ' +
  'Fill-in field: {{field name}} — you are asked for each field when the macro runs.';

/** Macro editor: name + template. Big controls, no nested menus. */
export default function MacroEditor({ initial, onSave, onCancel }: Props) {
  const [name, setName] = useState(initial?.name ?? '');
  const [template, setTemplate] = useState(initial?.template ?? '');

  // The dongle store caps names at 24 UTF-8 bytes (firmware limit).
  const nameBytes = new TextEncoder().encode(name.trim()).length;
  const canSave = name.trim().length > 0 && nameBytes <= 24 && template.length > 0;

  return (
    <div className="input-panel">
      <input
        className="text-input"
        placeholder="Macro name"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      {nameBytes > 24 && (
        <div className="macro-hint">Name is {nameBytes}/24 bytes — shorten it.</div>
      )}
      <textarea
        className="type-area macro-template"
        placeholder={'Template, e.g. Dear {{name}},{enter}{enter}…'}
        value={template}
        rows={8}
        onChange={(e) => setTemplate(e.target.value)}
      />
      <div className="macro-hint">{TOKEN_HINT}</div>
      <div className="panel-actions">
        <button disabled={!canSave} onClick={() => onSave(name.trim(), template)}>
          Save
        </button>
        <button className="secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
