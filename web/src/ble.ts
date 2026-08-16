/**
 * Web Bluetooth layer for the Voice Keyboard dongle (firmware v6+).
 *
 * Transport is still the Nordic UART Service (RX = phone→dongle writes,
 * TX = dongle→phone notifications), but the byte protocol is now the
 * InputStick packet protocol (see protocol.ts and
 * ../INPUTSTICK_EMULATION_SPEC.md):
 *
 * - On connect we run the InputStick handshake: RunFirmware →
 *   GetFirmwareInfo → SetUpdateInterval. The RunFirmware response doubles
 *   as a protocol guard: a pre-v6 dongle (raw ASCII protocol) never
 *   answers, so connecting to stale firmware fails loudly instead of
 *   typing framed garbage into the PC.
 * - Everything sent is whole framed packets (CRC32 + 16-byte blocks),
 *   written in ≤20-byte chunks (the link never negotiates past the ATT
 *   floor). The dongle's RX parser is a byte-stream state machine, so
 *   chunk boundaries are arbitrary.
 * - TX notifications are parsed as InputStick packets. The 0x2F
 *   HIDStatusNotification drives flow control: per-interface free-space
 *   counters are decremented per HID report sent and replenished from the
 *   notification's drained-to-host counts, so a fast dictation burst can
 *   never overrun the dongle's 256-deep HID queue.
 *
 * v6 has no pairing/bonding, no v3 config characteristic and no v5
 * macro-store characteristics — all of that handling is gone.
 */
import {
  ADVERTISED_NAME_PREFIX,
  CMD,
  HID_BUFFER_CAPACITY,
  NUS_RX_UUID,
  NUS_SERVICE_UUID,
  NUS_TX_UUID,
  PacketParser,
  USB_CONFIGURED,
  USB_DISCONNECTED,
  buildPacket,
  chunkPayload,
  iteratePackets,
  packetInterface,
  parseHidStatus,
  type HidInterface,
  type RxPacket,
} from './protocol';

export type StatusListener = (status: 'idle' | 'busy' | 'error') => void;
export type DisconnectListener = () => void;

/** Inter-write pacing between ATT writes on the serialized queue. */
const WRITE_DELAY_MS = 20;

/**
 * Test-tunable timeouts (ms). handshake: how long to wait for the
 * RunFirmware/GetFirmwareInfo responses before declaring the dongle stale.
 * credit: how long a HID send waits for a 0x2F replenishment before
 * assuming the notify path died and re-seeding free space (the firmware
 * drains ~1000 reports/s, so a real stall means notifications are lost;
 * re-seeding is safe because the dongle queue (256) holds the full modeled
 * capacity 128+64+64 and overflow there is drop-only, never corruption).
 */
export const timeouts = { handshakeMs: 3000, creditMs: 2000 };

export class DongleConnection {
  private rx: BluetoothRemoteGATTCharacteristic | null = null;
  private queue: Promise<void> = Promise.resolve();
  private parser = new PacketParser();
  /** Firmware version from GetFirmwareInfo (e.g. "101"), once known. */
  firmwareVersion: string | null = null;

  /** App-side model of the dongle's per-interface HID buffer free space. */
  private freeSpace: Record<HidInterface, number> = { ...HID_BUFFER_CAPACITY };
  private creditWaiters: Array<() => void> = [];
  private responseWaiters: Array<{
    cmd: number;
    resolve: (packet: RxPacket) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];

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

  /** Connect to a granted device, set up NUS, and run the InputStick handshake. */
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
      filters: [{ services: [NUS_SERVICE_UUID] }, { namePrefix: ADVERTISED_NAME_PREFIX }],
      optionalServices: [NUS_SERVICE_UUID],
    });
  }

  /** Remove a stale grant so the user can re-grant from scratch. */
  async forget(): Promise<void> {
    this.disconnect();
    if (this.device.forget) await this.device.forget();
  }

  get name(): string {
    return this.device.name ?? 'InputStick dongle';
  }

  get id(): string {
    return this.device.id;
  }

  get connected(): boolean {
    return this.device.gatt?.connected ?? false;
  }

  async connect(onStatus: StatusListener, onDisconnect: DisconnectListener): Promise<void> {
    if (!this.device.gatt) throw new Error('GATT not available on this device');

    this.device.addEventListener('gattserverdisconnected', this.handleDisconnect);
    this.onDisconnect = onDisconnect;
    this.onStatus = onStatus;

    const server = await this.device.gatt.connect();
    const service = await server.getPrimaryService(NUS_SERVICE_UUID);
    this.rx = await service.getCharacteristic(NUS_RX_UUID);

    const tx = await service.getCharacteristic(NUS_TX_UUID);
    await tx.startNotifications();
    tx.addEventListener('characteristicvaluechanged', (event) => {
      const value = (event.target as BluetoothRemoteGATTCharacteristic).value;
      if (value && value.byteLength > 0) {
        this.handleTx(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
      }
    });

    await this.handshake();
  }

  /**
   * InputStick handshake (spec §5, inputstick.c dispatch): RunFirmware and
   * GetFirmwareInfo with the response flag (the dongle answers regardless —
   * the response is our proof we're talking to v6+ firmware), then
   * SetUpdateInterval (param 4 = 400 ms, iOS-style without response flag)
   * which is what flips the dongle into the Ready state and starts the
   * periodic 0x2F status notifications.
   */
  private async handshake(): Promise<void> {
    const runFirmware = this.waitForResponse(CMD.RunFirmware);
    await this.writeRaw(buildPacket(CMD.RunFirmware, 0, undefined, true));
    await runFirmware;

    const fwInfo = this.waitForResponse(CMD.GetFirmwareInfo);
    await this.writeRaw(buildPacket(CMD.GetFirmwareInfo, 0, undefined, true));
    const info = await fwInfo;
    // data[1] = versionMajor, data[2] = versionMinor (spec §5.1); the dongle
    // reports 1.1 → version 101.
    if (info.data.length >= 3) {
      this.firmwareVersion = `${info.data[1]}.${info.data[2]}`;
    }

    await this.writeRaw(buildPacket(CMD.SetUpdateInterval, 4));
  }

  /** Await a response packet for `cmd`; rejects on timeout. */
  private waitForResponse(cmd: number): Promise<RxPacket> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.responseWaiters = this.responseWaiters.filter((w) => w.cmd !== cmd);
        reject(
          new Error(
            'The dongle did not answer the InputStick handshake — it is probably running pre-v6 firmware. Reflash it with v6.7 or later.',
          ),
        );
      }, timeouts.handshakeMs);
      this.responseWaiters.push({ cmd, resolve, reject, timer });
    });
  }

  /** Handle raw TX bytes: parse packets, drive flow control and status. */
  private handleTx(bytes: Uint8Array): void {
    for (const packet of this.parser.feed(bytes)) {
      if (packet.cmd === CMD.HidStatusNotification) {
        this.applyHidStatus(packet.data);
        continue;
      }
      const waiter = this.responseWaiters.find((w) => w.cmd === packet.cmd);
      if (waiter) {
        clearTimeout(waiter.timer);
        this.responseWaiters = this.responseWaiters.filter((w) => w !== waiter);
        waiter.resolve(packet);
      }
    }
  }

  /**
   * Flow control (spec §6.1): each 0x2F reports how many reports per
   * interface were drained to USB since the last one; add those back to the
   * modeled free space. A set buffer-empty flag means the interface is fully
   * drained, so free space snaps to capacity (self-healing after any missed
   * notification).
   */
  private applyHidStatus(data: Uint8Array): void {
    const status = parseHidStatus(data);
    const replenish = (
      iface: HidInterface,
      empty: boolean,
      drained: number,
    ): void => {
      const cap = HID_BUFFER_CAPACITY[iface];
      this.freeSpace[iface] = empty ? cap : Math.min(cap, this.freeSpace[iface] + drained);
    };
    replenish('keyboard', status.keyboardEmpty, status.keyboardSent);
    replenish('mouse', status.mouseEmpty, status.mouseSent);
    replenish('consumer', status.consumerEmpty, status.consumerSent);

    const waiters = this.creditWaiters;
    this.creditWaiters = [];
    for (const wake of waiters) wake();

    this.onStatus(
      status.usbState === USB_CONFIGURED
        ? 'idle'
        : status.usbState === USB_DISCONNECTED
          ? 'error'
          : 'busy',
    );
  }

  private onStatus: StatusListener = () => {};
  private onDisconnect: DisconnectListener = () => {};

  private handleDisconnect = () => {
    // Stop listening: a DongleConnection is single-use, and a stale
    // listener on the same device would keep firing after a reconnect
    // swapped in a new instance.
    this.device.removeEventListener('gattserverdisconnected', this.handleDisconnect);
    this.rx = null;
    this.freeSpace = { ...HID_BUFFER_CAPACITY };
    for (const waiter of this.responseWaiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('Dongle is not connected'));
    }
    const waiters = this.creditWaiters;
    this.creditWaiters = [];
    for (const wake of waiters) wake();
    this.onDisconnect();
  };

  disconnect(): void {
    if (this.device.gatt?.connected) this.device.gatt.disconnect();
  }

  /**
   * Queue framed packet bytes for sending. Sends are serialized; each
   * packet waits for enough modeled dongle free space before its chunks go
   * out, so the write path itself is the flow control.
   */
  send(data: Uint8Array): Promise<void> {
    if (data.length === 0) return Promise.resolve();
    const run = this.queue.then(() => this.writeAll(data));
    // Keep the queue alive even if a write fails; the failure still
    // propagates to this caller.
    this.queue = run.catch(() => {});
    return run;
  }

  /** Serialize `data` into packets, flow-control each, and write it out. */
  private async writeAll(data: Uint8Array): Promise<void> {
    if (!this.rx || !this.connected) throw new Error('Dongle is not connected');
    for (const { packet, cmd, param } of iteratePackets(data)) {
      const iface = packetInterface(cmd);
      if (iface) await this.acquireCredit(iface, Math.max(1, param));
      await this.writeChunks(packet);
    }
  }

  /**
   * Wait until the modeled free space fits `count` reports, then debit it.
   * If no 0x2F replenishes us within the credit timeout, re-seed to capacity
   * once (a dead notify path must not stall typing forever).
   */
  private async acquireCredit(iface: HidInterface, count: number): Promise<void> {
    while (this.freeSpace[iface] < count) {
      if (!this.connected) throw new Error('Dongle is not connected');
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          this.creditWaiters = this.creditWaiters.filter((w) => w !== wake);
          this.freeSpace[iface] = HID_BUFFER_CAPACITY[iface];
          resolve();
        }, timeouts.creditMs);
        const wake = () => {
          clearTimeout(timer);
          resolve();
        };
        this.creditWaiters.push(wake);
      });
    }
    this.freeSpace[iface] -= count;
  }

  /** Write one control packet outside the send queue (handshake path). */
  private async writeRaw(packet: Uint8Array): Promise<void> {
    if (!this.rx || !this.connected) throw new Error('Dongle is not connected');
    await this.writeChunks(packet);
  }

  private async writeChunks(packet: Uint8Array): Promise<void> {
    const rx = this.rx;
    if (!rx || !this.connected) throw new Error('Dongle is not connected');
    for (const chunk of chunkPayload(packet)) {
      // Fresh copy typed against ArrayBuffer (TS 5.7+ BufferSource generics).
      const payload = new Uint8Array(chunk);
      if (rx.properties.writeWithoutResponse) {
        await rx.writeValueWithoutResponse(payload);
      } else {
        await rx.writeValueWithResponse(payload);
      }
      await new Promise((resolve) => setTimeout(resolve, WRITE_DELAY_MS));
    }
  }
}

/** Classify connect/write failures for the status UI. */
export function describeBleError(error: unknown): { message: string } {
  if (error instanceof DOMException) {
    if (error.name === 'NotFoundError') {
      return {
        message: 'No dongle selected (or none found). Make sure the dongle is plugged in and advertising.',
      };
    }
    if (error.name === 'NetworkError') {
      return {
        message: 'Connection lost or could not be established. Move the phone closer to the dongle and retry.',
      };
    }
    return { message: `${error.name}: ${error.message}` };
  }
  return { message: error instanceof Error ? error.message : String(error) };
}
