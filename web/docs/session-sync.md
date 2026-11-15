# Puffin session sync

Use a small, domain-specific replicated object graph and immutable transaction journal, not a general-purpose document CRDT. Musical edits converge without a central server; playback remains owned by one explicitly selected clock authority. This is a proposed protocol, not firmware functionality.

## Scope and source of truth

The initial profile follows the firmware thread T-01a1c909-0481-7210-8feb-8b29122e73a8: four monophonic tracks on channels 1–4, 64 stored steps each, active length 1–64, 16 steps per page, velocity zero as rest, and tempo 20–300. Hidden steps survive shortening. The currently checked-out hardware submodule need not contain that thread's pending changes.

The web editor lives in `web/` in figitaki/Puffin. It has its own package and deployment, avoiding coupling app dependencies to the C++ firmware submodule. A future native iPad client can implement the same wire contract without sharing a UI runtime.

## Stable objects, field registers, and explicit transactions

Every session has a random stable session ID, schema version, and profile ID. Track IDs and pattern IDs are stable, not array positions. In this first profile, IDs `track-1` through `track-4` bind to channels 1–4; each has a fixed pattern, with step slots 0–63. Local selection, edit cursor, device handles and playback position are not replicated.

Every transaction has `{sessionId, actor, seq, lamport, writes}`. A new random actor ID is allocated per browser tab/native installation incarnation; it is never copied with imported session data. Sequence numbers are monotonic per actor. Each transaction is immutable and identified by `(actor, seq)`. Each register resolves by the lexicographic maximum `(lamport, actor, seq)`. Actors compare as ASCII strings, not locale collation. Lamport time advances past every received transaction before a local edit. Equal IDs with different payloads are protocol errors, not merges.

| State                                                       | Merge rule                                                              | Reason                                                                                                                                                                                                                                                                                      |
| ----------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Session name, tempo, track name/mute, pattern active length | Per-field LWW register                                                  | Independent fields should merge independently; tempo is desired configuration, not clock phase.                                                                                                                                                                                             |
| Step note and velocity                                      | Separate per-field LWW registers, optionally written in one transaction | Concurrent pitch and velocity changes both survive. A rest writes only velocity=0, preserving pitch.                                                                                                                                                                                        |
| Fixed step positions                                        | Stable slots; no insertion shifts                                       | Index 7 always means the eighth step, including when length hides it.                                                                                                                                                                                                                       |
| Routing                                                     | Future atomic route-edge register with stable ID, explicit tombstone    | Concurrent port/channel changes must not construct a half-old route. Endpoint capabilities are separate metadata.                                                                                                                                                                           |
| Track/clip ordering                                         | Future ordered insert/move operations on stable IDs                     | Ordering is not a scalar property of an array index. Use RGA-style insertion anchors and unique operation IDs; move is an atomic removal of one placement plus a new placement. Concurrent placements of one object select the highest stamp. Deleted anchors remain until safe compaction. |
| Object deletion                                             | Future tombstone; resurrection requires a new generation ID             | A late edit must not resurrect a deleted clip. Restore is explicit.                                                                                                                                                                                                                         |
| Transport, clock ticks, live notes                          | Not durable CRDT fields                                                 | Replaying a backup must never emit notes or restart transport.                                                                                                                                                                                                                              |

A transaction is validated in full before acceptance. Current bounds and field whitelist are enforced before any write is visible. In a fixed four-track profile all valid field combinations remain valid; a multi-field transaction is observed atomically, but concurrent transactions still resolve each register independently. Future graph invariants (route cycles, deleting active clips) need deterministic normalization and explicit capability/version negotiation before shipping, not arbitrary imperative replay.

For future ordered lists, an insertion names an existing immutable placement ID as its anchor, not a mutable object ID. Concurrent children of an anchor sort by transaction stamp and operation index. A move creates a new placement for the same object; the highest stamped placement is visible, but old placements remain valid anchors. Missing anchors wait for dependency catch-up, and anchors must precede children causally, preventing move-induced anchor cycles. Concurrent delete wins for that object generation. This placement contract needs interoperability tests before expanding the fixed-track profile.

Undo is a new compensating edit, ideally conditional on each field still having the stamp being undone. It must never erase a remote peer's subsequent change. Undo is not implemented in the first editor.

## Ordering without a central server

Peers exchange missing immutable transactions. Causal ordering comes from Lamport clocks; concurrent operations receive a reproducible total display/replay order using actor ID and sequence as tie breakers. This is eventual convergence, NOT consensus or a globally final commit sequence. A newly discovered concurrent transaction can appear earlier in the sorted history; register application must therefore be commutative and idempotent. Do not implement arbitrary side-effecting commands by simply replaying the sorted log.

An anti-entropy handshake carries protocol/schema/profile, session ID, and per-actor highest CONTIGUOUS sequence received plus missing ranges. A maximum seen sequence alone is unsafe under out-of-order delivery. Request gaps, send bounded batches, acknowledge durable receipt, and retry idempotently. A snapshot includes register values AND winning stamps, tombstones, actor frontiers, schema, and a hash of its canonical content. Snapshot installation and tail acceptance are atomic. A fresh peer can fetch a snapshot and then the missing tail.

Transport needs stronger ordering than edit fields. The selected authority assigns `(authorityEpoch, commandSequence)` to start/stop/continue/seek and applies commands once at defined musical boundaries. Start arms step zero for the first clock; six MIDI clocks advance one sixteenth. Only that authority emits clock. Peers may propose commands but do not elect a new clock master during a partition. Ownership transfer needs an acknowledged handoff, or an explicit user override that can cause split playback until reconnection. No claim of automatic partition-safe leader election is made. Reconnection reconciles desired patterns separately from transport telemetry.

## Peer transport and remote backup

Use the same bounded delta envelopes over WebRTC reliable ordered data channels for browser peers, a native LAN connection for iPad/device gateways, or an authenticated relay connection. WebRTC still needs signaling and often TURN; it is not implemented by a BroadcastChannel. Device MIDI SysEx is a separate constrained adapter, not a way to send arbitrary WebRTC traffic.

A store-and-relay backup peer joins the same session, acknowledges only after durable storage, keeps snapshots plus uncompacted tail, and never takes clock authority or synthesizes edits. It can serve deltas to peers that were never online together. Offline peers need no cloud account; the backup is optional. A user-controlled relay or hosted service can provide availability without owning musical truth.

Before Internet deployment, pair peers using session-scoped capabilities, authenticate actor keys, sign transactions, enforce quotas, and encrypt session payloads end to end with an authenticated cipher and session key. Key rotation/revocation and membership epochs must specify what to do with edits created offline under a revoked key. A blind relay can index opaque actor/sequence envelopes but cannot validate musical fields; clients validate after decryption. Backup availability is not authentication or proof of correctness. Exported journals contain unencrypted musical state and should be treated as private files.

Do not garbage-collect based only on the online peers' acknowledgements. Require all retained members to acknowledge a snapshot frontier; long-offline members either keep the tail alive or explicitly rejoin in a new membership epoch from a snapshot. Devices with constrained memory may keep a materialized profile and frontier while a companion retains history. Device-originated physical edits still need actor IDs/stamps; a gateway that cannot stamp them must be the sole device-edit coordinator and disclose that limitation.

## First implementation boundary

The first web version implements validated field-register transactions, deterministic merges, durable local journal, JSON journal export/import, and same-origin tab replication using BroadcastChannel. The tab channel is a development peer transport; it is not Internet P2P, an authenticated relay, or an operational remote backup. Manual JSON export is the current backup mechanism. No Automerge/Yjs dependency is required.

The session model is independent of Svelte and MIDI. A transport adapter only exchanges journal envelopes; the playback scheduler consumes materialized state and never replays transport from the journal. Keep the complete journal for now (bounded import size); full frontier/delta exchange, snapshot compaction, signatures, encryption, network pairing and the native iPad bridge are proposed, not implemented.

The Web MIDI device gateway now implements frozen profile 1 SysEx reads and stopped-only staged writes. It translates primary-note/velocity, length and mute snapshots into distinct gateway-actor transactions. Initial adoption is explicit; subsequent imports compare the acknowledged device baseline and preserve independent app edits. An overlapping device delta wins at observation time, not physical edit time. Revision CAS prevents blind overwrite; a conflict rereads and asks for review. Own-write echoes are suppressed, including uncertain commit recovery. Same-origin Web Locks allow one gateway per output; all other apps/interfaces still require a single coordinating companion. Firmware boot revisions cannot reconstruct causal physical history. Rich firmware state is preserved on device but absent from the journal and exports. This adapter does not claim network convergence or full-pattern backup. See [the frozen SysEx contract](sysex-proposal.md). The prototype's journal is not yet a frozen cross-platform protocol.

## Why not a general-purpose CRDT now?

Automerge and Yjs are mature choices for unrestricted document merging, but they do not remove the need for clock authority, device bounds, graph invariants or a C++ bridge. Fixed step slots plus a handful of registers are small enough to validate and test directly. This choice carries real costs: protocol evolution, adversarial validation, ordering and compaction become Puffin's responsibility. Reconsider a library if arbitrary clip lists, collaborative text or rich graph edits dominate the product.

## Acceptance before real multiplayer

- Convergence under reversed delivery, duplicates, gaps and concurrent independent/same-field edits.
- No MIDI or transport side effects while importing, restoring or catching up.
- Crash-safe actor sequence allocation and durable acknowledgement.
- Authority transfer and partition behavior tested with two audible endpoints.
- Interoperability fixtures shared by browser, native iPad and firmware/gateway.
- Backup restore from snapshot plus tail with an offline peer returning after compaction.
