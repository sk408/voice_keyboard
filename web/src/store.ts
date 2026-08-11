import { create } from 'zustand';
import { DEVICE_NAME_STORAGE_KEY, DongleConnection, describeBleError } from './ble';
import {
  MODIFIER_BITS,
  MOUSE_BUTTON_LEFT,
  encodeAbsolute,
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
  addTombstone,
  loadMacros,
  loadTombstones,
  newMacroId,
  saveMacros,
  saveTombstones,
  type Macro,
} from './macroStorage';
import {
  bytesToTemplate,
  compiledLength,
  encodeDelete,
  fetchMacroBytes,
  macroFootprint,
  parseMacroList,
  planCopy,
  pushMacro,
  storageUsed,
  type MacroListEntry,
  type MacroStoreIO,
} from './macroSync';
import { encodeMacro } from './macros';

export type ConnectionState = 'disconnected' | 'connecting' | 'connected';
export type TypingMode = 'live' | 'compose';
export type DongleStatus = 'idle' | 'busy' | 'error';
/** One-finger trackpad behavior (v4): tablet-style absolute or classic relative. */
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
  /** Last absolute pointer position sent (normalized 0..32767 coords). */
  lastAbsolute: { x: number; y: number } | null;
  /** One-finger trackpad mode (persisted to localStorage). */
  defaultOneFinger: OneFingerMode;
  /** Calibration map for the current device (IDENTITY_MAP until calibrated). */
  calibration: CalibrationMap;
  /** Landmarks for the current device. */
  landmarks: Landmark[];

  /**
   * Macro list shown in the manager. With a v5 dongle connected this mirrors
   * the dongle store (source of truth) plus local drafts; offline it is the
   * localStorage cache. A macro with `slot` set lives on the dongle.
   */
  macros: Macro[];
  /** True when the connected dongle exposes the v5 macro store. */
  macroStoreSupported: boolean;
  /** A sync with the dongle macro store is in flight. */
  macroSyncing: boolean;
  /** Dongle store usage in bytes, from the last MACRO_LIST snapshot. */
  macroStorageUsed: number;
  /** Dongle store is empty but this phone has macros → offer one-tap copy. */
  migrationAvailable: boolean;
  /** Transient result/notice line for macro sync operations. */
  macroNotice: string | null;

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
  /** Mouse tab: one absolute pointer packet (0x91). Fire-and-forget; records lastAbsolute. */
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
  /** Macro manager: create (`editing` null) or update a macro; syncs to the dongle when possible. */
  saveMacroEdit(editing: Macro | null, name: string, template: string): void;
  /** Macro manager: delete a macro (locally and, when possible, on the dongle). */
  deleteMacro(macro: Macro): void;
  /** Macro manager: duplicate a macro as a local draft. */
  duplicateMacro(macro: Macro): void;
  /** Macro manager: append imported macros as local drafts. */
  importMacros(items: { name: string; template: string }[]): void;
  /** Migration banner: copy local macros to an empty dongle store. */
  copyMacrosToDongle(): Promise<void>;
  /** Choose the standalone "button macro" (dongle slot 0, long-press trigger). Online only. */
  makeButtonMacro(macro: Macro): void;
  dismissMacroNotice(): void;
  clearError(): void;
}

let dongle: DongleConnection | null = null;
/** Sends currently in flight; drives the optimistic "typing…" badge. */
let pendingSends = 0;
/**
 * Guards so a MACRO_LIST notification firing mid-sync (the dongle notifies
 * on every store change, including our own writes) cannot overlap syncs.
 */
let macroSyncInProgress = false;
let macroResyncNeeded = false;

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

  /** Load per-device persisted state (calibration, landmarks) into the store. */
  function loadDeviceState(): void {
    const key = get().deviceKey();
    set({
      calibration: loadCalibration(key) ?? IDENTITY_MAP,
      landmarks: loadLandmarks(key),
    });
  }

  /* --- v5 macro store sync (dongle is the source of truth) --- */

  /** IO shim handed to the pure transfer helpers in macroSync.ts. */
  function macroIo(conn: DongleConnection): MacroStoreIO {
    return {
      write: (payload) => conn.macroStoreWrite(payload),
      read: () => conn.macroStoreRead(),
      getRoundtrip: (payload) => conn.macroStoreGetRoundtrip(payload),
    };
  }

  /** True when macro store ops can run right now. */
  function macroStoreOnline(): boolean {
    return (
      dongle !== null &&
      dongle.supportsMacroStore &&
      get().connection === 'connected' &&
      get().macroStoreSupported
    );
  }

  /** Persist the macro list to the localStorage read-through cache. */
  function cacheMacros(macros: Macro[]): void {
    saveMacros(macros);
    set({ macros });
  }

  /**
   * Push every slotless macro (local draft) into the dongle store, first-fit
   * by free slot, respecting the 16-slot / 16 KB limits. Returns the updated
   * store usage; drafts that don't fit (or whose write fails) stay slotless.
   */
  async function pushDrafts(
    conn: DongleConnection,
    existing: MacroListEntry[],
    drafts: Macro[],
  ): Promise<{ pushed: Macro[]; failed: Macro[]; used: number }> {
    const io = macroIo(conn);
    const candidates = drafts.map((d) => ({
      name: d.name,
      templateByteLen: compiledLength(d.template),
    }));
    const plan = planCopy(candidates, existing);
    const pushed: Macro[] = [];
    const failed: Macro[] = [];
    let used = storageUsed(existing);
    for (const { candidate, slot } of plan.placements) {
      const draft = drafts[candidate];
      try {
        await pushMacro(io, slot, draft.name, encodeMacro(draft.template));
        used += macroFootprint(draft.name, candidates[candidate].templateByteLen);
        pushed.push({ ...draft, slot });
      } catch {
        failed.push(draft);
      }
    }
    for (const skipped of plan.skipped) failed.push(drafts[skipped]);
    return { pushed, failed, used };
  }

  /**
   * Full sync on connect: apply offline-delete tombstones, detect the
   * migration case (empty dongle + never-synced locals → banner instead of
   * auto-copy), merge dongle state into the UI list (dongle wins), and push
   * offline drafts into free slots.
   */
  async function syncMacroStore(conn: DongleConnection): Promise<void> {
    if (!conn.supportsMacroStore) return;
    macroSyncInProgress = true;
    set({ macroSyncing: true });
    try {
      const io = macroIo(conn);

      // 1. Offline deletions/edits recorded as tombstones → del ops first.
      const tombstones = loadTombstones();
      if (tombstones.length > 0) {
        const entries = parseMacroList((await conn.readMacroList()) ?? '[]');
        for (const t of tombstones) {
          const hit = entries.find((e) => e.name === t.name && e.len === t.len);
          if (hit) await conn.macroStoreWrite(encodeDelete(hit.i));
        }
        saveTombstones([]);
      }

      // 2. Snapshot the store.
      const entries = parseMacroList((await conn.readMacroList()) ?? '[]');
      const locals = get().macros;

      // 3. Migration: v3/v4 user meeting a v5 dongle for the first time.
      //    Don't auto-copy — surface the one-tap banner instead.
      if (entries.length === 0 && locals.length > 0 && locals.every((m) => m.slot === undefined)) {
        set({ migrationAvailable: true, macroStorageUsed: 0 });
        return;
      }
      set({ migrationAvailable: false });

      // 4. Merge dongle macros (dongle wins). Skip the fetch when the cached
      //    macro's signature (name + compiled length) still matches — that
      //    also preserves the original template text ({{fields}}, {click}
      //    landmarks) which the stored byte stream cannot represent.
      const merged: Macro[] = [];
      const matched = new Set<string>();
      for (const e of entries) {
        const local = locals.find((m) => m.slot === e.i && !matched.has(m.id));
        if (local && local.name === e.name && compiledLength(local.template) === e.len) {
          matched.add(local.id);
          merged.push(local);
          continue;
        }
        const template = bytesToTemplate(await fetchMacroBytes(io, e.i));
        if (local) {
          matched.add(local.id);
          merged.push({ ...local, name: e.name, template, slot: e.i });
        } else {
          merged.push({ id: newMacroId(), name: e.name, template, slot: e.i });
        }
      }

      // 5. Everything else local is a draft → push into free slots.
      const drafts = locals.filter((m) => !matched.has(m.id)).map((m) => ({ ...m, slot: undefined }));
      const { pushed, failed, used } = await pushDrafts(conn, entries, drafts);

      cacheMacros([...merged, ...pushed, ...failed]);
      set({
        macroStorageUsed: used,
        macroNotice:
          failed.length > 0
            ? `${failed.length} macro(s) didn't fit on the dongle — kept on this phone only.`
            : null,
      });
    } catch (e) {
      // A sync failure must not break the connection; the cache stays valid.
      set({ error: describeBleError(e).message });
    } finally {
      macroSyncInProgress = false;
      set({ macroSyncing: false });
      if (macroResyncNeeded) {
        // Something asked for a sync while this one ran — do a full pass
        // (a read-only refresh could miss drafts waiting to be pushed).
        macroResyncNeeded = false;
        const current = dongle;
        if (current?.supportsMacroStore) void syncMacroStore(current);
      }
    }
  }

  /**
   * Ask for a full sync after a local change (new/edited/duplicated/imported
   * drafts). No-op offline — drafts wait for the next connect. Overlapping
   * requests collapse into one follow-up sync.
   */
  function requestMacroSync(): void {
    if (!macroStoreOnline()) return;
    if (macroSyncInProgress) {
      macroResyncNeeded = true;
      return;
    }
    void syncMacroStore(dongle!);
  }

  /**
   * Notification-driven refresh (MACRO_LIST fires on every store change).
   * Read-only: re-fetches only slots whose signature changed, marks macros
   * whose slot vanished as drafts. Never pushes — that's connect-time work.
   */
  async function refreshMacroStore(): Promise<void> {
    const conn = dongle;
    if (!conn || !conn.supportsMacroStore) return;
    if (macroSyncInProgress) {
      macroResyncNeeded = true;
      return;
    }
    macroSyncInProgress = true;
    try {
      const io = macroIo(conn);
      const entries = parseMacroList((await conn.readMacroList()) ?? '[]');
      const locals = get().macros;
      const next: Macro[] = [];
      const matched = new Set<string>();
      for (const e of entries) {
        const local = locals.find((m) => m.slot === e.i && !matched.has(m.id));
        if (local && local.name === e.name && compiledLength(local.template) === e.len) {
          matched.add(local.id);
          next.push(local);
          continue;
        }
        const template = bytesToTemplate(await fetchMacroBytes(io, e.i));
        if (local) {
          matched.add(local.id);
          next.push({ ...local, name: e.name, template, slot: e.i });
        } else {
          next.push({ id: newMacroId(), name: e.name, template, slot: e.i });
        }
      }
      // Unmatched locals: drafts stay drafts; a macro whose dongle slot
      // vanished reverts to a draft (re-pushed on next connect).
      for (const m of locals) {
        if (!matched.has(m.id)) next.push({ ...m, slot: undefined });
      }
      cacheMacros(next);
      set({ macroStorageUsed: storageUsed(entries), migrationAvailable: false });
    } catch {
      /* best-effort refresh — the next connect re-syncs fully */
    } finally {
      macroSyncInProgress = false;
    }
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

  const initialCustomName = loadCustomName();
  const initialDeviceKey = initialCustomName ?? 'default';

  return {
    bleSupported: DongleConnection.isSupported(),
    connection: 'disconnected',
    bonded: false,
    dongleStatus: 'idle',
    deviceName: null,
    customName: initialCustomName,
    deviceNameSupported: false,
    error: null,
    pairingHint: false,
    mode: loadMode(),
    grantedDevices: [],
    modifiers: { ...MODIFIERS_OFF },
    lastAbsolute: null,
    defaultOneFinger: loadOneFinger(),
    calibration: loadCalibration(initialDeviceKey) ?? IDENTITY_MAP,
    landmarks: loadLandmarks(initialDeviceKey),
    macros: loadMacros(),
    macroStoreSupported: false,
    macroSyncing: false,
    macroStorageUsed: 0,
    migrationAvailable: false,
    macroNotice: null,

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
      return get().customName ?? get().deviceName ?? 'default';
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
              macroStoreSupported: false,
              macroSyncing: false,
              migrationAvailable: false,
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
          macroStoreSupported: conn.supportsMacroStore,
        });
        loadDeviceState();
        void get().refreshDeviceName();
        if (conn.supportsMacroStore) {
          // v5: the dongle owns the macro store. Sync now and re-sync
          // (read-only) whenever MACRO_LIST notifies.
          void conn
            .subscribeMacroList(() => {
              if (dongle === conn) void refreshMacroStore();
            })
            .catch(() => {
              /* notifications are a convenience; the connect-time sync stands */
            });
          void syncMacroStore(conn);
        }
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
        macroStoreSupported: false,
        macroSyncing: false,
        migrationAvailable: false,
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
        const prevKey = get().deviceKey();
        set({ customName: name });
        persistCustomName(name);
        // The device key follows the dongle's name — reload per-device state
        // when the read changes which key we're under.
        if (get().deviceKey() !== prevKey) loadDeviceState();
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

    saveMacroEdit(editing, name, template) {
      const macros = get().macros;
      if (editing && editing.slot !== undefined) {
        // The macro lives on the dongle. Tombstone the stale dongle copy so
        // the next sync deletes it; it is either rewritten in place (online)
        // or re-pushed as a draft (offline / failed write).
        const tombstone = { name: editing.name, len: compiledLength(editing.template) };
        const conn = dongle;
        if (conn && macroStoreOnline()) {
          cacheMacros(macros.map((m) => (m.id === editing.id ? { ...m, name, template } : m)));
          const slot = editing.slot;
          void (async () => {
            try {
              // A put to an existing slot overwrites it in place.
              await pushMacro(macroIo(conn), slot, name, encodeMacro(template));
            } catch {
              addTombstone(tombstone);
              cacheMacros(
                get().macros.map((m) => (m.id === editing.id ? { ...m, slot: undefined } : m)),
              );
              set({
                macroNotice: `"${name}" could not be written to the dongle — kept on this phone.`,
              });
              return;
            }
            await refreshMacroStore();
          })();
          return;
        }
        addTombstone(tombstone);
        cacheMacros(
          macros.map((m) => (m.id === editing.id ? { ...m, name, template, slot: undefined } : m)),
        );
        return;
      }
      if (editing) {
        cacheMacros(macros.map((m) => (m.id === editing.id ? { ...m, name, template } : m)));
      } else {
        cacheMacros([...macros, { id: newMacroId(), name, template }]);
      }
      requestMacroSync();
    },

    deleteMacro(macro) {
      cacheMacros(get().macros.filter((m) => m.id !== macro.id));
      if (macro.slot === undefined) return; // local draft — nothing on the dongle
      const tombstone = { name: macro.name, len: compiledLength(macro.template) };
      const conn = dongle;
      if (!conn || !macroStoreOnline()) {
        addTombstone(tombstone);
        return;
      }
      const slot = macro.slot;
      void (async () => {
        try {
          await conn.macroStoreWrite(encodeDelete(slot));
        } catch {
          addTombstone(tombstone); // retry through the next connect-time sync
          return;
        }
        await refreshMacroStore();
      })();
    },

    duplicateMacro(macro) {
      cacheMacros([
        ...get().macros,
        { id: newMacroId(), name: `${macro.name} (copy)`, template: macro.template },
      ]);
      requestMacroSync();
    },

    importMacros(items) {
      cacheMacros([
        ...get().macros,
        ...items.map((m) => ({ id: newMacroId(), name: m.name, template: m.template })),
      ]);
      requestMacroSync();
    },

    async copyMacrosToDongle() {
      const conn = dongle;
      if (!conn || !macroStoreOnline()) return;
      set({ migrationAvailable: false, macroSyncing: true });
      try {
        const entries = parseMacroList((await conn.readMacroList()) ?? '[]');
        const drafts = get().macros.filter((m) => m.slot === undefined);
        const { pushed, failed } = await pushDrafts(conn, entries, drafts);
        // Reflect the assigned slots before refreshing, so the refresh
        // matches pushed macros instead of duplicating them.
        cacheMacros([...get().macros.filter((m) => m.slot !== undefined), ...pushed, ...failed]);
        await refreshMacroStore();
        set({
          macroNotice:
            failed.length > 0
              ? `${failed.length} macro(s) didn't fit on the dongle — kept on this phone only.`
              : 'Macros copied to the dongle.',
        });
      } catch (e) {
        set({ error: describeBleError(e).message });
      } finally {
        set({ macroSyncing: false });
      }
    },

    makeButtonMacro(macro) {
      const conn = dongle;
      if (!conn || !macroStoreOnline()) {
        set({ macroNotice: 'Connect to the dongle to choose the button macro.' });
        return;
      }
      if (macro.slot === 0) return;
      // Slot 0 is a plain store slot: write this macro there, free its old
      // slot, and demote the previous slot-0 macro to a draft (the follow-up
      // sync pushes it into a free slot).
      const oldSlot = macro.slot;
      cacheMacros(
        get().macros.map((m) => {
          if (m.id === macro.id) return { ...m, slot: 0 };
          if (m.slot === 0) return { ...m, slot: undefined };
          return m;
        }),
      );
      void (async () => {
        try {
          await pushMacro(macroIo(conn), 0, macro.name, encodeMacro(macro.template));
          if (oldSlot !== undefined) {
            await conn.macroStoreWrite(encodeDelete(oldSlot));
          }
          await refreshMacroStore();
          requestMacroSync();
        } catch (e) {
          set({ error: describeBleError(e).message });
        }
      })();
    },

    dismissMacroNotice() {
      set({ macroNotice: null });
    },
  };
});
