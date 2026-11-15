import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionReplica, type Write } from './session';
import {
  Command,
  PatternBridge,
  SysExClient,
  decodeFrame,
  encodeFrame,
  pendingTracks,
  type DeviceTrack,
  type Frame
} from './sysex';

// Independent wire peer for bridge tests. Firmware fixtures are checked separately against C++.
function numberBytes(value: number, count: number): number[] {
  return Array.from(
    { length: count },
    (_, i) => Math.floor(value / 2 ** (7 * i)) & 127
  );
}
function valueOf(bytes: number[]) {
  return bytes.reduce((value, byte, i) => value + byte * 2 ** (7 * i), 0);
}
function packet(
  device: number,
  command: number,
  request: number,
  payload: number[]
) {
  const data = [
    125,
    80,
    70,
    1,
    device,
    command,
    request & 127,
    request >> 7,
    ...payload
  ];
  return Uint8Array.from([
    240,
    ...data,
    -data.reduce((sum, value) => sum + value, 0) & 127,
    247
  ]);
}
class PuffinPeer {
  listeners = new Set<(event: { data: Uint8Array }) => void>();
  revision = 129;
  boot = [1, 2, 3, 4, 5, 6, 7, 8];
  running = false;
  profile = 1;
  tracks: DeviceTrack[] = Array.from({ length: 4 }, (_, track) => ({
    length: 17 + track,
    muted: track === 2,
    steps: Array.from({ length: 64 }, (_, step) => ({
      note: (track * 19 + step) % 128,
      velocity: step % 3 === 0 ? 0 : 37 + track
    }))
  }));
  received: Frame[] = [];
  beforeCommit?: () => void;
  whileRead?: () => void;
  dropCommits = false;
  cache = new Map<number, { at: number; response: Uint8Array }>();
  stage?: {
    token: number[];
    revision: number;
    track: number;
    value: DeviceTrack;
    at: number;
  };
  token = 0;
  addEventListener(
    _type: 'midimessage',
    listener: (event: { data: Uint8Array }) => void
  ) {
    this.listeners.add(listener);
  }
  removeEventListener(
    _type: 'midimessage',
    listener: (event: { data: Uint8Array }) => void
  ) {
    this.listeners.delete(listener);
  }
  emit(data: Uint8Array) {
    for (const listener of this.listeners) listener({ data });
  }
  send = (data: number[]) => {
    // Do not use the production decoder to decide what the peer executes.
    if (
      data[0] !== 240 ||
      data.at(-1) !== 247 ||
      data.slice(1, -1).reduce((sum, byte) => sum + byte, 0) % 128
    )
      throw new Error('Bad request checksum');
    const frame: Frame = {
      device: data[5],
      command: data[6],
      request: data[7] + 128 * data[8],
      payload: data.slice(9, -2)
    };
    this.received.push(frame);
    const now = performance.now();
    for (const [id, cached] of this.cache)
      if (now - cached.at >= 30000) this.cache.delete(id);
    const cached = this.cache.get(frame.request);
    if (cached) {
      if (!(this.dropCommits && frame.command === 5))
        this.emit(cached.response);
      return;
    }
    const p = frame.payload;
    let response: number[] = [],
      error = 0;
    if (this.cache.size >= 32) {
      this.emit(
        packet(0, 127, frame.request, [
          frame.command,
          3,
          ...numberBytes(this.revision, 5)
        ])
      );
      return;
    }
    if (frame.command === 1)
      response = [
        this.profile,
        4,
        4,
        16,
        11,
        ...this.boot,
        ...numberBytes(this.revision, 5)
      ];
    else if (frame.command === 2) {
      this.whileRead?.();
      this.whileRead = undefined;
      const track = this.tracks[p[0]];
      response = [
        p[0],
        ...numberBytes(this.revision, 5),
        track.length,
        Number(track.muted),
        ...track.steps.flatMap(({ note, velocity }) => [note, velocity])
      ];
    } else if (frame.command === 7)
      response = [
        ...numberBytes(this.revision, 5),
        2,
        Number(this.running),
        ...Array(4).fill(this.running ? 9 : 127),
        ...numberBytes(211, 2)
      ];
    else if (frame.command === 3) {
      if (JSON.stringify(p.slice(0, 8)) !== JSON.stringify(this.boot))
        error = 7;
      else if (valueOf(p.slice(8, 13)) !== this.revision) error = 4;
      else {
        const token = numberBytes(++this.token, 2);
        this.stage = {
          token,
          revision: this.revision,
          track: p[13],
          value: {
            ...structuredClone(this.tracks[p[13]]),
            length: p[14],
            muted: p[15] === 1
          },
          at: now
        };
        response = token;
      }
    } else if (frame.command === 4 || frame.command === 5) {
      if (
        !this.stage ||
        now - this.stage.at >= 10000 ||
        JSON.stringify(this.stage.token) !== JSON.stringify(p.slice(0, 2))
      )
        error = 6;
      else if (frame.command === 4) {
        for (let i = 0; i < p[3]; i++)
          this.stage.value.steps[p[2] + i] = {
            note: p[4 + 2 * i],
            velocity: p[5 + 2 * i]
          };
        this.stage.at = now;
        response = p.slice(0, 4);
      } else {
        this.beforeCommit?.();
        this.beforeCommit = undefined;
        if (this.running) error = 3;
        else if (this.stage.revision !== this.revision) error = 4;
        else {
          this.tracks[this.stage.track] = this.stage.value;
          response = numberBytes(++this.revision, 5);
          this.stage = undefined;
        }
      }
    } else if (frame.command === 6) {
      response = p;
      this.stage = undefined;
    }
    const reply = packet(
      0,
      error ? 127 : frame.command | 64,
      frame.request,
      error
        ? [frame.command, error, ...numberBytes(this.revision, 5)]
        : response
    );
    this.cache.set(frame.request, { at: now, response: reply });
    if (!(this.dropCommits && frame.command === 5)) this.emit(reply);
  };
}
function setup() {
  const device = new PuffinPeer();
  const app = new SessionReplica('session', 'app');
  const gateway = new SessionReplica('session', 'puffin-gateway');
  const imported: Write[][] = [];
  const client = new SysExClient(device, device, 20, 0);
  const bridge = new PatternBridge(
    client,
    () => app.state(),
    (writes) => {
      imported.push(writes);
      gateway.merge(app.journal());
      gateway.edit(writes);
      app.merge(gateway.journal());
    }
  );
  return { device, app, gateway, imported, client, bridge };
}
afterEach(() => {
  vi.useRealTimers();
});

describe('Puffin SysEx wire contract', () => {
  it('matches a fixed HELLO packet and rejects corrupt, extended and non-seven-bit replies', () => {
    expect(
      encodeFrame({ device: 0, command: 1, request: 0, payload: [] })
    ).toEqual([240, 125, 80, 70, 1, 0, 1, 0, 0, 107, 247]);
    // Published firmware fixture, independent of this test's packet helper.
    const hex = (text: string) =>
      text.split(' ').map((byte) => parseInt(byte, 16));
    expect(
      encodeFrame({ device: 0, command: 1, request: 1, payload: [] })
    ).toEqual(hex('f0 7d 50 46 01 00 01 01 00 6a f7'));
    expect(
      decodeFrame(
        hex(
          'f0 7d 50 46 01 00 41 01 00 01 04 04 10 0b 01 02 03 04 05 06 07 08 00 00 00 00 00 62 f7'
        )
      )
    ).toEqual({
      device: 0,
      command: 65,
      request: 1,
      payload: [1, 4, 4, 16, 11, 1, 2, 3, 4, 5, 6, 7, 8, 0, 0, 0, 0, 0]
    });
    const valid = packet(
      0,
      65,
      300,
      [1, 4, 4, 16, 11, 1, 2, 3, 4, 5, 6, 7, 8, 1, 1, 0, 0, 0]
    );
    expect(decodeFrame(valid)).toEqual({
      device: 0,
      command: 65,
      request: 300,
      payload: Array.from(valid.slice(9, -2))
    });
    const corrupt = valid.slice();
    corrupt[20] ^= 1;
    expect(() => decodeFrame(corrupt)).toThrow();
    const high = valid.slice();
    high[10] = 128;
    expect(() => decodeFrame(high)).toThrow();
    expect(() =>
      decodeFrame([...valid.slice(0, -1), ...Array(150).fill(0), 247])
    ).toThrow();
    expect(decodeFrame([0x90, 60, 127])).toBeNull();
    expect(decodeFrame([0xf0, 1, 2, 0xf7])).toBeNull();
  });
  it('retries identical bytes, ignores unrelated replies, and cancels pending work on disconnect', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const input = new PuffinPeer();
    const sent: number[][] = [];
    const client = new SysExClient(
      input,
      {
        send: (bytes) => {
          sent.push(bytes);
        }
      },
      1000,
      16383
    );
    const pending = client.request(0, 1);
    await vi.advanceTimersByTimeAsync(1001);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(sent[0]);
    input.emit(packet(1, 65, 16383, [77])); // wrong device
    input.emit(packet(0, 66, 16383, [88])); // wrong command
    input.emit(packet(0, 65, 16382, [99])); // wrong request
    input.emit(packet(0, 65, 16383, [42]));
    await expect(pending).resolves.toEqual([42]);
    const canceled = client.request(0, 7);
    const rejection = expect(canceled).rejects.toThrow('closed');
    await vi.advanceTimersByTimeAsync(0);
    client.close();
    await rejection;
    expect(sent.at(-1)!.slice(7, 9)).toEqual([0, 0]); // wraps once without reusing an ID
  });
});

describe('pattern bridge and journal', () => {
  it('imports coherent full hidden slots, preserves names/tempo, and merges physical deltas without overwriting independent local edits', async () => {
    const { device, app, imported, bridge } = setup();
    device.whileRead = () => {
      device.tracks[3].steps[63] = { note: 0, velocity: 127 };
      device.revision++;
    };
    await bridge.read(); // first mixed-revision snapshot must be retried, not imported
    expect(imported).toHaveLength(1);
    expect(
      app
        .state()
        .tracks.map(({ length, muted, steps }) => ({ length, muted, steps }))
    ).toEqual(device.tracks);
    expect(app.state().tempo).toBe(118);
    expect(app.state().name).toBe('Tidal motion');
    expect(
      device.received.filter((request) => request.command === Command.readTrack)
    ).toHaveLength(8);
    app.edit([{ path: 'tracks/0/steps/19/note', value: 117 }]);
    device.tracks[0].steps[19].velocity = 123;
    device.revision++;
    await bridge.poll();
    expect(app.state().tracks[0].steps[19]).toEqual({
      note: 117,
      velocity: 123
    });
    expect(pendingTracks(app.state(), bridge.baseline)).toBe(1);
    const restored = new SessionReplica('session', 'future-peer');
    restored.merge(app.journal());
    expect(restored.state()).toEqual(app.state());
    expect(
      app.journal().transactions.some((tx) => tx.actor === 'puffin-gateway')
    ).toBe(true);
    bridge.close();
  });
  it('writes changed tracks by CAS with all 64 slots and recognizes readback without generating echo edits', async () => {
    const { device, app, imported, bridge } = setup();
    await bridge.read();
    app.edit([
      { path: 'tracks/1/length', value: 64 },
      { path: 'tracks/1/muted', value: true },
      { path: 'tracks/1/steps/63/note', value: 0 },
      { path: 'tracks/1/steps/63/velocity', value: 127 }
    ]);
    await bridge.write();
    expect(device.tracks[1]).toEqual({
      length: 64,
      muted: true,
      steps: app.state().tracks[1].steps
    });
    expect(
      device.received
        .filter((request) => request.command === 3)
        .map((request) => request.payload[13])
    ).toEqual([1]);
    expect(pendingTracks(app.state(), bridge.baseline)).toBe(0);
    await bridge.poll();
    expect(imported).toHaveLength(1);
    expect(
      device.received.every(({ command }) => command >= 1 && command <= 7)
    ).toBe(true);
    bridge.close();
  });
  it('re-reads conflicts and merges device edits, leaving independent unsent app edits pending', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const { device, app, bridge } = setup();
    await bridge.read();
    app.edit([{ path: 'tracks/0/steps/5/note', value: 122 }]);
    device.beforeCommit = () => {
      device.tracks[0].steps[9].velocity = 126;
      device.revision++;
    };
    await expect(bridge.write()).rejects.toThrow('changed during the write');
    expect(app.state().tracks[0].steps[9].velocity).toBe(126);
    expect(app.state().tracks[0].steps[5].note).toBe(122);
    expect(device.tracks[0].steps[5].note).toBe(5);
    expect(pendingTracks(app.state(), bridge.baseline)).toBe(1);
    bridge.close();
  });
  it('does not write a running or unsupported device, and refuses silent reattachment after a restart', async () => {
    const { device, app, bridge } = setup();
    await bridge.read();
    app.edit([{ path: 'tracks/0/muted', value: true }]);
    device.running = true;
    await expect(bridge.write()).rejects.toThrow('Stop Puffin');
    expect(device.received.some(({ command }) => command === 3)).toBe(false);
    device.running = false;
    device.boot[0]++;
    await expect(bridge.write()).rejects.toThrow('restarted');
    expect(device.received.some(({ command }) => command === 3)).toBe(false);
    await bridge.read(); // explicit read establishes new boot baseline
    bridge.close();
    const unsupported = setup();
    unsupported.device.profile = 2;
    await expect(unsupported.bridge.read()).rejects.toThrow(
      'Unsupported Puffin profile'
    );
    expect(unsupported.imported).toEqual([]);
    unsupported.bridge.close();
  });
  it('paces a four-track send around the real 32-entry cache without expiring a live stage', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const { device, app, bridge } = setup();
    await bridge.read();
    app.edit(
      Array.from({ length: 4 }, (_, i) => ({
        path: `tracks/${i}/steps/63/note`,
        value: 110 + i
      }))
    );
    const write = bridge.write();
    await vi.advanceTimersByTimeAsync(31000);
    await write;
    expect(device.tracks.map((track) => track.steps[63].note)).toEqual([
      110, 111, 112, 113
    ]);
    expect(pendingTracks(app.state(), bridge.baseline)).toBe(0);
    expect(device.stage).toBeUndefined();
    bridge.close();
  });
  it('recovers an unacknowledged commit without reimporting its echo over newer app edits', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const { device, app, bridge, imported } = setup();
    await bridge.read();
    app.edit([{ path: 'tracks/0/steps/4/note', value: 115 }]);
    device.dropCommits = true;
    const write = bridge.write();
    const failure = expect(write).rejects.toThrow('did not acknowledge');
    await vi.advanceTimersByTimeAsync(100);
    await failure;
    expect(device.tracks[0].steps[4].note).toBe(115);
    app.edit([{ path: 'tracks/0/steps/4/note', value: 116 }]);
    device.dropCommits = false;
    await bridge.read();
    expect(app.state().tracks[0].steps[4].note).toBe(116);
    expect(imported).toHaveLength(1);
    expect(pendingTracks(app.state(), bridge.baseline)).toBe(1);
    expect(device.received.filter(({ command }) => command === 5)).toHaveLength(
      4
    );
    bridge.close();
  });
});
