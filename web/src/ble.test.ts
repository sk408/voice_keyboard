import { describe, expect, it, vi } from 'vitest';
import { DongleConnection } from './ble';
import { CONFIG_CHAR_UUID, NUS_RX_UUID } from './protocol';
import { MACRO_LIST_UUID, MACRO_RW_UUID } from './macroSync';

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

/* --- v5 macro store characteristics --- */

interface FakeV5Options {
  /** Simulate pre-v5 firmware: the macro characteristics are absent. */
  omitMacroStore?: boolean;
  macroListJson?: string;
}

function makeFakeV5Device(opts: FakeV5Options = {}) {
  const rx = {
    properties: { write: true, writeWithoutResponse: true },
    writeValueWithoutResponse: vi.fn(async (_v: Uint8Array) => {}),
    writeValueWithResponse: vi.fn(async (_v: Uint8Array) => {}),
  };
  const tx = {
    startNotifications: vi.fn(async () => {}),
    addEventListener: vi.fn(),
  };
  const config = {
    readValue: vi.fn(async () => new DataView(new TextEncoder().encode('VoiceKB').buffer)),
    writeValueWithResponse: vi.fn(async (_v: Uint8Array) => {}),
  };
  const macroList = {
    readValue: vi.fn(
      async () => new DataView(new TextEncoder().encode(opts.macroListJson ?? '[]').buffer),
    ),
    startNotifications: vi.fn(async () => {}),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  const reads: string[] = [];
  const macroRw = {
    written: [] as Uint8Array[],
    writeValueWithResponse: vi.fn(async (v: Uint8Array) => {
      macroRw.written.push(v);
    }),
    readValue: vi.fn(async () => {
      const next = reads.shift();
      if (next === undefined) throw new Error('no queued read');
      return new DataView(new TextEncoder().encode(next).buffer);
    }),
  };
  const queueRead = (json: string) => reads.push(json);

  const service = {
    getCharacteristic: vi.fn(async (uuid: string) => {
      if (uuid === NUS_RX_UUID) return rx;
      if (uuid === MACRO_LIST_UUID || uuid === MACRO_RW_UUID) {
        if (opts.omitMacroStore) throw new DOMException('Not found', 'NotFoundError');
        return uuid === MACRO_LIST_UUID ? macroList : macroRw;
      }
      return uuid === CONFIG_CHAR_UUID ? config : tx;
    }),
  };
  const gatt = {
    connected: true,
    connect: vi.fn(async () => ({ getPrimaryService: vi.fn(async () => service) })),
    disconnect: vi.fn(() => {
      gatt.connected = false;
    }),
  };
  const raw = {
    id: 'fake-dongle-v5',
    name: 'VoiceKB',
    gatt,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  return {
    device: raw as unknown as BluetoothDevice,
    raw,
    rx,
    tx,
    macroList,
    macroRw,
    queueRead,
    gatt,
  };
}

async function connectFakeV5(opts: FakeV5Options = {}) {
  const fake = makeFakeV5Device(opts);
  const conn = await DongleConnection.connect(fake.device, vi.fn(), vi.fn());
  return { conn, ...fake };
}

describe('v5 macro store characteristics', () => {
  it('connects cleanly when the characteristics are absent (pre-v5 firmware)', async () => {
    const { conn } = await connectFakeV5({ omitMacroStore: true });
    expect(conn.supportsMacroStore).toBe(false);
    expect(await conn.readMacroList()).toBeNull();
  });

  it('detects the v5 store and reads MACRO_LIST', async () => {
    const { conn } = await connectFakeV5({ macroListJson: '[{"i":0,"name":"A","len":4}]' });
    expect(conn.supportsMacroStore).toBe(true);
    expect(await conn.readMacroList()).toBe('[{"i":0,"name":"A","len":4}]');
  });

  it('subscribes to MACRO_LIST notifications', async () => {
    const { conn, macroList } = await connectFakeV5();
    const listener = vi.fn();
    await conn.subscribeMacroList(listener);
    expect(macroList.startNotifications).toHaveBeenCalledTimes(1);
    const handler = macroList.addEventListener.mock.calls.find(
      ([type]) => type === 'characteristicvaluechanged',
    )?.[1] as (event: Event) => void;
    expect(handler).toBeDefined();
    handler(new Event('characteristicvaluechanged'));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('serializes macro writes and reads through the macro queue', async () => {
    const { conn, macroRw, queueRead } = await connectFakeV5();
    queueRead('{"op":"get","i":0,"off":0,"len":1,"data":"a","fin":true}');
    await conn.macroStoreWrite(new TextEncoder().encode('{"op":"get","i":0,"off":0}'));
    expect(await conn.macroStoreRead()).toContain('"op":"get"');
    expect(macroRw.written).toHaveLength(1);
    await expect(conn.macroStoreRead()).rejects.toThrow('no queued read');
    // The queue survives the failed read.
    await conn.macroStoreWrite(new TextEncoder().encode('{"op":"del","i":1}'));
    expect(macroRw.written).toHaveLength(2);
  });

  it('performs a get round-trip atomically — no write slips between request and read', async () => {
    const { conn, macroRw } = await connectFakeV5();
    const events: string[] = [];
    const responses = ['{"op":"get","i":0,"off":0,"len":1,"data":"a","fin":true}'];
    macroRw.writeValueWithResponse.mockImplementation(async (v: Uint8Array) => {
      macroRw.written.push(v);
      events.push(`write:${new TextDecoder().decode(v)}`);
    });
    macroRw.readValue.mockImplementation(async () => {
      events.push('read');
      return new DataView(new TextEncoder().encode(responses.shift() ?? '{}').buffer);
    });
    const getReq = new TextEncoder().encode('{"op":"get","i":0,"off":0}');
    const del = new TextEncoder().encode('{"op":"del","i":1}');
    // Enqueue the round-trip and a competing write back-to-back: the del
    // write must wait until the get's read has happened.
    const [response] = await Promise.all([
      conn.macroStoreGetRoundtrip(getReq),
      conn.macroStoreWrite(del),
    ]);
    expect(response).toContain('"op":"get"');
    expect(events).toEqual([
      'write:{"op":"get","i":0,"off":0}',
      'read',
      'write:{"op":"del","i":1}',
    ]);
  });
});
