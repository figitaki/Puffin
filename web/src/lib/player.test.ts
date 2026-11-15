import { describe, expect, it } from 'vitest';
import { SessionReplica } from './session';
import { Player } from './player';

function setup() {
  const session = new SessionReplica('session', 'a').state();
  for (const track of session.tracks) {
    track.steps = Array.from({ length: 64 }, () => ({ note: 60, velocity: 0 }));
  }
  const bytes: number[][] = [];
  const player = new Player(session, (message) => bytes.push(message));
  return { session, player, bytes };
}
describe('simulated device MIDI contract', () => {
  it('arms step zero on Start, emits 24 PPQN and wraps each track independently', () => {
    const { session, player, bytes } = setup();
    session.tracks[0].length = 3;
    session.tracks[1].length = 5;
    session.tracks[0].steps[0] = { note: 0, velocity: 127 };
    session.tracks[1].steps[0] = { note: 71, velocity: 54 };
    player.start();
    expect(bytes).toEqual([[0xfa]]);
    for (let i = 0; i < 24; i++) player.clock();
    expect(bytes.filter((b) => b[0] === 0xf8)).toHaveLength(24);
    expect(bytes.filter((b) => (b[0] & 0xf0) === 0x90)).toEqual([
      [0x90, 0, 127],
      [0x91, 71, 54],
      [0x90, 0, 127]
    ]);
    expect(player.positions).toEqual([0, 3, 3, 3]);
    player.stop();
    expect(bytes.slice(-2)).toEqual([[0x80, 0, 0], [0xfc]]);
  });
  it('releases the original sounding pitch after an edit and mutes immediately without freezing position', () => {
    const { session, player, bytes } = setup();
    session.tracks[0].steps[0] = { note: 48, velocity: 95 };
    player.start();
    player.clock();
    const edited = structuredClone(session);
    edited.tracks[0].steps[0].note = 72;
    player.update(edited);
    for (let i = 0; i < 6; i++) player.clock();
    expect(bytes).toContainEqual([0x80, 48, 0]);
    expect(bytes).not.toContainEqual([0x80, 72, 0]);
    player.start();
    player.clock();
    edited.tracks[0].muted = true;
    player.update(structuredClone(edited));
    expect(bytes.at(-1)).toEqual([0x80, 72, 0]);
    for (let i = 0; i < 6; i++) player.clock();
    expect(player.positions[0]).toBe(1);
  });
  it('Stop/Continue retain pulse phase while Start resets it', () => {
    const { player, bytes } = setup();
    player.start();
    player.clock();
    player.clock();
    player.stop();
    const count = bytes.length;
    player.clock();
    expect(bytes).toHaveLength(count);
    player.resume();
    for (let i = 0; i < 4; i++) player.clock();
    expect(player.positions[0]).toBe(0);
    player.clock();
    expect(player.positions[0]).toBe(1);
    expect(bytes).toContainEqual([0xfb]);
    player.start();
    player.clock();
    expect(player.positions[0]).toBe(0);
  });
  it('length changes stop shared transport but reset only the changed track', () => {
    const { session, player } = setup();
    player.start();
    for (let i = 0; i < 13; i++) player.clock();
    const next = structuredClone(session);
    next.tracks[2].length = 19;
    player.update(next);
    expect(player.running).toBe(false);
    expect(player.positions).toEqual([2, 2, -1, 2]);
    player.resume();
    for (let i = 0; i < 6; i++) player.clock();
    expect(player.positions).toEqual([3, 3, 0, 3]);
  });
});
