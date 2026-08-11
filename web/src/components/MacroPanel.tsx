import { useRef, useState } from 'react';
import { useAppStore } from '../store';
import { exportMacrosJson, parseMacrosImport, type Macro } from '../macroStorage';
import { MACRO_STORE_BYTES } from '../macroSync';
import MacroEditor from './MacroEditor';
import MacroRunner from './MacroRunner';

type View = { kind: 'list' } | { kind: 'edit'; macro: Macro | null } | { kind: 'run'; macro: Macro };

/** Where a macro currently lives, shown as a badge on its row. */
function locationBadge(
  macro: Macro,
  /** Last known dongle residency is meaningful (offline cache or v5 dongle). */
  slotKnown: boolean,
): { text: string; title: string; className: string } {
  const slot = slotKnown ? macro.slot : undefined;
  if (slot === 0) {
    return {
      text: '★ Button macro',
      title:
        'Dongle slot 0: long-press (>1.5 s) the dongle button with no BLE connection ' +
        'to type this macro over USB.',
      className: 'macro-badge macro-badge-button',
    };
  }
  if (slot !== undefined) {
    return {
      text: 'On dongle',
      title: `Stored in dongle slot ${slot}.`,
      className: 'macro-badge macro-badge-dongle',
    };
  }
  return {
    text: 'This phone',
    title: 'Local draft — not on the dongle (yet). Syncs on connect when it fits.',
    className: 'macro-badge macro-badge-draft',
  };
}

/** Macros tab: manager list, editor, runner. Big buttons, one macro per row. */
export default function MacroPanel() {
  const connected = useAppStore((s) => s.connection === 'connected');
  const macros = useAppStore((s) => s.macros);
  const macroStoreSupported = useAppStore((s) => s.macroStoreSupported);
  const macroSyncing = useAppStore((s) => s.macroSyncing);
  const macroStorageUsed = useAppStore((s) => s.macroStorageUsed);
  const migrationAvailable = useAppStore((s) => s.migrationAvailable);
  const macroNotice = useAppStore((s) => s.macroNotice);
  const saveMacroEdit = useAppStore((s) => s.saveMacroEdit);
  const deleteMacro = useAppStore((s) => s.deleteMacro);
  const duplicateMacro = useAppStore((s) => s.duplicateMacro);
  const importMacros = useAppStore((s) => s.importMacros);
  const copyMacrosToDongle = useAppStore((s) => s.copyMacrosToDongle);
  const makeButtonMacro = useAppStore((s) => s.makeButtonMacro);
  const dismissMacroNotice = useAppStore((s) => s.dismissMacroNotice);

  const [view, setView] = useState<View>({ kind: 'list' });
  const [importError, setImportError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const storagePct = Math.min(100, Math.round((macroStorageUsed / MACRO_STORE_BYTES) * 100));

  const saveEdit = (editing: Macro | null, name: string, template: string) => {
    saveMacroEdit(editing, name, template);
    setView({ kind: 'list' });
  };

  const remove = (macro: Macro) => {
    if (!window.confirm(`Delete "${macro.name}"?`)) return;
    deleteMacro(macro);
  };

  const doExport = () => {
    const blob = new Blob([exportMacrosJson(macros)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'voicekb-macros.json';
    a.click();
    URL.revokeObjectURL(url);
  };

  const onImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-importing the same file
    if (!file) return;
    try {
      importMacros(parseMacrosImport(await file.text()));
      setImportError(null);
    } catch (err) {
      setImportError(err instanceof Error ? err.message : 'Could not import that file.');
    }
  };

  if (view.kind === 'edit') {
    return (
      <MacroEditor
        initial={view.macro}
        onSave={(name, template) => saveEdit(view.macro, name, template)}
        onCancel={() => setView({ kind: 'list' })}
      />
    );
  }

  if (view.kind === 'run') {
    return <MacroRunner macro={view.macro} onExit={() => setView({ kind: 'list' })} />;
  }

  return (
    <div className="macro-list">
      <div className="macro-toolbar">
        <button onClick={() => setView({ kind: 'edit', macro: null })}>New macro</button>
        <button className="secondary" onClick={doExport} disabled={macros.length === 0}>
          Export
        </button>
        <button className="secondary" onClick={() => fileRef.current?.click()}>
          Import
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json"
          hidden
          onChange={(e) => void onImportFile(e)}
        />
      </div>

      {importError && (
        <div className="error-banner" role="alert">
          <div>{importError}</div>
          <button className="secondary" onClick={() => setImportError(null)}>
            Dismiss
          </button>
        </div>
      )}

      {migrationAvailable && (
        <div className="macro-banner" role="status">
          <div>
            This dongle has no macros yet. Copy the {macros.length} macro(s) on this phone to it?
          </div>
          <button onClick={() => void copyMacrosToDongle()}>Copy to dongle</button>
        </div>
      )}

      {macroNotice && (
        <div className="macro-banner" role="status">
          <div>{macroNotice}</div>
          <button className="secondary" onClick={dismissMacroNotice}>
            Dismiss
          </button>
        </div>
      )}

      {connected && macroStoreSupported && (
        <div className="macro-meter" title="Dongle macro store usage">
          <div className="macro-meter-track">
            <div className="macro-meter-fill" style={{ width: `${storagePct}%` }} />
          </div>
          <div className="macro-meter-label">
            Dongle storage: {(macroStorageUsed / 1024).toFixed(1)} / 16 KB
            {macroSyncing ? ' — syncing…' : ''}
          </div>
        </div>
      )}

      {!connected && (
        <div className="macro-hint">
          Connect to a dongle to run a macro. Edits made offline stay on this phone and sync on
          the next connect.
        </div>
      )}
      {connected && !macroStoreSupported && (
        <div className="macro-hint">
          This dongle's firmware has no macro store (needs vk-5.0) — macros stay on this phone.
        </div>
      )}
      {connected && macroStoreSupported && (
        <div className="macro-hint">
          The ★ button macro (dongle slot 0) plays when you long-press (&gt;1.5 s) the dongle
          button while nothing is connected.
        </div>
      )}

      {macros.map((m) => {
        // Offline the cached slot is still the best known state; a connected
        // pre-v5 dongle has no store at all, so slots are meaningless there.
        const badge = locationBadge(m, !connected || macroStoreSupported);
        return (
          <div className="macro-row" key={m.id}>
            <div className="macro-name-row">
              <div className="macro-name">{m.name}</div>
              <span className={badge.className} title={badge.title}>
                {badge.text}
              </span>
            </div>
            <div className="macro-actions">
              <button
                className="macro-run"
                disabled={!connected}
                onClick={() => setView({ kind: 'run', macro: m })}
              >
                Run
              </button>
              <button
                className="secondary macro-small"
                onClick={() => setView({ kind: 'edit', macro: m })}
              >
                Edit
              </button>
              <button className="secondary macro-small" onClick={() => duplicateMacro(m)}>
                Duplicate
              </button>
              {macroStoreSupported && m.slot !== 0 && (
                <button
                  className="secondary macro-small"
                  title="Make this the macro played by a long press of the dongle button"
                  onClick={() => makeButtonMacro(m)}
                >
                  ★ Button
                </button>
              )}
              <button className="secondary macro-small" onClick={() => remove(m)}>
                Delete
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
