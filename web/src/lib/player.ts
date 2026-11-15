import type { Session } from './session';
export type Send = (bytes: number[]) => void;

/** Local simulated device; never persists or merges live transport. */
export class Player {
  running = false;
  positions = [-1, -1, -1, -1];
  private next = [0, 0, 0, 0];
  private pulse = 0;
  private sounding = new Map<number, number>();
  constructor(
    private session: Session,
    private send: Send,
    private changed: () => void = () => {}
  ) {}
  update(session: Session) {
    const resized = session.tracks.map(
      (track, i) => track.length !== this.session.tracks[i].length
    );
    if (resized.some(Boolean)) {
      this.stop();
      resized.forEach((changed, i) => {
        if (changed) {
          this.next[i] = 0;
          this.positions[i] = -1;
        }
      });
    }
    session.tracks.forEach((track, i) => {
      if (track.muted) this.release(i);
    });
    this.session = session;
  }
  start() {
    this.stop();
    this.positions = [-1, -1, -1, -1];
    this.next = [0, 0, 0, 0];
    this.pulse = 0;
    this.running = true;
    this.send([0xfa]);
    this.changed();
  }
  resume() {
    this.running = true;
    this.send([0xfb]);
    this.changed();
  }
  stop() {
    const wasRunning = this.running;
    this.running = false;
    for (const track of this.sounding.keys()) this.release(track);
    if (wasRunning) this.send([0xfc]);
    this.changed();
  }
  clock() {
    if (!this.running) return;
    this.send([0xf8]);
    if (this.pulse === 0) {
      this.session.tracks.forEach((track, i) => {
        this.release(i);
        const step = track.steps[this.next[i]];
        this.positions[i] = this.next[i];
        this.next[i] = (this.next[i] + 1) % track.length;
        if (!track.muted && step.velocity > 0) {
          this.send([0x90 + i, step.note, step.velocity]);
          this.sounding.set(i, step.note);
        }
      });
      this.changed();
    }
    this.pulse = (this.pulse + 1) % 6;
  }
  private release(track: number) {
    const pitch = this.sounding.get(track);
    if (pitch !== undefined) {
      this.send([0x80 + track, pitch, 0]);
      this.sounding.delete(track);
    }
  }
}

export class PreviewSynth {
  private context?: AudioContext;
  private voices = new Map<
    number,
    { oscillator: OscillatorNode; gain: GainNode }
  >();
  enabled = true;
  async unlock() {
    this.context ??= new AudioContext();
    await this.context.resume();
  }
  receive(bytes: number[]) {
    const context = this.context;
    if (!context) return;
    const [status, note, velocity] = bytes;
    const channel = status & 15;
    const command = status & 0xf0;
    if (command === 0x80 || command === 0x90) {
      const old = this.voices.get(channel);
      if (old) {
        old.gain.gain.setTargetAtTime(0, context.currentTime, 0.008);
        old.oscillator.stop(context.currentTime + 0.05);
        this.voices.delete(channel);
      }
      if (command !== 0x90 || !velocity || !this.enabled) return;
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = ['triangle', 'sine', 'sine', 'triangle'][
        channel
      ] as OscillatorType;
      oscillator.frequency.value = 440 * 2 ** ((note - 69) / 12);
      gain.gain.setValueAtTime(0, context.currentTime);
      gain.gain.linearRampToValueAtTime(
        (velocity / 127) * 0.09,
        context.currentTime + 0.008
      );
      oscillator.connect(gain).connect(context.destination);
      oscillator.start();
      this.voices.set(channel, { oscillator, gain });
    }
  }
  silence() {
    for (const channel of this.voices.keys())
      this.receive([0x80 + channel, 0, 0]);
  }
  close() {
    this.silence();
    void this.context?.close();
  }
}
