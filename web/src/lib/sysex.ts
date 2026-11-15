import type { Session, Step, Track, Write } from './session';

export const Command = {
  hello: 0x01,
  readTrack: 0x02,
  begin: 0x03,
  chunk: 0x04,
  commit: 0x05,
  abort: 0x06,
  status: 0x07
} as const;
export const Capability = {
  staged: 1,
  conflicts: 2,
  notifications: 4,
  stoppedOnly: 8
} as const;
export type Frame = {
  device: number;
  command: number;
  request: number;
  payload: number[];
};
export type DeviceTrack = Pick<Track, 'length' | 'muted' | 'steps'>;
export type DeviceHello = {
  device: number;
  boot: number[];
  revision: number;
  capabilities: number;
};
export type DeviceStatus = {
  revision: number;
  clock: number;
  running: boolean;
  positions: number[];
  tempo: number;
};
export type DeviceSnapshot = DeviceHello & {
  tracks: DeviceTrack[];
  status: DeviceStatus;
};

export function encodeInteger(value: number, bytes: number): number[] {
  if (!Number.isSafeInteger(value) || value < 0 || value >= 128 ** bytes)
    throw new Error('SysEx integer out of range');
  return Array.from({ length: bytes }, () => {
    const byte = value % 128;
    value = Math.floor(value / 128);
    return byte;
  });
}
function integer(bytes: number[], max = Number.MAX_SAFE_INTEGER): number {
  const value = bytes.reduce(
    (sum, byte, index) => sum + byte * 128 ** index,
    0
  );
  if (!Number.isSafeInteger(value) || value > max)
    throw new Error('Invalid SysEx integer');
  return value;
}
export function encodeFrame(frame: Frame): number[] {
  const bytes = [
    0x7d,
    0x50,
    0x46,
    1,
    frame.device,
    frame.command,
    ...encodeInteger(frame.request, 2),
    ...frame.payload
  ];
  if (bytes.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 127))
    throw new Error('SysEx data must be seven-bit');
  return [
    0xf0,
    ...bytes,
    (128 - (bytes.reduce((sum, byte) => sum + byte, 0) % 128)) % 128,
    0xf7
  ];
}
/** Ignore unrelated MIDI; reject malformed Puffin packets before they reach callers. */
export function decodeFrame(data: ArrayLike<number>): Frame | null {
  const bytes = Array.from(data).filter((byte) => byte < 0xf8);
  if (
    bytes[0] !== 0xf0 ||
    bytes[1] !== 0x7d ||
    bytes[2] !== 0x50 ||
    bytes[3] !== 0x46
  )
    return null;
  if (
    bytes.length < 11 ||
    bytes.length > 147 ||
    bytes.at(-1) !== 0xf7 ||
    bytes[4] !== 1 ||
    bytes
      .slice(1, -1)
      .some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 127) ||
    bytes.slice(1, -1).reduce((sum, byte) => sum + byte, 0) % 128 !== 0
  )
    throw new Error('Malformed Puffin SysEx packet');
  return {
    device: bytes[5],
    command: bytes[6],
    request: integer(bytes.slice(7, 9)),
    payload: bytes.slice(9, -2)
  };
}
export class DeviceError extends Error {
  constructor(
    readonly code: number,
    readonly revision: number
  ) {
    super(
      `Puffin: ${['unknown error', 'malformed request', 'unsupported command', 'busy (stop Puffin or wait for its request cache)', 'revision conflict', 'out of range (a pitch may duplicate a retained chord note)', 'stage expired', 'device restarted'][code] || `error ${code}`}`
    );
  }
}
export class SysExTimeout extends Error {
  constructor() {
    super('Puffin did not acknowledge. Read again before retrying a write.');
  }
}
export interface MidiInput {
  addEventListener(
    type: 'midimessage',
    listener: (event: { data: Uint8Array }) => void
  ): void;
  removeEventListener(
    type: 'midimessage',
    listener: (event: { data: Uint8Array }) => void
  ): void;
}
export interface MidiOutput {
  send(bytes: number[]): void;
}

/** One request in flight. Retries reuse the exact request bytes inside the 30-second cache window. */
export class SysExClient {
  private next: number;
  private used = 0;
  private recent: number[] = [];
  private cooling?: {
    timer: ReturnType<typeof setTimeout>;
    reject: (error: Error) => void;
  };
  private closed = false;
  private queue: Promise<unknown> = Promise.resolve();
  private pending?: {
    frame: Frame;
    accept: (payload: number[]) => void;
    reject: (error: Error) => void;
  };
  private readonly receive = (event: { data: Uint8Array }) => {
    let reply: Frame | null;
    try {
      reply = decodeFrame(event.data);
    } catch {
      return;
    }
    const pending = this.pending;
    if (
      !reply ||
      !pending ||
      reply.request !== pending.frame.request ||
      reply.device === 127 ||
      (pending.frame.device !== 127 && reply.device !== pending.frame.device)
    )
      return;
    if (reply.command === 0x7f) {
      if (
        reply.payload.length !== 7 ||
        reply.payload[0] !== pending.frame.command
      )
        return;
      try {
        pending.reject(
          new DeviceError(
            reply.payload[1],
            integer(reply.payload.slice(2), 0xffffffff)
          )
        );
      } catch (error) {
        pending.reject(error as Error);
      }
    } else if (reply.command === (pending.frame.command | 0x40)) {
      pending.accept(reply.payload);
    }
  };
  constructor(
    private input: MidiInput,
    private output: MidiOutput,
    private timeoutMs = 1000,
    initialRequest = Math.floor(Math.random() * 16384),
    private progress: (message: string) => void = () => {},
    private saveNext: (request: number) => void = () => {}
  ) {
    this.next = initialRequest;
    input.addEventListener('midimessage', this.receive);
  }
  request(
    device: number,
    command: number,
    payload: number[] = []
  ): Promise<number[]> {
    const task = this.queue.then(() => this.perform(device, command, payload));
    this.queue = task.catch(() => {});
    return task;
  }
  /** Leave room for an entire stage: firmware has 32 non-evicting cached replies. */
  async reserve(count: number) {
    for (;;) {
      if (this.closed) throw new Error('Pattern connection closed');
      const now = performance.now();
      this.recent = this.recent.filter((time) => now - time < 30200);
      if (this.recent.length + count <= 32) return;
      this.progress(
        'Waiting for Puffin’s 30-second request cache before continuing…'
      );
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => {
            this.cooling = undefined;
            resolve();
          },
          Math.max(1, this.recent[0] + 30200 - now)
        );
        this.cooling = { timer, reject };
      });
    }
  }
  private async perform(
    device: number,
    command: number,
    payload: number[]
  ): Promise<number[]> {
    await this.reserve(1);
    // IDs do not repeat during this connection, avoiding stale cached replies even on fast links.
    if (this.used++ >= 16384)
      throw new Error(
        'SysEx request IDs exhausted; reconnect after 30 seconds'
      );
    const frame = { device, command, request: this.next, payload };
    this.next = (this.next + 1) % 16384;
    // Persist before sending so a reconnect cannot reuse a still-cached request ID.
    this.saveNext(this.next);
    const bytes = encodeFrame(frame);
    const started = performance.now();
    this.recent.push(started);
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;
      let attempts = 0;
      const finish = (error?: Error, result?: number[]) => {
        clearTimeout(timer);
        this.pending = undefined;
        if (error) reject(error);
        else resolve(result!);
      };
      const send = () => {
        if (attempts++ === 4 || performance.now() - started >= 28000) {
          finish(new SysExTimeout());
          return;
        }
        timer = setTimeout(send, this.timeoutMs);
        try {
          this.output.send(bytes);
        } catch (error) {
          finish(error as Error);
        }
      };
      this.pending = {
        frame,
        accept: (result) => finish(undefined, result),
        reject: finish
      };
      send();
    });
  }
  close() {
    this.closed = true;
    if (this.cooling) {
      clearTimeout(this.cooling.timer);
      this.cooling.reject(new Error('Pattern connection closed'));
      this.cooling = undefined;
    }
    this.pending?.reject(new Error('Pattern connection closed'));
    this.input.removeEventListener('midimessage', this.receive);
  }
}

function expectSize(payload: number[], size: number) {
  if (payload.length !== size) throw new Error('Unsupported Puffin reply size');
}
function boolean(value: number): boolean {
  if (value !== 0 && value !== 1) throw new Error('Invalid Puffin boolean');
  return value === 1;
}
function sameBoot(a: DeviceHello, b: DeviceHello) {
  return a.boot.every((byte, index) => byte === b.boot[index]);
}
export function projectedTrack(track: DeviceTrack): DeviceTrack {
  return {
    length: track.length,
    muted: track.muted,
    steps: track.steps.map(({ note, velocity }) => ({ note, velocity }))
  };
}
export function trackWrites(track: DeviceTrack, index: number): Write[] {
  return [
    { path: `tracks/${index}/length`, value: track.length },
    { path: `tracks/${index}/muted`, value: track.muted },
    ...track.steps.flatMap((step, i) =>
      (['note', 'velocity'] as const).map((key) => ({
        path: `tracks/${index}/steps/${i}/${key}`,
        value: step[key]
      }))
    )
  ];
}
function allWrites(tracks: DeviceTrack[]) {
  return tracks.flatMap(trackWrites);
}
export function pendingTracks(
  session: Session,
  baseline?: DeviceSnapshot
): number {
  return baseline
    ? session.tracks.filter(
        (track, i) =>
          JSON.stringify(projectedTrack(track)) !==
          JSON.stringify(baseline.tracks[i])
      ).length
    : 0;
}

/** CAS snapshot adapter, not a device CRDT. Only this gateway authors observed device deltas. */
export class PatternBridge {
  baseline?: DeviceSnapshot;
  private echo = new Map<string, Write['value']>();
  constructor(
    private client: SysExClient,
    private getSession: () => Session,
    private importDevice: (writes: Write[]) => void
  ) {}

  private async hello(device: number): Promise<DeviceHello> {
    const payload = await this.client.request(device, Command.hello);
    expectSize(payload, 18);
    if (
      payload[0] !== 1 ||
      payload[1] !== 4 ||
      payload[2] !== 4 ||
      payload[3] !== 16 ||
      (payload[4] & 3) !== 3
    )
      throw new Error(
        'Unsupported Puffin profile: requires profile 1, four 64-step tracks and revision-checked staged writes'
      );
    return {
      device,
      capabilities: payload[4],
      boot: payload.slice(5, 13),
      revision: integer(payload.slice(13), 0xffffffff)
    };
  }
  private async status(device: number): Promise<DeviceStatus> {
    const payload = await this.client.request(device, Command.status);
    expectSize(payload, 13);
    const revision = integer(payload.slice(0, 5), 0xffffffff);
    if (
      payload[5] > 2 ||
      payload.slice(7, 11).some((position) => position > 63 && position !== 127)
    )
      throw new Error('Unsupported Puffin clock or position');
    const tempo = integer(payload.slice(11, 13));
    if (tempo < 20 || tempo > 300) throw new Error('Invalid Puffin tempo');
    return {
      revision,
      clock: payload[5],
      running: boolean(payload[6]),
      positions: payload.slice(7, 11),
      tempo
    };
  }
  private async snapshot(): Promise<DeviceSnapshot> {
    for (let attempt = 0; attempt < 3; attempt++) {
      // The frozen firmware profile uses address 0 on explicitly selected input/output ports.
      const first = await this.hello(0);
      const tracks: DeviceTrack[] = [];
      let coherent = true;
      for (let index = 0; index < 4; index++) {
        const payload = await this.client.request(
          first.device,
          Command.readTrack,
          [index]
        );
        expectSize(payload, 136);
        if (payload[0] !== index || payload[6] < 1 || payload[6] > 64)
          throw new Error('Invalid Puffin track reply');
        coherent &&=
          integer(payload.slice(1, 6), 0xffffffff) === first.revision;
        const steps: Step[] = Array.from({ length: 64 }, (_, i) => ({
          note: payload[8 + i * 2],
          velocity: payload[9 + i * 2]
        }));
        tracks.push({ length: payload[6], muted: boolean(payload[7]), steps });
      }
      const status = await this.status(first.device);
      const last = await this.hello(first.device);
      if (
        coherent &&
        sameBoot(first, last) &&
        last.revision === first.revision &&
        status.revision === first.revision
      )
        return { ...last, tracks, status };
    }
    throw new Error(
      'Puffin kept changing during read. Pause editing and read again.'
    );
  }
  private accept(snapshot: DeviceSnapshot, initial = false) {
    if (!initial && this.baseline && !sameBoot(snapshot, this.baseline))
      throw new Error(
        'Puffin restarted. Read Puffin explicitly to establish a new baseline; no patterns were sent.'
      );
    const before = this.baseline
      ? new Map(
          allWrites(this.baseline.tracks).map(({ path, value }) => [
            path,
            value
          ])
        )
      : undefined;
    const writes = allWrites(snapshot.tracks).filter(
      ({ path, value }) =>
        initial ||
        (value !== before?.get(path) &&
          (!this.echo.has(path) || value !== this.echo.get(path)))
    );
    if (writes.length) this.importDevice(writes);
    this.baseline = structuredClone(snapshot);
    this.echo.clear();
  }
  /** Explicit first read adopts the device projection. Later reads only merge physical deltas. */
  async read() {
    const snapshot = await this.snapshot();
    this.accept(snapshot, !this.baseline || !sameBoot(snapshot, this.baseline));
  }
  async poll() {
    if (!this.baseline) return;
    const hello = await this.hello(this.baseline.device);
    if (!sameBoot(hello, this.baseline))
      throw new Error(
        'Puffin restarted. Read Puffin before sending more patterns.'
      );
    if (hello.revision !== this.baseline.revision)
      this.accept(await this.snapshot());
    else {
      const status = await this.status(hello.device);
      if (status.revision !== hello.revision)
        this.accept(await this.snapshot());
      else this.baseline = { ...this.baseline, status };
    }
  }
  async write() {
    if (!this.baseline) throw new Error('Read Puffin before writing patterns');
    this.accept(await this.snapshot());
    if (this.baseline.status.running)
      throw new Error(
        'Stop Puffin on the device before writing. The app will not stop its transport.'
      );
    for (let index = 0; index < 4; index++) {
      const base: DeviceSnapshot = this.baseline!;
      const target = projectedTrack(this.getSession().tracks[index]);
      if (JSON.stringify(target) === JSON.stringify(base.tracks[index]))
        continue;
      await this.client.reserve(7); // Status + BEGIN + four chunks + COMMIT must fit before stage expiry.
      const status = await this.status(base.device);
      if (status.revision !== base.revision) {
        this.accept(await this.snapshot());
        throw new Error(
          'Puffin changed while preparing the write. Device edits were merged; review and send again.'
        );
      }
      if (status.running)
        throw new Error(
          'Stop Puffin on the device before writing. No stop command was sent.'
        );
      let token: number[] | undefined;
      let committing = false;
      try {
        const begin = await this.client.request(base.device, Command.begin, [
          ...base.boot,
          ...encodeInteger(base.revision, 5),
          index,
          target.length,
          Number(target.muted)
        ]);
        expectSize(begin, 2);
        token = begin;
        for (let offset = 0; offset < 64; offset += 16) {
          const reply = await this.client.request(base.device, Command.chunk, [
            ...token,
            offset,
            16,
            ...target.steps
              .slice(offset, offset + 16)
              .flatMap(({ note, velocity }) => [note, velocity])
          ]);
          if (JSON.stringify(reply) !== JSON.stringify([...token, offset, 16]))
            throw new Error('Invalid Puffin chunk acknowledgement');
        }
        committing = true;
        for (const { path, value } of trackWrites(target, index))
          this.echo.set(path, value);
        const reply = await this.client.request(
          base.device,
          Command.commit,
          token
        );
        expectSize(reply, 5);
        const revision = integer(reply, 0xffffffff);
        if (revision <= base.revision)
          throw new Error('Invalid Puffin commit revision');
        this.baseline = {
          ...base,
          revision,
          tracks: base.tracks.map((track, i) => (i === index ? target : track)),
          status: { ...base.status, revision }
        };
        this.echo.clear();
      } catch (error) {
        if (token && !committing) {
          try {
            await this.client.request(base.device, Command.abort, token);
          } catch {
            /* Stage expires after 10s; never claim it was applied. */
          }
        }
        if (error instanceof DeviceError && error.code === 4) {
          this.echo.clear();
          this.accept(await this.snapshot());
          throw new Error(
            'Puffin changed during the write. Device edits were merged; review the pattern and send again.'
          );
        }
        // On an uncertain COMMIT keep echo information. The next read recognizes our own
        // projected values without reimporting them over edits made while awaiting the reply.
        if (!committing || error instanceof DeviceError) this.echo.clear();
        throw error;
      }
    }
  }
  close() {
    this.client.close();
  }
}
