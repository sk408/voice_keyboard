import { useState } from 'react';
import { useAppStore } from '../store';
import { IDENTITY_MAP } from '../calibration';
import CalibrationWizard from './CalibrationWizard';

/** Settings tab: one-finger trackpad mode and pointer calibration. */
export default function SettingsPanel() {
  const connected = useAppStore((s) => s.connection === 'connected');
  const oneFinger = useAppStore((s) => s.defaultOneFinger);
  const setDefaultOneFinger = useAppStore((s) => s.setDefaultOneFinger);
  const calibration = useAppStore((s) => s.calibration);
  const deviceKey = useAppStore((s) => s.deviceName ?? 'default');

  const [calibrating, setCalibrating] = useState(false);

  const isIdentity =
    calibration.minX === IDENTITY_MAP.minX &&
    calibration.maxX === IDENTITY_MAP.maxX &&
    calibration.minY === IDENTITY_MAP.minY &&
    calibration.maxY === IDENTITY_MAP.maxY;

  if (calibrating) {
    return <CalibrationWizard onClose={() => setCalibrating(false)} />;
  }

  return (
    <div className="settings-panel">
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
