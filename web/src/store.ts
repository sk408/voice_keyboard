import { create } from 'zustand';
import { DongleConnection, describeBleError } from './ble';
import {
  MODIFIER_BITS,
  MOUSE_BUTTON_LEFT,
  encodeAbsolute,
  encodeEdit,
  encodeModifierState,
  encodeMouse,
  encodeSpecialKey,
  encodeText,
  type ModifierKey,
  type SpecialKey,
} from './protocol';
import {
  IDENTITY_MAP,
  loadCalibration,
  saveCalibration,
  type CalibrationMap,
} from './calibration';
import {
  deleteLandmark,
  loadLandmarks,
  saveLandmark,
  type Landmark,
} from './landmarks';
import {
  loadMacros,
  newMacroId,
  saveMacros,
  type Macro,
} from './macroStorage';

export type ConnectionState = 'disconnected' | 'connecting' | 'connected';
export type TypingMode = 'live' | 'compose';
export type DongleStatus = 'idle' | 'busy' | 'error';
/** One-finger trackpad behavior: tablet-style absolute or classic relative. */
export type OneFingerMode = 'absolute' | 'relative';

/** Sticky modifier state: off → armed (next key) → locked (held) → off. */
export type ModifierState = 'off' | 'armed' | 'locked';
export type Modifiers = Record<ModifierKey, ModifierState>;

const MODIFIERS_OFF: Modifiers = { ctrl: 'off', shift: 'off', alt: 'off', gui: 'off' };

const MODE_STORAGE_KEY = 'voicekb.mode';
const ONE_FINGER_STORAGE_KEY = 'voicekb.onefinger';

function loadMode(): TypingMode {
  try {
    return localStorage.getItem(MODE_STORAGE_KEY) === 'compose' ? 'compose' : 'live';
  } catch {
    return 'live';
  }
}

function loadOneFinger(): OneFingerMode {
  try {
    return localStorage.getItem(ONE_FINGER_STORAGE_KEY) === 'relative' ? 'relative' : 'absolute';
  } catch {
    return 'absolute';
  }
}

interface AppState {
  bleSupported: boolean;
  connection: ConnectionState;
  dongleStatus: DongleStatus;
  deviceName: string | null;
  /** Firmware version reported by the InputStick handshake (e.g. "1.1"). */
  firmwareVersion: string | null;
  error: string | null;
  mode: TypingMode;
  /** Devices already granted to this origin, for one-tap reconnect. */
  grantedDevices: BluetoothDevice[];
  /** Sticky/locked modifier state for the keyboard tab. */
  modifiers: Modifiers;
  /** Last absolute pointer position sent (normalized 0..32767 coords). */
  lastAbsolute: { x: number; y: number } | null;
  /** One-finger trackpad mode (persisted to localStorage). */
  defaultOneFinger: OneFingerMode;
  /** Calibration map for the current device (IDENTITY_MAP until calibrated). */
  calibration: CalibrationMap;
  /** Landmarks for the current device. */
  landmarks: Landmark[];

  /**
   * Macros are phone-local only (localStorage). Firmware v6 removed the
   * dongle-side macro store (and v5.14 had already dropped it), so there is
   * nothing to sync — running a macro just streams InputStick packets.
   */
  macros: Macro[];

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
  /** Cycle a modifier: off → armed → locked → off. */
  tapModifier(key: ModifierKey): void;
  /** Release all armed/locked modifiers. */
  releaseModifiers(): void;
  /** Mouse tab: one relative mouse packet. Fire-and-forget. */
  sendMouse(buttons: number, dx: number, dy: number, wheel: number): void;
  /** Mouse tab: one absolute pointer packet. Fire-and-forget; records lastAbsolute. */
  sendAbsolute(buttons: number, x: number, y: number): void;
  /** Persist the one-finger trackpad mode. */
  setDefaultOneFinger(mode: OneFingerMode): void;
  /** Key used for per-device persisted data (calibration, landmarks). */
  deviceKey(): string;
  /** Persist and activate a new calibration map for the current device. */
  setCalibration(map: CalibrationMap): void;
  /** Save the last-sent absolute position as a named landmark. False when no position known. */
  saveCurrentSpot(name: string): boolean;
  /** Teleport to a landmark (and optionally left-click at the spot). */
  goToLandmark(name: string, click?: boolean): void;
  removeLandmark(name: string): void;
  /**
   * Macro runner: send one pre-encoded segment (framed InputStick packets)
   * through the paced, flow-controlled send queue. Returns false when not
   * connected or the write failed.
   */
  sendSegment(payload: Uint8Array): Promise<boolean>;
  /** Macro manager: create (`editing` null) or update a macro. */
  saveMacroEdit(editing: Macro | null, name: string, template: string): void;
  /** Macro manager: delete a macro. */
  deleteMacro(macro: Macro): void;
  /** Macro manager: duplicate a macro. */
  duplicateMacro(macro: Macro): void;
  /** Macro manager: append imported macros. */
  importMacros(items: { name: string; template: string }[]): void;
  clearError(): void;
}

let dongle: DongleConnection | null = null;
/** Sends currently in flight; drives the optimistic "typing…" badge. */
let pendingSends = 0;

export const useAppStore = create<AppState>((set, get) => {
  function handleSendError(e: unknown): void {
    const { message } = describeBleError(e);
    set({ error: message });
  }

  /**
   * Optimistic "typing…" badge: flips busy as soon as a send is queued
   * and back to idle once every queued send has completed. Firmware 0x2F
   * status notifications keep driving the badge too, but this way a dead
   * notify path is distinguishable from a dead write path.
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
   * Consume the armed (one-shot) modifiers: returns the mask to OR into the
   * next keystroke's press report and flips them back to off. Armed
   * modifiers never reach the dongle on their own — they ride the press
   * report of the key they modify.
   */
  function consumeArmed(): number {
    const mods = get().modifiers;
    let mask = 0;
    for (const key of Object.keys(MODIFIER_BITS) as ModifierKey[]) {
      if (mods[key] === 'armed') mask |= MODIFIER_BITS[key];
    }
    if (mask === 0) return 0;
    const next = { ...mods };
    for (const key of Object.keys(MODIFIER_BITS) as ModifierKey[]) {
      if (next[key] === 'armed') next[key] = 'off';
    }
    set({ modifiers: next });
    return mask;
  }

  /** Load per-device persisted state (calibration, landmarks) into the store. */
  function loadDeviceState(): void {
    const key = get().deviceKey();
    set({
      calibration: loadCalibration(key) ?? IDENTITY_MAP,
      landmarks: loadLandmarks(key),
    });
  }

  return {
    bleSupported: DongleConnection.isSupported(),
    connection: 'disconnected',
    dongleStatus: 'idle',
    deviceName: null,
    firmwareVersion: null,
    error: null,
    mode: loadMode(),
    grantedDevices: [],
    modifiers: { ...MODIFIERS_OFF },
    lastAbsolute: null,
    defaultOneFinger: loadOneFinger(),
    calibration: loadCalibration('default') ?? IDENTITY_MAP,
    landmarks: loadLandmarks('default'),
    macros: loadMacros(),

    setMode(mode) {
      set({ mode });
      try {
        localStorage.setItem(MODE_STORAGE_KEY, mode);
      } catch {
        /* storage unavailable — non-fatal */
      }
    },

    setDefaultOneFinger(mode) {
      set({ defaultOneFinger: mode });
      try {
        localStorage.setItem(ONE_FINGER_STORAGE_KEY, mode);
      } catch {
        /* storage unavailable — non-fatal */
      }
    },

    deviceKey() {
      return get().deviceName ?? 'default';
    },

    async refreshGrantedDevices() {
      const devices = await DongleConnection.getGrantedDevices();
      set({ grantedDevices: devices });
    },

    async connectViaChooser() {
      set({ error: null });
      let device: BluetoothDevice;
      try {
        device = await DongleConnection.requestDevice();
      } catch (e) {
        const { message } = describeBleError(e);
        set({ error: message });
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
        deviceName: device.name ?? 'InputStick dongle',
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
              dongleStatus: 'idle',
              firmwareVersion: null,
              // The dongle drops held modifiers on disconnect; mirror that.
              modifiers: { ...MODIFIERS_OFF },
            });
          },
        );
        dongle = conn;
        set({
          connection: 'connected',
          dongleStatus: 'idle',
          firmwareVersion: conn.firmwareVersion,
        });
        loadDeviceState();
      } catch (e) {
        const { message } = describeBleError(e);
        set({ connection: 'disconnected', error: message });
      }
    },

    disconnect() {
      dongle?.disconnect();
      dongle = null;
      set({
        connection: 'disconnected',
        dongleStatus: 'idle',
        firmwareVersion: null,
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
          dongleStatus: 'idle',
          deviceName: null,
          firmwareVersion: null,
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
      const locked = lockedMask(get().modifiers);
      await sendRaw(encodeText(text, locked | consumeArmed(), locked));
    },

    async sendEdit(prev, next) {
      const locked = lockedMask(get().modifiers);
      const payload = encodeEdit(prev, next, locked | consumeArmed(), locked);
      if (payload.length === 0) return;
      await sendRaw(payload);
    },

    async sendSpecialKey(key) {
      const locked = lockedMask(get().modifiers);
      await sendRaw(encodeSpecialKey(key, locked | consumeArmed(), locked));
    },

    tapModifier(key) {
      const mods = get().modifiers;
      const cur = mods[key];

      if (cur === 'off') {
        // Arm for the next keystroke; nothing is sent until that key goes out.
        set({ modifiers: { ...mods, [key]: 'armed' } });
        return;
      }

      // Locked modifiers are a held keyboard state on the dongle: send a
      // [mask, 0] report with the new held set (empty set = release all).
      const next: Modifiers = { ...mods, [key]: cur === 'armed' ? 'locked' : 'off' };
      set({ modifiers: next });
      void sendRaw(encodeModifierState(lockedMask(next)));
    },

    releaseModifiers() {
      const hadLocked = lockedMask(get().modifiers) !== 0;
      set({ modifiers: { ...MODIFIERS_OFF } });
      if (hadLocked) void sendRaw(encodeModifierState(0));
    },

    sendMouse(buttons, dx, dy, wheel) {
      if (!dongle || get().connection !== 'connected') return;
      // High-rate path (up to ~50 pkt/s): no busy-badge churn, but send
      // errors still surface.
      dongle.send(encodeMouse(buttons, dx, dy, wheel)).catch(handleSendError);
    },

    sendAbsolute(buttons, x, y) {
      if (!dongle || get().connection !== 'connected') return;
      // Same high-rate fire-and-forget path as sendMouse; every call also
      // records the last known cursor position (for "save current spot" and
      // the calibration wizard's corner samples).
      set({ lastAbsolute: { x, y } });
      dongle.send(encodeAbsolute(buttons, x, y)).catch(handleSendError);
    },

    setCalibration(map) {
      saveCalibration(get().deviceKey(), map);
      set({ calibration: map });
    },

    saveCurrentSpot(name) {
      const spot = get().lastAbsolute;
      const trimmed = name.trim();
      if (!spot || !trimmed) return false;
      set({
        landmarks: saveLandmark(get().deviceKey(), { name: trimmed, x: spot.x, y: spot.y }),
      });
      return true;
    },

    goToLandmark(name, click = false) {
      const lm = get().landmarks.find((l) => l.name === name);
      if (!lm) return;
      get().sendAbsolute(0, lm.x, lm.y);
      if (click) {
        get().sendAbsolute(MOUSE_BUTTON_LEFT, lm.x, lm.y);
        window.setTimeout(() => get().sendAbsolute(0, lm.x, lm.y), 60);
      }
    },

    removeLandmark(name) {
      set({ landmarks: deleteLandmark(get().deviceKey(), name) });
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
      set({ error: null });
    },

    saveMacroEdit(editing, name, template) {
      const macros = get().macros;
      const next = editing
        ? macros.map((m) => (m.id === editing.id ? { ...m, name, template } : m))
        : [...macros, { id: newMacroId(), name, template }];
      saveMacros(next);
      set({ macros: next });
    },

    deleteMacro(macro) {
      const next = get().macros.filter((m) => m.id !== macro.id);
      saveMacros(next);
      set({ macros: next });
    },

    duplicateMacro(macro) {
      const next = [
        ...get().macros,
        { id: newMacroId(), name: `${macro.name} (copy)`, template: macro.template },
      ];
      saveMacros(next);
      set({ macros: next });
    },

    importMacros(items) {
      const next = [
        ...get().macros,
        ...items.map((m) => ({ id: newMacroId(), name: m.name, template: m.template })),
      ];
      saveMacros(next);
      set({ macros: next });
    },
  };
});
