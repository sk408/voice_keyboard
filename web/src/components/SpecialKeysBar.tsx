import { useAppStore } from '../store';
import type { SpecialKey } from '../protocol';

/**
 * Special keys bar. Tab/Enter/Backspace are plain protocol bytes
 * (\t / \n / 0x08); the rest are 0x00-escaped special codes.
 */
type KeyDef =
  | { label: string; kind: 'special'; key: SpecialKey; wide?: boolean }
  | { label: string; kind: 'text'; text: string; wide?: boolean };

const KEYS: KeyDef[] = [
  { label: 'Esc', kind: 'special', key: 'esc' },
  { label: 'Tab', kind: 'text', text: '\t' },
  { label: 'Enter ⏎', kind: 'text', text: '\n', wide: true },
  { label: '⌫', kind: 'text', text: '\b' },
  { label: '←', kind: 'special', key: 'left' },
  { label: '↑', kind: 'special', key: 'up' },
  { label: '↓', kind: 'special', key: 'down' },
  { label: '→', kind: 'special', key: 'right' },
  { label: 'Del', kind: 'special', key: 'delete' },
];

export default function SpecialKeysBar() {
  const connected = useAppStore((s) => s.connection === 'connected');
  const sendSpecialKey = useAppStore((s) => s.sendSpecialKey);
  const sendText = useAppStore((s) => s.sendText);

  return (
    <div className="keys-bar" role="group" aria-label="Special keys">
      {KEYS.map((k) => (
        <button
          key={k.label}
          className={`key-btn${k.wide ? ' key-wide' : ''}`}
          disabled={!connected}
          onClick={() => {
            if (k.kind === 'special') void sendSpecialKey(k.key);
            else void sendText(k.text);
          }}
        >
          {k.label}
        </button>
      ))}
    </div>
  );
}
