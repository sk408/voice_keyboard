/**
 * Web Bluetooth layer for the Voice Keyboard dongle.
 *
 * Wraps NUS (Nordic UART Service): RX for keystroke payloads, TX for
 * status notifications. All sends go through a serialized queue so
 * back-to-back writes never overlap on the GATT link, and payloads are
 * chunked to the 20-byte ATT floor (see protocol.ts).
 *
 * Bonding: the firmware requires an encrypted link for RX writes. On
 * Android Chrome the pairing flow is triggered implicitly by the first
 * GATT operation that needs encryption — the first RX write (the TX
 * subscription's CCC uses plain permissions). Auth failures surface as DOMExceptions whose message mentions pairing/authentication
 * or as `SecurityError` / `NotAllowedError` — the store maps those to a
 * "press the dongle button" hint.
 */
import {
  ADVERTISED_NAME_PREFIX,
  CONFIG_CHAR_UUID,
  NUS_RX_UUID,
  NUS_SERVICE_UUID,
  NUS_TX_UUID,
  chunkPayload,
  parseStatus,
} from './protocol';
import { MACRO_LIST_UUID, MACRO_RW_UUID } from './macroSync';

export type StatusListener = (status: 'idle' | 'busy' | 'error') => void;
export type DisconnectListener = () => void;

/** Inter-write pacing: firmware types at ~15 ms/keystroke; 20 ms keeps us behind it. */
const WRITE_DELAY_MS = 20;

/** localStorage key for the user-set dongle advertising name (also read by requestDevice). */
export const DEVICE_NAME_STORAGE_KEY = 'voicekb.deviceName';

/** Device-name rule shared with firmware: 1–20 printable ASCII chars. */
const DEVICE_NAME_RE = /^[\x20-\x7e]{1,20}$/;

export class DongleConnection {
  private rx: BluetoothRemoteGATTCharacteristic | null = null;
  /** v3 config characteristic (device name); null on v2 firmware. */
  private config: BluetoothRemoteGATTCharacteristic | null = null;
  /** v5 macro store characteristics; null on pre-v5 firmware. */
  private macroList: BluetoothRemoteGATTCharacteristic | null = null;
  private macroRw: BluetoothRemoteGATTCharacteristic | null = null;
  private macroListListener: ((event: Event) => void) | null = null;
  /** Serializes MACRO_RW write+read pairs so chunked gets never interleave. */
  private macroQueue: Promise<void> = Promise.resolve();
  private queue: Promise<void> = Promise.resolve();

  private constructor(private device: BluetoothDevice) {}

  /** True when the browser supports Web Bluetooth at all. */
  static isSupported(): boolean {
    return typeof navigator !== 'undefined' && 'bluetooth' in navigator;
  }

  /** Devices the user has already granted to this origin (survives reloads). */
  static async getGrantedDevices(): Promise<BluetoothDevice[]> {
    if (!DongleConnection.isSupported() || !navigator.bluetooth.getDevices) return [];
    try {
      return await navigator.bluetooth.getDevices();
    } catch {
      return [];
    }
  }

  /** Connect to a granted device and set up NUS. First connect may trigger pairing. */
  static async connect(
    device: BluetoothDevice,
    onStatus: StatusListener,
    onDisconnect: DisconnectListener,
  ): Promise<DongleConnection> {
    const conn = new DongleConnection(device);
    await conn.connect(onStatus, onDisconnect);
    return conn;
  }

  /** Show the browser chooser, filtered to the NUS service. */
  static async requestDevice(): Promise<BluetoothDevice> {
    const filters: BluetoothLEScanFilter[] = [{ services: [NUS_SERVICE_UUID] }];
    // A renamed dongle no longer advertises as "VoiceKB…" — match the
    // stored custom name too. The services filter above stays primary.
    let customName: string | null = null;
    try {
      customName = localStorage.getItem(DEVICE_NAME_STORAGE_KEY);
    } catch {
      /* storage unavailable — non-fatal */
    }
    if (customName) filters.push({ namePrefix: customName });
    filters.push({ namePrefix: ADVERTISED_NAME_PREFIX });
    return navigator.bluetooth.requestDevice({
      filters,
      optionalServices: [NUS_SERVICE_UUID, CONFIG_CHAR_UUID, MACRO_LIST_UUID, MACRO_RW_UUID],
    });
  }

  /** Remove a stale grant/bond so the user can re-pair from scratch. */
  async forget(): Promise<void> {
    this.disconnect();
    if (this.device.forget) await this.device.forget();
  }

  get name(): string {
    return this.device.name ?? 'VoiceKB dongle';
  }

  get id(): string {
    return this.device.id;
  }

  get connected(): boolean {
    return this.device.gatt?.connected ?? false;
  }

  async connect(
    onStatus: StatusListener,
    onDisconnect: DisconnectListener,
  ): Promise<void> {
    if (!this.device.gatt) throw new Error('GATT not available on this device');

    this.device.addEventListener('gattserverdisconnected', this.handleDisconnect);
    this.onDisconnect = onDisconnect;

    const server = await this.device.gatt.connect();
    const service = await server.getPrimaryService(NUS_SERVICE_UUID);
    this.rx = await service.getCharacteristic(NUS_RX_UUID);

    // Subscribe to TX status. Note the firmware's CCC uses plain
    // permissions, so this does NOT require encryption: the first
    // encrypted GATT operation is the first RX write, which is what
    // kicks off Just Works pairing on Android.
    const tx = await service.getCharacteristic(NUS_TX_UUID);
    await tx.startNotifications();
    tx.addEventListener('characteristicvaluechanged', (event) => {
      const value = (event.target as BluetoothRemoteGATTCharacteristic).value;
      if (value && value.byteLength > 0) onStatus(parseStatus(value));
    });

    // v3 config characteristic (device name). v2 dongles don't have it —
    // tolerate the absence and leave config null.
    try {
      this.config = await service.getCharacteristic(CONFIG_CHAR_UUID);
    } catch {
      this.config = null;
    }

    // v5 macro store characteristics. Pre-v5 dongles don't have them —
    // tolerate the absence; the app then falls back to localStorage macros.
    try {
      this.macroList = await service.getCharacteristic(MACRO_LIST_UUID);
      this.macroRw = await service.getCharacteristic(MACRO_RW_UUID);
    } catch {
      this.macroList = null;
      this.macroRw = null;
    }
  }

  /** True when the connected firmware exposes the v3 config characteristic. */
  get supportsDeviceName(): boolean {
    return this.config !== null;
  }

  /** Current dongle advertising name, or null when unsupported (v2 firmware). */
  async readDeviceName(): Promise<string | null> {
    if (!this.config || !this.connected) return null;
    const value = await this.config.readValue();
    return new TextDecoder().decode(value);
  }

  /** Persist a new advertising name (1–20 printable ASCII chars). */
  async writeDeviceName(name: string): Promise<void> {
    if (!this.config || !this.connected) {
      throw new Error('This dongle does not support renaming (older firmware).');
    }
    if (!DEVICE_NAME_RE.test(name)) {
      throw new Error('Name must be 1–20 printable ASCII characters.');
    }
    // Fresh copy typed against ArrayBuffer (TS 5.7+ BufferSource generics).
    await this.config.writeValueWithResponse(new Uint8Array(new TextEncoder().encode(name)));
  }

  /** True when the connected firmware exposes the v5 macro store. */
  get supportsMacroStore(): boolean {
    return this.macroList !== null && this.macroRw !== null;
  }

  /** Raw MACRO_LIST value (JSON text). Null when unsupported/disconnected. */
  async readMacroList(): Promise<string | null> {
    if (!this.macroList || !this.connected) return null;
    const value = await this.macroList.readValue();
    return new TextDecoder().decode(value);
  }

  /**
   * Subscribe to MACRO_LIST notifications (fired by the dongle on every
   * store change). One listener at a time; a new subscription replaces the
   * old. No-op on pre-v5 firmware.
   */
  async subscribeMacroList(listener: () => void): Promise<void> {
    if (!this.macroList || !this.connected) return;
    if (this.macroListListener) {
      this.macroList.removeEventListener('characteristicvaluechanged', this.macroListListener);
    }
    this.macroListListener = () => listener();
    this.macroList.addEventListener('characteristicvaluechanged', this.macroListListener);
    await this.macroList.startNotifications();
  }

  /**
   * Write one MACRO_RW payload (put/del). Serialized through the macro queue
   * so it never interleaves with another macro operation.
   */
  macroStoreWrite(payload: Uint8Array): Promise<void> {
    return this.macroEnqueue(async () => {
      if (!this.macroRw || !this.connected) throw new Error('Dongle is not connected');
      await this.macroRw.writeValueWithResponse(new Uint8Array(payload));
    });
  }

  /** Read one MACRO_RW response chunk (JSON text) after a get request. */
  macroStoreRead(): Promise<string> {
    return this.macroEnqueue(async () => {
      if (!this.macroRw || !this.connected) throw new Error('Dongle is not connected');
      const value = await this.macroRw.readValue();
      return new TextDecoder().decode(value);
    });
  }

  /**
   * Atomic get round-trip: write the get request and read its response as a
   * single queued unit. A chunked get must use this rather than separate
   * write/read calls — those are independent queue entries, and another
   * macro write enqueued between them would consume the pending get state.
   */
  macroStoreGetRoundtrip(payload: Uint8Array): Promise<string> {
    return this.macroEnqueue(async () => {
      if (!this.macroRw || !this.connected) throw new Error('Dongle is not connected');
      await this.macroRw.writeValueWithResponse(new Uint8Array(payload));
      const value = await this.macroRw.readValue();
      return new TextDecoder().decode(value);
    });
  }

  private macroEnqueue<T>(op: () => Promise<T>): Promise<T> {
    const run = this.macroQueue.then(op);
    this.macroQueue = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  private onDisconnect: DisconnectListener = () => {};
  private handleDisconnect = () => {
    // Stop listening: a DongleConnection is single-use, and a stale
    // listener on the same device would keep firing after a reconnect
    // swapped in a new instance.
    this.device.removeEventListener('gattserverdisconnected', this.handleDisconnect);
    this.rx = null;
    this.config = null;
    this.macroList = null;
    this.macroRw = null;
    this.macroListListener = null;
    this.onDisconnect();
  };

  disconnect(): void {
    if (this.device.gatt?.connected) this.device.gatt.disconnect();
  }

  /**
   * Queue a payload for sending. Writes are serialized and paced; each
   * chunk goes out with a response so we get flow control for free.
   */
  send(data: Uint8Array): Promise<void> {
    if (data.length === 0) return Promise.resolve();
    const run = this.queue.then(() => this.writeAll(data));
    // Keep the queue alive even if a write fails; the failure still
    // propagates to this caller.
    this.queue = run.catch(() => {});
    return run;
  }

  private async writeAll(data: Uint8Array): Promise<void> {
    if (!this.rx || !this.connected) throw new Error('Dongle is not connected');
    for (const chunk of chunkPayload(data)) {
      // Fresh copy typed against ArrayBuffer (TS 5.7+ BufferSource generics).
      const payload = new Uint8Array(chunk);
      if (this.rx.properties.writeWithoutResponse) {
        await this.rx.writeValueWithoutResponse(payload);
      } else {
        await this.rx.writeValueWithResponse(payload);
      }
      await new Promise((resolve) => setTimeout(resolve, WRITE_DELAY_MS));
    }
  }
}

/** Classify connect/write failures for the status UI. */
export function describeBleError(error: unknown): { message: string; pairingHint: boolean } {
  if (error instanceof DOMException) {
    if (error.name === 'NotFoundError') {
      return {
        message: 'No dongle selected (or none found). Make sure the dongle is plugged in and advertising.',
        pairingHint: false,
      };
    }
    if (
      error.name === 'SecurityError' ||
      error.name === 'NotAllowedError' ||
      /pair|auth|bond|encrypt|permission/i.test(error.message)
    ) {
      return {
        message: `Pairing failed or was rejected (${error.message || error.name}).`,
        pairingHint: true,
      };
    }
    if (error.name === 'NetworkError') {
      return {
        message: 'Connection lost or could not be established. Move the phone closer to the dongle and retry.',
        pairingHint: false,
      };
    }
    return { message: `${error.name}: ${error.message}`, pairingHint: false };
  }
  return { message: error instanceof Error ? error.message : String(error), pairingHint: false };
}
