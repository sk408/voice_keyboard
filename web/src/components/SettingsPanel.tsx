import { useEffect, useState } from 'react';
import { useAppStore } from '../store';

const NAME_RE = /^[\x20-\x7e]{1,20}$/;

/** Settings tab: dongle device name (v3 config characteristic). */
export default function SettingsPanel() {
  const connected = useAppStore((s) => s.connection === 'connected');
  const customName = useAppStore((s) => s.customName);
  const deviceNameSupported = useAppStore((s) => s.deviceNameSupported);
  const setDeviceName = useAppStore((s) => s.setDeviceName);

  const [name, setName] = useState(customName ?? '');
  const [saved, setSaved] = useState<string | null>(null);

  // Prefill with the dongle's current name once read (on connect).
  useEffect(() => {
    if (customName !== null) setName(customName);
  }, [customName]);

  const valid = NAME_RE.test(name);

  const save = async () => {
    setSaved(null);
    if (await setDeviceName(name)) {
      setSaved(`Name saved — the dongle will advertise as ${name}`);
    }
  };

  return (
    <div className="settings-panel">
      <section className="settings-section">
        <h2>Device name</h2>
        <input
          className="text-input"
          value={name}
          maxLength={20}
          placeholder="VoiceKB"
          aria-label="Device name"
          onChange={(e) => {
            setName(e.target.value);
            setSaved(null);
          }}
        />
        <div className="macro-hint">1–20 printable ASCII characters. Default: VoiceKB.</div>
        {connected && !deviceNameSupported && (
          <div className="macro-hint">This dongle's firmware does not support renaming.</div>
        )}
        <div className="panel-actions">
          <button disabled={!connected || !valid} onClick={() => void save()}>
            Save
          </button>
        </div>
        {saved && (
          <div className="confirm-banner" role="status">
            {saved}
          </div>
        )}
      </section>
    </div>
  );
}
