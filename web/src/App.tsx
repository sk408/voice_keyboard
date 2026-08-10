import { useEffect } from 'react';
import { useAppStore } from './store';
import StatusBar from './components/StatusBar';
import ModeToggle from './components/ModeToggle';
import LiveInput from './components/LiveInput';
import ComposeBox from './components/ComposeBox';
import SpecialKeysBar from './components/SpecialKeysBar';

export default function App() {
  const mode = useAppStore((s) => s.mode);
  const bleSupported = useAppStore((s) => s.bleSupported);
  const refreshGrantedDevices = useAppStore((s) => s.refreshGrantedDevices);

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

  return (
    <div className="app">
      <StatusBar />
      <ModeToggle />
      {mode === 'live' ? <LiveInput /> : <ComposeBox />}
      <SpecialKeysBar />
    </div>
  );
}
