import { useState } from 'react';
import { useAppStore } from '../store';

/**
 * Compose mode: build up a block of text (type, paste, dictate), then
 * send it to the PC in one go.
 */
export default function ComposeBox() {
  const connected = useAppStore((s) => s.connection === 'connected');
  const dongleStatus = useAppStore((s) => s.dongleStatus);
  const sendText = useAppStore((s) => s.sendText);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);

  const send = async () => {
    if (!text) return;
    setSending(true);
    try {
      await sendText(text);
      setText('');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="input-panel">
      <textarea
        className="type-area"
        placeholder={
          connected
            ? 'Compose or dictate a block of text, then tap Send'
            : 'Connect to a dongle to start typing'
        }
        value={text}
        disabled={!connected}
        rows={6}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="panel-actions">
        <button
          disabled={!connected || sending || dongleStatus === 'busy' || text.length === 0}
          onClick={() => void send()}
        >
          {sending ? 'Sending…' : 'Send to PC'}
        </button>
        <button className="secondary" disabled={text.length === 0} onClick={() => setText('')}>
          Clear
        </button>
      </div>
    </div>
  );
}
