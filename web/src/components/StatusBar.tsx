import { useAppStore } from '../store';

export default function StatusBar() {
  const connection = useAppStore((s) => s.connection);
  const dongleStatus = useAppStore((s) => s.dongleStatus);
  const deviceName = useAppStore((s) => s.deviceName);
  const firmwareVersion = useAppStore((s) => s.firmwareVersion);
  const error = useAppStore((s) => s.error);
  const grantedDevices = useAppStore((s) => s.grantedDevices);
  const connectViaChooser = useAppStore((s) => s.connectViaChooser);
  const connectTo = useAppStore((s) => s.connectTo);
  const disconnect = useAppStore((s) => s.disconnect);
  const forgetDevice = useAppStore((s) => s.forgetDevice);
  const clearError = useAppStore((s) => s.clearError);

  const connected = connection === 'connected';

  return (
    <header className="status-bar">
      <div className="status-row">
        <span className={`dot dot-${connection}`} aria-hidden />
        <span className="status-text">
          {connection === 'disconnected' && 'Disconnected'}
          {connection === 'connecting' && `Connecting to ${deviceName ?? 'dongle'}…`}
          {connected && (deviceName ?? 'Connected')}
        </span>
        {connected && (
          <>
            {firmwareVersion && <span className="badge badge-ok">fw {firmwareVersion}</span>}
            <span className={`badge ${dongleStatus === 'busy' ? 'badge-busy' : ''}`}>
              {dongleStatus === 'busy' ? 'typing…' : dongleStatus === 'error' ? 'USB not ready' : 'ready'}
            </span>
          </>
        )}
      </div>

      <div className="status-actions">
        {connected ? (
          <>
            <button onClick={disconnect}>Disconnect</button>
            <button className="secondary" onClick={() => void forgetDevice()}>
              Forget
            </button>
          </>
        ) : (
          <button disabled={connection === 'connecting'} onClick={() => void connectViaChooser()}>
            {connection === 'connecting' ? 'Connecting…' : 'Connect'}
          </button>
        )}
      </div>

      {!connected && grantedDevices.length > 0 && (
        <div className="granted-list">
          <span className="granted-label">Reconnect:</span>
          {grantedDevices.map((d) => (
            <button
              key={d.id}
              className="secondary"
              disabled={connection === 'connecting'}
              onClick={() => void connectTo(d)}
            >
              {d.name ?? 'InputStick dongle'}
            </button>
          ))}
        </div>
      )}

      {error && (
        <div className="error-banner" role="alert">
          <div>{error}</div>
          <button className="secondary" onClick={clearError}>
            Dismiss
          </button>
        </div>
      )}
    </header>
  );
}
