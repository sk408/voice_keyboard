import { useEffect, useState } from 'react';
import { useAppStore } from '../store';
import { IDENTITY_MAP } from '../calibration';
import CalibrationWizard from './CalibrationWizard';

const NAME_RE = /^[\x20-\x7e]{1,20}$/;

/** Settings tab: dongle device name, one-finger trackpad mode, pointer calibration. */
export default function SettingsPanel() {
  const connected = useAppStore((s) => s.connection === 'connected');
  const customName = useAppStore((s) => s.customName);
  const deviceNameSupported = useAppStore((s) => s.deviceNameSupported);
  const setDeviceName = useAppStore((s) => s.setDeviceName);
  const oneFinger = useAppStore((s) => s.defaultOneFinger);
  const setDefaultOneFinger = useAppStore((s) => s.setDefaultOneFinger);
  const calibration = useAppStore((s) => s.calibration);
  const deviceKey = useAppStore((s) => s.customName ?? s.deviceName ?? 'default');

  const [name, setName] = useState(customName ?? '');
  const [saved, setSaved] = useState<string | null>(null);
  const [calibrating, setCalibrating] = useState(false);

  // Prefill with the dongle's current name once read (on connect).
  useEffect(() => {
    if (customName !== null) setName(customName);
  }, [customName]);

  const valid = NAME_RE.test(name);
  const isIdentity =
    calibration.minX === IDENTITY_MAP.minX &&
    calibration.maxX === IDENTITY_MAP.maxX &&
    calibration.minY === IDENTITY_MAP.minY &&
    calibration.maxY === IDENTITY_MAP.maxY;

  const save = async () => {
    setSaved(null);
    if (await setDeviceName(name)) {
      setSaved(`Name saved — the dongle will advertise as ${name}`);
    }
  };

  if (calibrating) {
    return <CalibrationWizard onClose={() => setCalibrating(false)} />;
  }

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

      <section className="settings-section">
        <h2>One-finger trackpad mode</h2>
        <div className="mode-toggle">
          <button
            className={oneFinger === 'absolute' ? 'mode-active' : ''}
            aria-pressed={oneFinger === 'absolute'}
            onClick={() => setDefaultOneFinger('absolute')}
          >
            Absolute pointer
          </button>
          <button
            className={oneFinger === 'relative' ? 'mode-active' : ''}
            aria-pressed={oneFinger === 'relative'}
            onClick={() => setDefaultOneFinger('relative')}
          >
            Classic relative
          </button>
        </div>
        <div className="macro-hint">
          Absolute: the trackpad maps to the whole screen — the cursor tracks your finger like a
          tablet. Relative: classic touchpad deltas. Two fingers always give classic deltas.
        </div>
      </section>

      <section className="settings-section">
        <h2>Pointer calibration</h2>
        <div className="macro-hint">
          {isIdentity
            ? `Using the default full-screen map for “${deviceKey}” (not calibrated).`
            : `Calibrated for “${deviceKey}”.`}
        </div>
        <div className="panel-actions">
          <button disabled={!connected} onClick={() => setCalibrating(true)}>
            {isIdentity ? 'Calibrate pointer' : 'Recalibrate'}
          </button>
        </div>
        {!connected && <div className="macro-hint">Connect to a dongle to calibrate.</div>}
      </section>
    </div>
  );
}
