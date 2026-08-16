import { afterEach, describe, expect, it, vi } from 'vitest';
import { DongleConnection, timeouts } from './ble';
import {
  CMD,
  IS_TAG,
  NUS_RX_UUID,
  PacketParser,
  buildPacket,
  crc32,
  encodeMouse,
  encodeText,
} from './protocol';

/**
 * Queue/handshake/flow-control tests with a fully mocked Web Bluetooth
 * device. The fake dongle answers the InputStick handshake (RunFirmware and
 * GetFirmwareInfo responses) whenever those packets are written to RX.
 */

/** Mirror of the firmware's build_notification(): cmd + data, no param byte. */
function buildNotification(cmd: number, data: Uint8Array): Uint8Array {
  const payloadLen = 5 + data.length;
  const blocks = Math.floor((payloadLen - 1) / 16) + 1;
  const total = blocks * 16;
  const out = new Uint8Array(2 + total);
  out[0] = IS_TAG;
  out[1] = blocks;
  out[2 + 4] = cmd;
  out.set(data, 2 + 5);
  const crc = crc32(out.slice(2 + 4));
  out[2] = (crc >>> 24) & 0xff;
  out[3] = (crc >>> 16) & 0xff;
  out[4] = (crc >>> 8) & 0xff;
  out[5] = crc & 0xff;
  return out;
}

/** A v6.7-layout HIDStatusNotification (11 data bytes). */
function hidStatus(opts: {
  usbState?: number;
  keyboardEmpty?: boolean;
  keyboardSent?: number;
  mouseSent?: number;
  consumerSent?: number;
}): Uint8Array {
  const data = new Uint8Array(11);
  data[0] = opts.usbState ?? 0x05;
  data[2] = 1;
  data[3] = opts.keyboardEmpty === false ? 0 : 1;
  data[4] = 1;
  data[5] = 1;
  data[6] = 1;
  data[7] = opts.keyboardSent ?? 0;
  data[8] = opts.mouseSent ?? 0;
  data[9] = opts.consumerSent ?? 0;
  data[10] = 0xff;
  return buildNotification(CMD.HidStatusNotification, data);
}

const FW_INFO = (() => {
  const info = new Uint8Array(19);
  info[0] = 1; // firmwareType
  info[1] = 1; // versionMajor
  info[2] = 1; // versionMinor → 101
  return info;
})();

interface FakeOptions {
  writeWithoutResponse?: boolean;
  subscribeError?: Error;
  /** When false, the fake dongle never answers the handshake (stale fw). */
  answerHandshake?: boolean;
}

function makeFakeDevice(opts: FakeOptions = {}) {
  const written: Uint8Array[] = [];
  const inbound = new PacketParser(); // parses what the app writes to RX
  let txListener: ((event: Event) => void) | null = null;

  const notify = (bytes: Uint8Array) => {
    txListener?.({
      target: { value: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength) },
    } as unknown as Event);
  };

  const onWrite = (v: Uint8Array) => {
    written.push(new Uint8Array(v));
    if (opts.answerHandshake === false) return;
    for (const pkt of inbound.feed(v)) {
      if (pkt.cmd === CMD.RunFirmware) notify(buildPacket(CMD.RunFirmware, 1));
      if (pkt.cmd === CMD.GetFirmwareInfo) notify(buildPacket(CMD.GetFirmwareInfo, 1, FW_INFO));
    }
  };

  const rx = {
    properties: { write: true, writeWithoutResponse: opts.writeWithoutResponse ?? true },
    writeValueWithoutResponse: vi.fn(async (v: Uint8Array) => onWrite(v)),
    writeValueWithResponse: vi.fn(async (v: Uint8Array) => onWrite(v)),
  };
  const tx = {
    startNotifications: opts.subscribeError
      ? vi.fn(async () => Promise.reject(opts.subscribeError))
      : vi.fn(async () => {}),
    addEventListener: vi.fn((type: string, listener: (event: Event) => void) => {
      if (type === 'characteristicvaluechanged') txListener = listener;
    }),
  };
  const service = {
    getCharacteristic: vi.fn(async (uuid: string) => (uuid === NUS_RX_UUID ? rx : tx)),
  };
  const gatt = {
    connected: true,
    connect: vi.fn(async () => ({ getPrimaryService: vi.fn(async () => service) })),
    disconnect: vi.fn(() => {
      gatt.connected = false;
    }),
  };
  const raw = {
    id: 'fake-dongle',
    name: 'InputStick',
    gatt,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  /** Everything the app wrote, reassembled and packet-decoded. */
  const writtenPackets = () => {
    const parser = new PacketParser();
    return parser.feed(Uint8Array.from(written.flatMap((c) => [...c])));
  };
  return {
    device: raw as unknown as BluetoothDevice,
    raw,
    rx,
    tx,
    gatt,
    written,
    writtenPackets,
    notify,
  };
}

async function connectFake(opts: FakeOptions = {}) {
  const fake = makeFakeDevice(opts);
  const onStatus = vi.fn();
  const onDisconnect = vi.fn();
  const conn = await DongleConnection.connect(fake.device, onStatus, onDisconnect);
  return { conn, onStatus, onDisconnect, ...fake };
}

/** Fire the registered gattserverdisconnected handler. */
function fireDisconnect(raw: { addEventListener: ReturnType<typeof vi.fn> }): void {
  const call = raw.addEventListener.mock.calls.find(([type]) => type === 'gattserverdisconnected');
  if (!call) throw new Error('no gattserverdisconnected listener registered');
  (call[1] as () => void)();
}

const savedTimeouts = { ...timeouts };
afterEach(() => {
  timeouts.handshakeMs = savedTimeouts.handshakeMs;
  timeouts.creditMs = savedTimeouts.creditMs;
});

describe('handshake', () => {
  it('sends RunFirmware, GetFirmwareInfo, then SetUpdateInterval(4)', async () => {
    const { writtenPackets } = await connectFake();
    const cmds = writtenPackets().map((p) => p.cmd);
    expect(cmds).toEqual([CMD.RunFirmware, CMD.GetFirmwareInfo, CMD.SetUpdateInterval]);
    const params = writtenPackets().map((p) => p.param);
    expect(params[2]).toBe(4); // 400 ms status interval
  });

  it('requests responses on the two handshake queries', async () => {
    const { writtenPackets } = await connectFake();
    const [runFw, fwInfo] = writtenPackets();
    expect(runFw.responseFlag).toBe(true);
    expect(fwInfo.responseFlag).toBe(true);
  });

  it('captures the firmware version from GetFirmwareInfo', async () => {
    const { conn } = await connectFake();
    expect(conn.firmwareVersion).toBe('1.1');
  });

  it('fails loudly against pre-v6 firmware that never answers', async () => {
    timeouts.handshakeMs = 50;
    const fake = makeFakeDevice({ answerHandshake: false });
    await expect(
      DongleConnection.connect(fake.device, vi.fn(), vi.fn()),
    ).rejects.toThrow(/InputStick handshake/);
  });

  it('surfaces a TX subscription failure as a connect failure', async () => {
    const fake = makeFakeDevice({
      subscribeError: new DOMException('CCCD write failed', 'NotAllowedError'),
    });
    await expect(DongleConnection.connect(fake.device, vi.fn(), vi.fn())).rejects.toThrow(
      'CCCD write failed',
    );
  });
});

describe('write queue', () => {
  it('writes every chunk even when no TX notification ever arrives', async () => {
    const { conn, written, onStatus } = await connectFake();
    const base = written.length; // handshake writes
    // 8 chars = 16 reports → 50-byte packet → 3 chunks (20+20+10).
    await conn.send(encodeText('x'.repeat(8)));
    expect(written.length - base).toBe(3);
    expect(onStatus).not.toHaveBeenCalled();
  });

  it('prefers write-without-response when the characteristic has the property', async () => {
    const { conn, rx } = await connectFake({ writeWithoutResponse: true });
    await conn.send(encodeText('a'));
    expect(rx.writeValueWithoutResponse).toHaveBeenCalled();
    expect(rx.writeValueWithResponse).not.toHaveBeenCalled();
  });

  it('falls back to write-with-response when write-no-resp is unavailable', async () => {
    const { conn, rx } = await connectFake({ writeWithoutResponse: false });
    await conn.send(encodeText('a'));
    expect(rx.writeValueWithResponse).toHaveBeenCalled();
    expect(rx.writeValueWithoutResponse).not.toHaveBeenCalled();
  });

  it('keeps the queue alive after a failed write', async () => {
    const { conn, rx } = await connectFake();
    const base = rx.writeValueWithoutResponse.mock.calls.length; // handshake writes
    rx.writeValueWithoutResponse.mockRejectedValueOnce(new Error('GATT failure'));
    await expect(conn.send(encodeText('a'))).rejects.toThrow('GATT failure');
    // The next send must still reach the characteristic.
    await conn.send(encodeText('b'));
    expect(rx.writeValueWithoutResponse.mock.calls.length - base).toBe(2);
  });

  it('serializes overlapping sends: packets never interleave', async () => {
    const { conn, written } = await connectFake();
    const base = written.length; // handshake writes
    const a = encodeText('a'.repeat(8));
    const b = encodeMouse(1, 2, 3, 4);
    await Promise.all([conn.send(a), conn.send(b)]);
    const all = Uint8Array.from(written.slice(base).flatMap((c) => [...c]));
    expect(all).toEqual(Uint8Array.from([...a, ...b]));
  });

  it('resolves immediately for an empty payload', async () => {
    const { conn, written } = await connectFake();
    const before = written.length;
    await conn.send(new Uint8Array(0));
    expect(written).toHaveLength(before);
  });

  it('rejects non-packet bytes instead of sending them', async () => {
    const { conn } = await connectFake();
    await expect(conn.send(new Uint8Array([0x61, 0x62]))).rejects.toThrow(/bad tag/);
  });
});

describe('HID-status flow control', () => {
  it('maps a 0x2F with USBConfigured to idle status', async () => {
    const { conn, notify, onStatus } = await connectFake();
    notify(hidStatus({ usbState: 0x05 }));
    expect(onStatus).toHaveBeenCalledWith('idle');
    notify(hidStatus({ usbState: 0x00 }));
    expect(onStatus).toHaveBeenCalledWith('error');
    expect(conn.firmwareVersion).toBe('1.1');
  });

  it('stalls a burst that exhausts the modeled buffer until 0x2F replenishes it', async () => {
    const { conn, written, notify } = await connectFake();
    const base = written.length; // handshake writes
    // 70 chars = 140 reports > 128 kbd capacity: packets of 32/32/32/32/12.
    // 82-byte packets → 5 chunks each; the 5th packet must wait for credits.
    const send = conn.send(encodeText('x'.repeat(70)));
    await vi.waitFor(() => expect(written.length - base).toBe(20)); // 4 packets out
    let settled = false;
    void send.then(() => (settled = true));
    await new Promise((r) => setTimeout(r, 50));
    expect(settled).toBe(false); // stalled: no free space left

    // The dongle drained 64 reports to the host → 64 credits come back.
    notify(hidStatus({ keyboardEmpty: false, keyboardSent: 64 }));
    await send;
    expect(settled).toBe(true);
    expect(written.length - base).toBe(22); // last 34-byte packet = 2 chunks
  });

  it('re-seeds free space after the credit timeout if notifications die', async () => {
    timeouts.creditMs = 60;
    const { conn } = await connectFake();
    await conn.send(encodeText('x'.repeat(70))); // must finish despite zero 0x2F
  });

  it('treats the buffer-empty flag as a full refill', async () => {
    const { conn, notify } = await connectFake();
    // Burn all 128 credits.
    await conn.send(encodeText('x'.repeat(64))); // 128 reports exactly
    const send = conn.send(encodeText('y'));
    let settled = false;
    void send.then(() => (settled = true));
    await new Promise((r) => setTimeout(r, 50));
    expect(settled).toBe(false);
    notify(hidStatus({ keyboardEmpty: true, keyboardSent: 0 }));
    await send;
    expect(settled).toBe(true);
  });
});

describe('disconnect', () => {
  it('unregisters its disconnect listener so stale instances cannot fire again', async () => {
    const { raw, onDisconnect } = await connectFake();
    fireDisconnect(raw);
    expect(onDisconnect).toHaveBeenCalledTimes(1);
    const call = raw.addEventListener.mock.calls.find(([type]) => type === 'gattserverdisconnected');
    expect(raw.removeEventListener).toHaveBeenCalledWith('gattserverdisconnected', call?.[1]);
  });

  it('rejects sends after the link drops', async () => {
    const { conn, raw } = await connectFake();
    fireDisconnect(raw);
    await expect(conn.send(encodeText('a'))).rejects.toThrow('not connected');
  });
});
