export type Step = { note: number; velocity: number };
export type Track = {
  id: string;
  name: string;
  channel: number;
  length: number;
  muted: boolean;
  steps: Step[];
};
export type Session = {
  id: string;
  name: string;
  tempo: number;
  tracks: Track[];
};
export type Write = { path: string; value: string | number | boolean };
export type Transaction = {
  sessionId: string;
  actor: string;
  seq: number;
  lamport: number;
  writes: Write[];
};
export type Journal = {
  version: 1;
  profile: 'puffin-4x64';
  sessionId: string;
  transactions: Transaction[];
};
const LIMIT = 10000;

function initial(id: string): Session {
  const riffs = [
    [48, 48, 55, 58, 48, 60, 55, 46],
    [60, 67, 63, 70],
    [72, 75, 79, 82],
    [36, 42, 38, 42]
  ];
  return {
    id,
    name: 'Tidal motion',
    tempo: 118,
    tracks: riffs.map((notes, t) => ({
      id: `track-${t + 1}`,
      name: ['Undertow', 'Glass tide', 'Sea birds', 'Drift'][t],
      channel: t + 1,
      length: 16,
      muted: false,
      steps: Array.from({ length: 64 }, (_, i) => ({
        note: notes[Math.floor(i / 2) % notes.length],
        velocity:
          i < 16 &&
          (t === 0
            ? i % 2 === 0
            : t === 1
              ? i % 4 === 2
              : t === 2
                ? i % 8 === 4
                : i % 4 === 0)
            ? 95
            : 0
      }))
    }))
  };
}
function validWrite(write: unknown): write is Write {
  if (!write || typeof write !== 'object') return false;
  const { path, value } = write as Write;
  if (path === 'name' || /^tracks\/[0-3]\/name$/.test(path))
    return typeof value === 'string' && value.length > 0 && value.length <= 80;
  if (/^tracks\/[0-3]\/muted$/.test(path)) return typeof value === 'boolean';
  if (typeof value !== 'number' || !Number.isInteger(value)) return false;
  if (path === 'tempo') return value >= 20 && value <= 300;
  if (/^tracks\/[0-3]\/length$/.test(path)) return value >= 1 && value <= 64;
  return (
    /^tracks\/[0-3]\/steps\/([0-9]|[1-5][0-9]|6[0-3])\/(note|velocity)$/.test(
      path
    ) &&
    value >= 0 &&
    value <= 127
  );
}
function canonical(tx: Transaction): string {
  return JSON.stringify([
    tx.sessionId,
    tx.actor,
    tx.seq,
    tx.lamport,
    tx.writes.map((w) => [w.path, w.value])
  ]);
}
function compare(a: Transaction, b: Transaction): number {
  return (
    a.lamport - b.lamport ||
    (a.actor < b.actor ? -1 : a.actor > b.actor ? 1 : 0) ||
    a.seq - b.seq
  );
}
function validateTransaction(value: unknown, sessionId: string): Transaction {
  if (!value || typeof value !== 'object')
    throw new Error('Invalid transaction');
  const tx = value as Transaction;
  if (
    tx.sessionId !== sessionId ||
    typeof tx.actor !== 'string' ||
    !/^[a-zA-Z0-9-]{1,80}$/.test(tx.actor) ||
    !Number.isSafeInteger(tx.seq) ||
    tx.seq < 1 ||
    !Number.isSafeInteger(tx.lamport) ||
    tx.lamport < 1 ||
    tx.lamport >= Number.MAX_SAFE_INTEGER ||
    !Array.isArray(tx.writes) ||
    !tx.writes.length ||
    tx.writes.length > 520 ||
    !tx.writes.every(validWrite) ||
    new Set(tx.writes.map((w) => w.path)).size !== tx.writes.length
  )
    throw new Error('Invalid transaction or field range');
  return {
    sessionId,
    actor: tx.actor,
    seq: tx.seq,
    lamport: tx.lamport,
    writes: tx.writes.map(({ path, value }) => ({ path, value }))
  };
}
export function parseJournal(value: unknown): Journal {
  if (!value || typeof value !== 'object')
    throw new Error('Invalid session file');
  const j = value as Journal;
  if (
    j.version !== 1 ||
    j.profile !== 'puffin-4x64' ||
    typeof j.sessionId !== 'string' ||
    !/^[a-zA-Z0-9-]{1,80}$/.test(j.sessionId) ||
    !Array.isArray(j.transactions) ||
    j.transactions.length > LIMIT
  )
    throw new Error('Unsupported session or journal too large');
  return {
    version: 1,
    profile: 'puffin-4x64',
    sessionId: j.sessionId,
    transactions: j.transactions.map((t) => validateTransaction(t, j.sessionId))
  };
}

/** Fixed-profile register CRDT. No transport, browser storage or MIDI side effects. */
export class SessionReplica {
  private transactions = new Map<string, Transaction>();
  private lamport = 0;
  private seq = 0;
  constructor(
    readonly sessionId: string,
    readonly actor: string
  ) {}
  edit(writes: Write[]): Transaction {
    const tx = validateTransaction(
      {
        sessionId: this.sessionId,
        actor: this.actor,
        seq: this.seq + 1,
        lamport: this.lamport + 1,
        writes
      },
      this.sessionId
    );
    this.merge({
      version: 1,
      profile: 'puffin-4x64',
      sessionId: this.sessionId,
      transactions: [tx]
    });
    return tx;
  }
  merge(value: unknown): boolean {
    const journal = parseJournal(value);
    if (journal.sessionId !== this.sessionId)
      throw new Error('This journal belongs to another session');
    const next = new Map(this.transactions);
    for (const tx of journal.transactions) {
      const key = `${tx.actor}:${tx.seq}`;
      const existing = next.get(key);
      if (existing && canonical(existing) !== canonical(tx))
        throw new Error('Conflicting transaction identity');
      next.set(key, tx);
    }
    if (next.size > LIMIT)
      throw new Error(
        'Journal full. Export a backup; compaction is not available yet.'
      );
    const changed = next.size !== this.transactions.size;
    this.transactions = next;
    for (const tx of next.values()) {
      this.lamport = Math.max(this.lamport, tx.lamport);
      if (tx.actor === this.actor) this.seq = Math.max(this.seq, tx.seq);
    }
    return changed;
  }
  journal(): Journal {
    return structuredClone({
      version: 1,
      profile: 'puffin-4x64',
      sessionId: this.sessionId,
      transactions: [...this.transactions.values()].sort(compare)
    });
  }
  state(): Session {
    const state = initial(this.sessionId);
    for (const tx of [...this.transactions.values()].sort(compare)) {
      for (const { path, value } of tx.writes) {
        const parts = path.split('/');
        // Paths have been whitelisted; no arbitrary object/prototype traversal.
        if (path === 'name') state.name = value as string;
        else if (path === 'tempo') state.tempo = value as number;
        else {
          const track = state.tracks[Number(parts[1])];
          if (parts[2] === 'name') track.name = value as string;
          else if (parts[2] === 'length') track.length = value as number;
          else if (parts[2] === 'muted') track.muted = value as boolean;
          else
            track.steps[Number(parts[3])][parts[4] as keyof Step] =
              value as number;
        }
      }
    }
    return state;
  }
}
export function noteName(note: number): string {
  return `${['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'][note % 12]}${Math.floor(note / 12) - 1}`;
}
