import { describe, expect, it } from 'vitest';
import { SessionReplica, parseJournal, type Transaction } from './session';

describe('session journal', () => {
  it('merges concurrent fields and resolves same-field edits regardless of delivery order or duplicates', () => {
    const a = new SessionReplica('session', 'a');
    const b = new SessionReplica('session', 'b');
    a.edit([
      { path: 'tracks/0/steps/19/note', value: 0 },
      { path: 'tempo', value: 73 }
    ]);
    b.edit([
      { path: 'tracks/0/steps/19/velocity', value: 117 },
      { path: 'tempo', value: 211 }
    ]);
    const combined = [...a.journal().transactions, ...b.journal().transactions];
    for (const transactions of [
      combined,
      [...combined].reverse(),
      [...combined, ...combined]
    ]) {
      const peer = new SessionReplica('session', 'third');
      peer.merge({ ...a.journal(), transactions });
      expect(peer.state().tempo).toBe(211); // b wins the concurrent tie, not whichever arrived last.
      expect(peer.state().tracks[0].steps[19]).toEqual({
        note: 0,
        velocity: 117
      });
    }
    a.merge(b.journal());
    a.edit([{ path: 'tempo', value: 89 }]); // Causally later a must beat b.
    b.merge(a.journal());
    expect(b.state().tempo).toBe(89);
    expect(b.state()).toEqual(a.state());
  });
  it('retains hidden steps and rest pitch through export, restore and length changes', () => {
    const a = new SessionReplica('session', 'a');
    a.edit([
      { path: 'tracks/2/steps/63/note', value: 127 },
      { path: 'tracks/2/steps/63/velocity', value: 104 },
      { path: 'tracks/2/length', value: 64 }
    ]);
    a.edit([
      { path: 'tracks/2/length', value: 1 },
      { path: 'tracks/2/steps/63/velocity', value: 0 }
    ]);
    const restored = new SessionReplica('session', 'new-actor');
    restored.merge(parseJournal(JSON.parse(JSON.stringify(a.journal()))));
    restored.edit([{ path: 'tracks/2/length', value: 64 }]);
    expect(restored.state().tracks[2].steps[63]).toEqual({
      note: 127,
      velocity: 0
    });
    expect(restored.state().tracks[0].length).toBe(16);
  });
  it('accepts gaps without losing earlier edits and allocates sequence after restoration', () => {
    const a = new SessionReplica('session', 'a');
    a.edit([{ path: 'tracks/0/name', value: 'First' }]);
    a.edit([{ path: 'tracks/1/name', value: 'Second' }]);
    const restored = new SessionReplica('session', 'a');
    restored.merge({
      ...a.journal(),
      transactions: [a.journal().transactions[1]]
    });
    restored.merge(a.journal());
    expect(restored.edit([{ path: 'name', value: 'Restored' }]).seq).toBe(3);
    expect(
      restored
        .state()
        .tracks.slice(0, 2)
        .map((t) => t.name)
    ).toEqual(['First', 'Second']);
  });
  it('rejects malformed batches and identity collisions atomically', () => {
    const a = new SessionReplica('session', 'a');
    a.edit([{ path: 'tempo', value: 123 }]);
    const before = a.journal();
    const valid: Transaction = {
      sessionId: 'session',
      actor: 'b',
      seq: 1,
      lamport: 2,
      writes: [{ path: 'tempo', value: 200 }]
    };
    for (const path of [
      '__proto__/polluted',
      'tracks/4/muted',
      'tracks/0/steps/64/note'
    ]) {
      expect(() =>
        a.merge({
          ...before,
          transactions: [
            valid,
            { ...valid, seq: 2, writes: [{ path, value: 1 }] }
          ]
        })
      ).toThrow();
      expect(a.journal()).toEqual(before);
    }
    expect(() => a.edit([{ path: 'tracks/0/length', value: 65 }])).toThrow();
    expect(() => a.edit([{ path: 'tempo', value: 19 }])).toThrow();
    expect(() =>
      a.merge({
        ...before,
        transactions: [
          { ...before.transactions[0], writes: [{ path: 'tempo', value: 99 }] }
        ]
      })
    ).toThrow('identity');
    expect(a.journal()).toEqual(before);
  });
});
