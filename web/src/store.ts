import { create } from 'zustand';
import { DongleConnection, describeBleError } from './ble';
import { encodeEdit, encodeSpecialKey, encodeText, type SpecialKey } from './protocol';

export type ConnectionState = 'disconnected' | 'connecting' | 'connected';
export type TypingMode = 'live' | 'compose';
export type DongleStatus = 'idle' | 'busy' | 'error';

const MODE_STORAGE_KEY = 'voicekb.mode';

function loadMode(): TypingMode {
  try {
    return localStorage.getItem(MODE_STORAGE_KEY) === 'compose' ? 'compose' : 'live';
  } catch {
    return 'live';
  }
}

interface AppState {
  bleSupported: boolean;
  connection: ConnectionState;
  /** A GATT connect + encrypted TX subscribe succeeded at least once this session. */
  bonded: boolean;
  dongleStatus: DongleStatus;
  deviceName: string | null;
  error: string | null;
  /** Show "press the dongle button to enter pairing mode" guidance. */
  pairingHint: boolean;
  mode: TypingMode;
  /** Devices already granted to this origin, for one-tap reconnect. */
  grantedDevices: BluetoothDevice[];

  setMode(mode: TypingMode): void;
  refreshGrantedDevices(): Promise<void>;
  connectViaChooser(): Promise<void>;
  connectTo(device: BluetoothDevice): Promise<void>;
  disconnect(): void;
  forgetDevice(): Promise<void>;
  sendText(text: string): Promise<void>;
  /** Live mode: apply an edit from prev to next (backspaces + insert). */
  sendEdit(prev: string, next: string): Promise<void>;
  sendSpecialKey(key: SpecialKey): Promise<void>;
  clearError(): void;
}

let dongle: DongleConnection | null = null;
/** Sends currently in flight; drives the optimistic "typing…" badge. */
let pendingSends = 0;

export const useAppStore = create<AppState>((set, get) => {
  function handleSendError(e: unknown): void {
    const { message, pairingHint } = describeBleError(e);
    set({ error: message, pairingHint });
  }

  /**
   * Optimistic "typing…" badge: flips busy as soon as a send is queued
   * and back to idle once every queued send has completed. Firmware TX
   * notifications keep driving the badge too, but this way a dead notify
   * path (no status bytes from the dongle) is distinguishable from a
   * dead write path (badge never flips even optimistically).
   */
  function sendBegin(): void {
    pendingSends++;
    set({ dongleStatus: 'busy' });
  }

  function sendEnd(): void {
    pendingSends = Math.max(0, pendingSends - 1);
    if (pendingSends === 0 && get().dongleStatus === 'busy') {
      set({ dongleStatus: 'idle' });
    }
  }

  return {
    bleSupported: DongleConnection.isSupported(),
    connection: 'disconnected',
    bonded: false,
    dongleStatus: 'idle',
    deviceName: null,
    error: null,
    pairingHint: false,
    mode: loadMode(),
    grantedDevices: [],

    setMode(mode) {
      set({ mode });
      try {
        localStorage.setItem(MODE_STORAGE_KEY, mode);
      } catch {
        /* storage unavailable — non-fatal */
      }
    },

    async refreshGrantedDevices() {
      const devices = await DongleConnection.getGrantedDevices();
      set({ grantedDevices: devices });
    },

    async connectViaChooser() {
      set({ error: null, pairingHint: false });
      let device: BluetoothDevice;
      try {
        device = await DongleConnection.requestDevice();
      } catch (e) {
        const { message, pairingHint } = describeBleError(e);
        set({ error: message, pairingHint });
        return;
      }
      await get().connectTo(device);
    },

    async connectTo(device) {
      dongle?.disconnect();
      dongle = null;
      set({
        connection: 'connecting',
        error: null,
        pairingHint: false,
        deviceName: device.name ?? 'VoiceKB dongle',
      });
      try {
        let conn: DongleConnection | null = null;
        conn = await DongleConnection.connect(
          device,
          // Guard both callbacks by identity: listeners from a previous
          // connection instance on the same device must not clobber the
          // state of the current one.
          (status) => {
            if (conn !== null && dongle === conn) set({ dongleStatus: status });
          },
          () => {
            if (conn === null || dongle !== conn) return;
            dongle = null;
            set({ connection: 'disconnected', bonded: false, dongleStatus: 'idle' });
          },
        );
        dongle = conn;
        set({ connection: 'connected', bonded: true, dongleStatus: 'idle' });
      } catch (e) {
        const { message } = describeBleError(e);
        set({
          connection: 'disconnected',
          error: message,
          // A failed connect is most often an unpaired device outside the
          // pairing window — always offer the button guidance here.
          pairingHint: true,
        });
      }
    },

    disconnect() {
      dongle?.disconnect();
      dongle = null;
      set({ connection: 'disconnected', bonded: false, dongleStatus: 'idle' });
    },

    async forgetDevice() {
      try {
        await dongle?.forget();
      } finally {
        dongle = null;
        set({ connection: 'disconnected', bonded: false, dongleStatus: 'idle', deviceName: null });
        await get().refreshGrantedDevices();
      }
    },

    async sendText(text) {
      if (!dongle || get().connection !== 'connected') {
        set({ error: 'Not connected to a dongle.' });
        return;
      }
      try {
        set({ error: null });
        sendBegin();
        await dongle.send(encodeText(text));
      } catch (e) {
        handleSendError(e);
      } finally {
        sendEnd();
      }
    },

    async sendEdit(prev, next) {
      if (!dongle || get().connection !== 'connected') return;
      const payload = encodeEdit(prev, next);
      if (payload.length === 0) return;
      try {
        sendBegin();
        await dongle.send(payload);
      } catch (e) {
        handleSendError(e);
      } finally {
        sendEnd();
      }
    },

    async sendSpecialKey(key) {
      if (!dongle || get().connection !== 'connected') return;
      try {
        sendBegin();
        await dongle.send(encodeSpecialKey(key));
      } catch (e) {
        handleSendError(e);
      } finally {
        sendEnd();
      }
    },

    clearError() {
      set({ error: null, pairingHint: false });
    },
  };
});
