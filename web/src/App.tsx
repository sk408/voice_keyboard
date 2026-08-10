import { useEffect, useState } from 'react';
import { useAppStore } from './store';
import StatusBar from './components/StatusBar';
import ModeToggle from './components/ModeToggle';
import LiveInput from './components/LiveInput';
import ComposeBox from './components/ComposeBox';
import ModifierBar from './components/ModifierBar';
import SpecialKeysBar from './components/SpecialKeysBar';
import MousePad from './components/MousePad';

type Tab = 'keyboard' | 'mouse';

export default function App() {
  const mode = useAppStore((s) => s.mode);
  const bleSupported = useAppStore((s) => s.bleSupported);
  const refreshGrantedDevices = useAppStore((s) => s.refreshGrantedDevices);
  const [tab, setTab] = useState<Tab>('keyboard');

  useEffect(() => {
    void refreshGrantedDevices();
  }, [refreshGrantedDevices]);

  if (!bleSupported) {
    return (
      <div className="app">
        <h1>Voice Keyboard</h1>
        <div className="error-banner">
          Web Bluetooth is not available in this browser. Use Chrome on Android (or desktop
          Chrome) over HTTPS.
        </div>
      </div>
    );
  }

  const tabButton = (value: Tab, label: string) => (
    <button
      className={tab === value ? 'mode-active' : ''}
      aria-pressed={tab === value}
      onClick={() => setTab(value)}
    >
      {label}
    </button>
  );

  return (
    <div className="app">
      <StatusBar />
      {/* Tab switch is pure view state: the BLE connection lives in the
          store and neither tab owns it, so switching never disconnects. */}
      <div className="mode-toggle" role="group" aria-label="Tab">
        {tabButton('keyboard', 'Keyboard')}
        {tabButton('mouse', 'Mouse')}
      </div>
      {/* Kept mounted (hidden) while the mouse tab is active so live/compose
          drafts survive tab switches. */}
      <div className={`tab-panel${tab === 'keyboard' ? '' : ' hidden'}`}>
        <ModeToggle />
        {mode === 'live' ? <LiveInput /> : <ComposeBox />}
        <ModifierBar />
        <SpecialKeysBar />
      </div>
      {tab === 'mouse' && <MousePad />}
    </div>
  );
}
