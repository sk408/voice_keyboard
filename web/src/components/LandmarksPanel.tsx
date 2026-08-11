import { useState } from 'react';
import { useAppStore } from '../store';

/**
 * Landmarks (Mouse tab, below the buttons): save the last-sent absolute
 * cursor position under a name, then teleport back to it — optionally
 * clicking — or delete it. Landmarks are stored per device and can also be
 * referenced from macros via {click "name"} tokens.
 */
export default function LandmarksPanel() {
  const connected = useAppStore((s) => s.connection === 'connected');
  const landmarks = useAppStore((s) => s.landmarks);
  const lastAbsolute = useAppStore((s) => s.lastAbsolute);
  const saveCurrentSpot = useAppStore((s) => s.saveCurrentSpot);
  const goToLandmark = useAppStore((s) => s.goToLandmark);
  const removeLandmark = useAppStore((s) => s.removeLandmark);

  const [name, setName] = useState('');
  const [saved, setSaved] = useState<string | null>(null);

  const save = () => {
    const trimmed = name.trim();
    if (saveCurrentSpot(trimmed)) {
      setSaved(`Saved “${trimmed}”.`);
      setName('');
    }
  };

  return (
    <div className="landmarks-panel">
      <h2>Landmarks</h2>
      <div className="macro-hint">
        Save the current cursor spot, then jump back to it with one tap. Usable in macros as{' '}
        {'{click "name"}'}.
      </div>
      <input
        className="text-input"
        value={name}
        placeholder="Spot name (e.g. Save button)"
        aria-label="Landmark name"
        onChange={(e) => {
          setName(e.target.value);
          setSaved(null);
        }}
      />
      <div className="panel-actions">
        <button
          disabled={!connected || lastAbsolute === null || name.trim() === ''}
          onClick={save}
        >
          Save current spot
        </button>
      </div>
      {connected && lastAbsolute === null && (
        <div className="macro-hint">Move the pointer on the trackpad first to have a spot.</div>
      )}
      {saved && (
        <div className="confirm-banner" role="status">
          {saved}
        </div>
      )}
      {landmarks.map((lm) => (
        <div className="macro-row" key={lm.name}>
          <div className="macro-name">{lm.name}</div>
          <div className="macro-actions">
            <button
              className="macro-run"
              disabled={!connected}
              onClick={() => goToLandmark(lm.name)}
            >
              Go
            </button>
            <button
              className="secondary macro-small"
              disabled={!connected}
              onClick={() => goToLandmark(lm.name, true)}
            >
              Go + click
            </button>
            <button className="secondary macro-small" onClick={() => removeLandmark(lm.name)}>
              Delete
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
