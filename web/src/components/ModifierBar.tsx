import { useAppStore, type Modifiers } from '../store';
import type { ModifierKey } from '../protocol';

/**
 * Sticky modifier bar (protocol v2). Tap cycles each modifier through
 * off → armed (applies to the next key, 0x81) → locked (held, 0x82) → off
 * (0x82 with the remaining set, or 0x83 when nothing stays held). Armed
 * and locked state is always visible on the buttons and the status line.
 */
const ORDER: ModifierKey[] = ['ctrl', 'shift', 'alt', 'gui'];
const LABELS: Record<ModifierKey, string> = {
  ctrl: 'Ctrl',
  shift: 'Shift',
  alt: 'Alt',
  gui: 'Gui',
};

function statusLine(modifiers: Modifiers): string | null {
  const armed = ORDER.filter((k) => modifiers[k] === 'armed').map((k) => LABELS[k]);
  const locked = ORDER.filter((k) => modifiers[k] === 'locked').map((k) => LABELS[k]);
  const parts: string[] = [];
  if (armed.length) parts.push(`armed for next key: ${armed.join(' + ')}`);
  if (locked.length) parts.push(`held: ${locked.join(' + ')}`);
  return parts.length ? parts.join(' · ') : null;
}

export default function ModifierBar() {
  const connected = useAppStore((s) => s.connection === 'connected');
  const modifiers = useAppStore((s) => s.modifiers);
  const tapModifier = useAppStore((s) => s.tapModifier);
  const releaseModifiers = useAppStore((s) => s.releaseModifiers);

  const line = statusLine(modifiers);
  const anyActive = line !== null;

  return (
    <div className="modifier-bar" role="group" aria-label="Sticky modifiers">
      <div className="modifier-row">
        {ORDER.map((key) => {
          const state = modifiers[key];
          return (
            <button
              key={key}
              className={`key-btn mod-btn${state !== 'off' ? ` mod-${state}` : ''}`}
              disabled={!connected}
              aria-pressed={state !== 'off'}
              title="Tap: arm for next key · again: lock (hold) · again: release"
              onClick={() => tapModifier(key)}
            >
              {LABELS[key]}
              {state === 'armed' && <span className="mod-tag">next</span>}
              {state === 'locked' && <span className="mod-tag">hold</span>}
            </button>
          );
        })}
        <button
          className="key-btn mod-btn mod-clear"
          disabled={!connected || !anyActive}
          title="Release all modifiers"
          onClick={() => releaseModifiers()}
        >
          Clear
        </button>
      </div>
      {line && <div className="modifier-status">{line}</div>}
    </div>
  );
}
