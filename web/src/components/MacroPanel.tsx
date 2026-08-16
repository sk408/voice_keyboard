import { useRef, useState } from 'react';
import { useAppStore } from '../store';
import { exportMacrosJson, parseMacrosImport, type Macro } from '../macroStorage';
import MacroEditor from './MacroEditor';
import MacroRunner from './MacroRunner';

type View = { kind: 'list' } | { kind: 'edit'; macro: Macro | null } | { kind: 'run'; macro: Macro };

/** Macros tab: manager list, editor, runner. Big buttons, one macro per row. */
export default function MacroPanel() {
  const connected = useAppStore((s) => s.connection === 'connected');
  const macros = useAppStore((s) => s.macros);
  const saveMacroEdit = useAppStore((s) => s.saveMacroEdit);
  const deleteMacro = useAppStore((s) => s.deleteMacro);
  const duplicateMacro = useAppStore((s) => s.duplicateMacro);
  const importMacros = useAppStore((s) => s.importMacros);

  const [view, setView] = useState<View>({ kind: 'list' });
  const [importError, setImportError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

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

      {!connected && <div className="macro-hint">Connect to a dongle to run a macro.</div>}

      {macros.map((m) => (
        <div className="macro-row" key={m.id}>
          <div className="macro-name-row">
            <div className="macro-name">{m.name}</div>
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
            <button className="secondary macro-small" onClick={() => remove(m)}>
              Delete
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
