import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../store';

/**
 * Live mode: every change to the field is diffed against the previous
 * value and the edit (backspaces + inserted text) is streamed to the PC.
 * This covers typing, Gboard voice dictation, autocorrect rewrites and
 * suggestion swaps without special-casing any of them.
 */
export default function LiveInput() {
  const connected = useAppStore((s) => s.connection === 'connected');
  const sendEdit = useAppStore((s) => s.sendEdit);
  const [value, setValue] = useState('');
  const valueRef = useRef(value);
  valueRef.current = value;
  const areaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (connected) areaRef.current?.focus();
  }, [connected]);

  return (
    <div className="input-panel">
      <textarea
        ref={areaRef}
        className="type-area"
        placeholder={
          connected
            ? 'Type or tap the mic on your keyboard — text appears on the PC live'
            : 'Connect to a dongle to start typing'
        }
        value={value}
        disabled={!connected}
        autoCapitalize="sentences"
        autoCorrect="on"
        rows={6}
        onChange={(e) => {
          const next = e.target.value;
          void sendEdit(valueRef.current, next);
          setValue(next);
        }}
      />
      <div className="panel-actions">
        <button
          className="secondary"
          disabled={!connected || value.length === 0}
          onClick={() => {
            void sendEdit(valueRef.current, '');
            setValue('');
          }}
        >
          Clear (erases on PC too)
        </button>
      </div>
    </div>
  );
}
