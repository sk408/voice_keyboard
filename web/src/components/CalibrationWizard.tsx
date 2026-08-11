import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../store';
import { deriveCalibration, screenFractionToNorm } from '../calibration';

interface Props {
  /** Close the wizard (cancel or done). */
  onClose(): void;
}

type Step = 'verify-tl' | 'verify-br' | 'learn' | 'done';

/** Learn-mode corners, in the order the user is walked through them. */
const CORNERS = [
  { fx: 0, fy: 0, label: 'top-left' },
  { fx: 1, fy: 0, label: 'top-right' },
  { fx: 0, fy: 1, label: 'bottom-left' },
  { fx: 1, fy: 1, label: 'bottom-right' },
] as const;

/** Flush period for the learn-mode pad: 20 ms = 50 packets/s max. */
const FLUSH_MS = 20;

/**
 * Calibration wizard (Settings → Calibrate pointer).
 *
 * Verify-first: the cursor is teleported to the top-left, then bottom-right
 * corner through the *current* map; if the user confirms both, the map is
 * kept and we're done. Any "No" starts four-corner learn mode: for each
 * corner the user drags on the pad until the host cursor sits exactly at
 * that corner, then taps "Set corner" — the last-sent normalized coords
 * (store.lastAbsolute) are recorded against the corner's true fraction.
 * After four corners, deriveCalibration produces the new map.
 */
export default function CalibrationWizard({ onClose }: Props) {
  const connected = useAppStore((s) => s.connection === 'connected');
  const sendAbsolute = useAppStore((s) => s.sendAbsolute);
  const setCalibration = useAppStore((s) => s.setCalibration);

  const [step, setStep] = useState<Step>('verify-tl');
  const [learnIndex, setLearnIndex] = useState(0);
  const [samples, setSamples] = useState<{ fx: number; fy: number; x: number; y: number }[]>([]);
  /** True once the user has dragged on the pad for the current corner. */
  const [dragged, setDragged] = useState(false);
  /** done step: whether a new map was learned (vs. the old one confirmed). */
  const [learned, setLearned] = useState(false);

  // Verify steps: teleport the cursor to the corner through the current map.
  useEffect(() => {
    if (step !== 'verify-tl' && step !== 'verify-br') return;
    const f = step === 'verify-tl' ? { fx: 0, fy: 0 } : { fx: 1, fy: 1 };
    const { x, y } = screenFractionToNorm(useAppStore.getState().calibration, f.fx, f.fy);
    sendAbsolute(0, x, y);
  }, [step, sendAbsolute]);

  /* Learn-mode pad: drag → absolute moves through the current map. */
  const padRef = useRef<HTMLDivElement>(null);
  const activePointer = useRef<number | null>(null);
  const pending = useRef<{ x: number; y: number } | null>(null);
  const flushTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    const timer = flushTimer.current;
    return () => window.clearInterval(timer);
  }, []);

  const flush = () => {
    const p = pending.current;
    if (!p) return;
    pending.current = null;
    sendAbsolute(0, p.x, p.y);
  };

  const queueFromEvent = (e: React.PointerEvent<HTMLDivElement>) => {
    const rect = padRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return;
    const fx = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const fy = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height));
    pending.current = screenFractionToNorm(useAppStore.getState().calibration, fx, fy);
    setDragged(true);
  };

  const onPadDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!connected) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    activePointer.current = e.pointerId;
    queueFromEvent(e);
    if (flushTimer.current === undefined) {
      flushTimer.current = window.setInterval(flush, FLUSH_MS);
    }
  };

  const onPadMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (activePointer.current !== e.pointerId) return;
    queueFromEvent(e);
  };

  const onPadUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (activePointer.current !== e.pointerId) return;
    activePointer.current = null;
    window.clearInterval(flushTimer.current);
    flushTimer.current = undefined;
    queueFromEvent(e); // capture the final resting position
    flush();
  };

  const startLearn = () => {
    setSamples([]);
    setLearnIndex(0);
    setDragged(false);
    setStep('learn');
  };

  const corner = CORNERS[learnIndex];

  const setCorner = () => {
    // The last-sent absolute position is the corner sample.
    const spot = useAppStore.getState().lastAbsolute;
    if (!spot) return;
    const next = [...samples, { fx: corner.fx, fy: corner.fy, x: spot.x, y: spot.y }];
    if (next.length === CORNERS.length) {
      setCalibration(deriveCalibration(next));
      setLearned(true);
      setStep('done');
      return;
    }
    setSamples(next);
    setLearnIndex(learnIndex + 1);
    setDragged(false);
  };

  if (step === 'verify-tl' || step === 'verify-br') {
    const label = step === 'verify-tl' ? 'top-left' : 'bottom-right';
    return (
      <div className="wizard-panel">
        <h2 className="wizard-title">Calibrate pointer</h2>
        <div className="macro-hint">
          The cursor was just teleported to the {label} corner of the screen using the current
          calibration. Is the cursor exactly at the {label} corner?
        </div>
        <div className="panel-actions">
          <button
            disabled={!connected}
            onClick={() => setStep(step === 'verify-tl' ? 'verify-br' : 'done')}
          >
            Yes
          </button>
          <button className="secondary" disabled={!connected} onClick={startLearn}>
            No
          </button>
        </div>
        <button className="secondary" onClick={onClose}>
          Cancel
        </button>
      </div>
    );
  }

  if (step === 'learn') {
    return (
      <div className="wizard-panel">
        <h2 className="wizard-title">
          Calibrate pointer — corner {learnIndex + 1} of {CORNERS.length}
        </h2>
        <div className="macro-hint">
          Drag on the pad below until the cursor on the PC sits exactly at the{' '}
          <span className="wizard-corner">{corner.label}</span> corner of the actual screen, then
          tap “Set corner”.
        </div>
        <div
          ref={padRef}
          className={`trackpad wizard-pad${connected ? '' : ' trackpad-disabled'}`}
          role="application"
          aria-label="Calibration pad"
          onPointerDown={onPadDown}
          onPointerMove={onPadMove}
          onPointerUp={onPadUp}
          onPointerCancel={onPadUp}
          onContextMenu={(e) => e.preventDefault()}
        >
          <span className="trackpad-hint">
            {connected ? 'drag here to position the cursor' : 'Connect to a dongle first'}
          </span>
        </div>
        <div className="panel-actions">
          <button disabled={!connected || !dragged} onClick={setCorner}>
            Set corner
          </button>
          <button className="secondary" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="wizard-panel">
      <h2 className="wizard-title">Calibrate pointer</h2>
      <div className="confirm-banner" role="status">
        {learned
          ? 'Calibration saved for this device.'
          : 'Both corners confirmed — keeping the current calibration.'}
      </div>
      <button onClick={onClose}>Close</button>
    </div>
  );
}
