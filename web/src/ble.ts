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
  NUS_RX_UUID,
  NUS_SERVICE_UUID,
  NUS_TX_UUID,
  chunkPayload,
  parseStatus,
} from './protocol';

export type StatusListener = (status: 'idle' | 'busy' | 'error') => void;
export type DisconnectListener = () => void;

/** Inter-write pacing: firmware types at ~15 ms/keystroke; 20 ms keeps us behind it. */
const WRITE_DELAY_MS = 20;

export class DongleConnection {
  private rx: BluetoothRemoteGATTCharacteristic | null = null;
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
    return navigator.bluetooth.requestDevice({
      filters: [
        { services: [NUS_SERVICE_UUID] },
        { namePrefix: ADVERTISED_NAME_PREFIX },
      ],
      optionalServices: [NUS_SERVICE_UUID],
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
  }

  private onDisconnect: DisconnectListener = () => {};
  private handleDisconnect = () => {
    // Stop listening: a DongleConnection is single-use, and a stale
    // listener on the same device would keep firing after a reconnect
    // swapped in a new instance.
    this.device.removeEventListener('gattserverdisconnected', this.handleDisconnect);
    this.rx = null;
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
