import { describe, expect, it, vi } from 'vitest';
import { DongleConnection } from './ble';
import { NUS_RX_UUID } from './protocol';

/**
 * Queue behavior tests with a fully mocked Web Bluetooth device.
 *
 * The key invariant under test: the write queue is self-paced (prior
 * writes + a timer) and never waits on TX status notifications — so a
 * dead notify path cannot stall sends (the "connected but zero writes"
 * regression).
 */

interface FakeOptions {
  writeWithoutResponse?: boolean;
  subscribeError?: Error;
}

function makeFakeDevice(opts: FakeOptions = {}) {
  const rx = {
    properties: { write: true, writeWithoutResponse: opts.writeWithoutResponse ?? true },
    writeValueWithoutResponse: vi.fn(async (_v: Uint8Array) => {}),
    writeValueWithResponse: vi.fn(async (_v: Uint8Array) => {}),
  };
  const tx = {
    startNotifications: opts.subscribeError
      ? vi.fn(async () => Promise.reject(opts.subscribeError))
      : vi.fn(async () => {}),
    addEventListener: vi.fn(),
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
    name: 'VoiceKB',
    gatt,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  return { device: raw as unknown as BluetoothDevice, raw, rx, tx, gatt };
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

describe('write queue', () => {
  it('writes every chunk even when no TX notification ever arrives', async () => {
    const { conn, rx, onStatus } = await connectFake();
    await conn.send(new Uint8Array(50).fill(0x61)); // 20 + 20 + 10
    expect(rx.writeValueWithoutResponse).toHaveBeenCalledTimes(3);
    expect(onStatus).not.toHaveBeenCalled();
  });

  it('prefers write-without-response when the characteristic has the property', async () => {
    const { conn, rx } = await connectFake({ writeWithoutResponse: true });
    await conn.send(new Uint8Array([0x61]));
    expect(rx.writeValueWithoutResponse).toHaveBeenCalledTimes(1);
    expect(rx.writeValueWithResponse).not.toHaveBeenCalled();
  });

  it('falls back to write-with-response when write-no-resp is unavailable', async () => {
    const { conn, rx } = await connectFake({ writeWithoutResponse: false });
    await conn.send(new Uint8Array([0x61]));
    expect(rx.writeValueWithResponse).toHaveBeenCalledTimes(1);
    expect(rx.writeValueWithoutResponse).not.toHaveBeenCalled();
  });

  it('keeps the queue alive after a failed write', async () => {
    const { conn, rx } = await connectFake();
    rx.writeValueWithoutResponse.mockRejectedValueOnce(new Error('GATT failure'));
    await expect(conn.send(new Uint8Array([0x61]))).rejects.toThrow('GATT failure');
    // The next send must still reach the characteristic.
    await conn.send(new Uint8Array([0x62]));
    expect(rx.writeValueWithoutResponse).toHaveBeenCalledTimes(2);
  });

  it('serializes overlapping sends: chunks never interleave', async () => {
    const { conn, rx } = await connectFake();
    const order: number[] = [];
    rx.writeValueWithoutResponse.mockImplementation(async (v: Uint8Array) => {
      order.push(v[0]);
    });
    const a = conn.send(new Uint8Array(25).fill(0x01)); // 2 chunks
    const b = conn.send(new Uint8Array(25).fill(0x02)); // 2 chunks
    await Promise.all([a, b]);
    expect(order).toEqual([1, 1, 2, 2]);
  });

  it('resolves immediately for an empty payload', async () => {
    const { conn, rx } = await connectFake();
    await conn.send(new Uint8Array(0));
    expect(rx.writeValueWithoutResponse).not.toHaveBeenCalled();
  });
});

describe('connect / disconnect', () => {
  it('surfaces a TX subscription failure as a connect failure', async () => {
    const fake = makeFakeDevice({
      subscribeError: new DOMException('CCCD write failed', 'NotAllowedError'),
    });
    await expect(DongleConnection.connect(fake.device, vi.fn(), vi.fn())).rejects.toThrow(
      'CCCD write failed',
    );
  });

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
    await expect(conn.send(new Uint8Array([0x61]))).rejects.toThrow('not connected');
  });
});
