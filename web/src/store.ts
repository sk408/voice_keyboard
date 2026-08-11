import { create } from 'zustand';
import { DEVICE_NAME_STORAGE_KEY, DongleConnection, describeBleError } from './ble';
import {
  MODIFIER_BITS,
  encodeEdit,
  encodeModifierHold,
  encodeModifierRelease,
  encodeMouse,
  encodeSpecialKey,
  encodeStickyArm,
  encodeText,
  type ModifierKey,
  type SpecialKey,
} from './protocol';

export type ConnectionState = 'disconnected' | 'connecting' | 'connected';
export type TypingMode = 'live' | 'compose';
export type DongleStatus = 'idle' | 'busy' | 'error';

/** Sticky modifier state: off → armed (next key) → locked (held) → off. */
export type ModifierState = 'off' | 'armed' | 'locked';
export type Modifiers = Record<ModifierKey, ModifierState>;

const MODIFIERS_OFF: Modifiers = { ctrl: 'off', shift: 'off', alt: 'off', gui: 'off' };

const MODE_STORAGE_KEY = 'voicekb.mode';

function loadMode(): TypingMode {
  try {
    return localStorage.getItem(MODE_STORAGE_KEY) === 'compose' ? 'compose' : 'live';
  } catch {
    return 'live';
  }
}

function loadCustomName(): string | null {
  try {
    return localStorage.getItem(DEVICE_NAME_STORAGE_KEY);
  } catch {
    return null;
  }
}

function persistCustomName(name: string): void {
  try {
    localStorage.setItem(DEVICE_NAME_STORAGE_KEY, name);
  } catch {
    /* storage unavailable — non-fatal */
  }
}

interface AppState {
  bleSupported: boolean;
  connection: ConnectionState;
  /** A GATT connect + encrypted TX subscribe succeeded at least once this session. */
  bonded: boolean;
  dongleStatus: DongleStatus;
  deviceName: string | null;
  /** Last known dongle advertising name (persisted to localStorage). */
  customName: string | null;
  /** False on v2 dongles without the config characteristic. */
  deviceNameSupported: boolean;
  error: string | null;
  /** Show "press the dongle button to enter pairing mode" guidance. */
  pairingHint: boolean;
  mode: TypingMode;
  /** Devices already granted to this origin, for one-tap reconnect. */
  grantedDevices: BluetoothDevice[];
  /** Sticky/locked modifier state for the keyboard tab. */
  modifiers: Modifiers;

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
  /** Cycle a modifier: off → armed → locked → off (sends 0x82/0x83 as needed). */
  tapModifier(key: ModifierKey): void;
  /** Release all armed/locked modifiers (sends 0x83 if any were held). */
  releaseModifiers(): void;
  /** Mouse tab: one relative mouse packet (0x90). Fire-and-forget. */
  sendMouse(buttons: number, dx: number, dy: number, wheel: number): void;
  /** Settings tab: write a new dongle advertising name. True on success. */
  setDeviceName(name: string): Promise<boolean>;
  /** Best-effort read of the dongle's current name into customName. */
  refreshDeviceName(): Promise<void>;
  /**
   * Macro runner: send one pre-encoded segment through the paced queue.
   * Returns false when not connected or the write failed (error is mapped
   * into the store error state either way).
   */
  sendSegment(payload: Uint8Array): Promise<boolean>;
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

  /** Shared send path: guards connection, drives the badge, maps errors. */
  async function sendRaw(payload: Uint8Array): Promise<void> {
    if (!dongle || get().connection !== 'connected') return;
    try {
      sendBegin();
      await dongle.send(payload);
    } catch (e) {
      handleSendError(e);
    } finally {
      sendEnd();
    }
  }

  function lockedMask(mods: Modifiers): number {
    let mask = 0;
    for (const key of Object.keys(MODIFIER_BITS) as ModifierKey[]) {
      if (mods[key] === 'locked') mask |= MODIFIER_BITS[key];
    }
    return mask;
  }

  /**
   * Prepend a 0x81 sticky-arm sequence when modifiers are armed, and
   * disarm them: the arm applies to the next keystroke only, so it must
   * ride in the same payload as that keystroke to survive write queueing.
   */
  function withArmedPrefix(payload: Uint8Array): Uint8Array {
    const mods = get().modifiers;
    let mask = 0;
    for (const key of Object.keys(MODIFIER_BITS) as ModifierKey[]) {
      if (mods[key] === 'armed') mask |= MODIFIER_BITS[key];
    }
    if (mask === 0) return payload;

    const next = { ...mods };
    for (const key of Object.keys(MODIFIER_BITS) as ModifierKey[]) {
      if (next[key] === 'armed') next[key] = 'off';
    }
    set({ modifiers: next });

    const out = new Uint8Array(3 + payload.length);
    out.set(encodeStickyArm(mask));
    out.set(payload, 3);
    return out;
  }

  return {
    bleSupported: DongleConnection.isSupported(),
    connection: 'disconnected',
    bonded: false,
    dongleStatus: 'idle',
    deviceName: null,
    customName: loadCustomName(),
    deviceNameSupported: false,
    error: null,
    pairingHint: false,
    mode: loadMode(),
    grantedDevices: [],
    modifiers: { ...MODIFIERS_OFF },

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
            set({
              connection: 'disconnected',
              bonded: false,
              dongleStatus: 'idle',
              deviceNameSupported: false,
              // The dongle drops held modifiers on disconnect; mirror that.
              modifiers: { ...MODIFIERS_OFF },
            });
          },
        );
        dongle = conn;
        set({
          connection: 'connected',
          bonded: true,
          dongleStatus: 'idle',
          deviceNameSupported: conn.supportsDeviceName,
        });
        void get().refreshDeviceName();
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
      set({
        connection: 'disconnected',
        bonded: false,
        dongleStatus: 'idle',
        deviceNameSupported: false,
        modifiers: { ...MODIFIERS_OFF },
      });
    },

    async forgetDevice() {
      try {
        await dongle?.forget();
      } finally {
        dongle = null;
        set({
          connection: 'disconnected',
          bonded: false,
          dongleStatus: 'idle',
          deviceName: null,
          deviceNameSupported: false,
        });
        await get().refreshGrantedDevices();
      }
    },

    async sendText(text) {
      if (!dongle || get().connection !== 'connected') {
        set({ error: 'Not connected to a dongle.' });
        return;
      }
      set({ error: null });
      await sendRaw(withArmedPrefix(encodeText(text)));
    },

    async sendEdit(prev, next) {
      const payload = encodeEdit(prev, next);
      if (payload.length === 0) return;
      await sendRaw(withArmedPrefix(payload));
    },

    async sendSpecialKey(key) {
      await sendRaw(withArmedPrefix(encodeSpecialKey(key)));
    },

    tapModifier(key) {
      const mods = get().modifiers;
      const cur = mods[key];

      if (cur === 'off') {
        // Arm for the next keystroke; nothing is sent until that key goes out.
        set({ modifiers: { ...mods, [key]: 'armed' } });
        return;
      }

      if (cur === 'armed') {
        // Lock: hold the full locked set (including this key) down.
        const next: Modifiers = { ...mods, [key]: 'locked' };
        set({ modifiers: next });
        void sendRaw(encodeModifierHold(lockedMask(next)));
        return;
      }

      // Locked → off: re-hold the remaining set, or release all.
      const next: Modifiers = { ...mods, [key]: 'off' };
      set({ modifiers: next });
      const mask = lockedMask(next);
      void sendRaw(mask === 0 ? encodeModifierRelease() : encodeModifierHold(mask));
    },

    releaseModifiers() {
      const hadLocked = lockedMask(get().modifiers) !== 0;
      set({ modifiers: { ...MODIFIERS_OFF } });
      if (hadLocked) void sendRaw(encodeModifierRelease());
    },

    sendMouse(buttons, dx, dy, wheel) {
      if (!dongle || get().connection !== 'connected') return;
      // High-rate path (up to ~50 pkt/s): no busy-badge churn, but send
      // errors still surface.
      dongle.send(encodeMouse(buttons, dx, dy, wheel)).catch(handleSendError);
    },

    async setDeviceName(name) {
      if (!dongle || get().connection !== 'connected') {
        set({ error: 'Not connected to a dongle.' });
        return false;
      }
      try {
        await dongle.writeDeviceName(name);
        set({ customName: name });
        persistCustomName(name);
        return true;
      } catch (e) {
        handleSendError(e);
        return false;
      }
    },

    async refreshDeviceName() {
      if (!dongle || get().connection !== 'connected') return;
      try {
        const name = await dongle.readDeviceName();
        // null → v2 firmware without the config characteristic.
        if (name === null) return;
        set({ customName: name });
        persistCustomName(name);
      } catch {
        /* best-effort prefill — a failed read is not worth an error banner */
      }
    },

    async sendSegment(payload) {
      if (!dongle || get().connection !== 'connected') return false;
      try {
        sendBegin();
        await dongle.send(payload);
        return true;
      } catch (e) {
        handleSendError(e);
        return false;
      } finally {
        sendEnd();
      }
    },

    clearError() {
      set({ error: null, pairingHint: false });
    },
  };
});
