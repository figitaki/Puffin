# Puffin pattern SysEx v1

The app implements the frozen **profile 1 projection** agreed with firmware PR [puffin-firmware#24](https://github.com/figitaki/puffin-firmware/pull/24). It reads and writes primary-note/velocity pairs, length and mute, including hidden slots. It is not a full rich-pattern backup or a device CRDT. Firmware is authoritative for chord tails, chance, ratchet, CC locks, gate and swing.

## Envelope and profile

`F0 7D 50 46 01 device command requestLo requestHi payload... checksum F7`

Every interior byte is seven-bit. Integers are little-endian base128. Checksum is the negative sum modulo128 from7D through payload; the sum including checksum is zero modulo128. Address0 is the implemented device;127 is HELLO discovery only. The app explicitly selects input/output ports and addresses0. The experimental manufacturer ID7D needs review before commercial distribution.

| Command (hex)   | Request payload                                         | Response payload (command +40 hex)                                              |
| --------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------- |
| 01 HELLO        | empty                                                   | profile1, tracks4, maxPages4, stepsPerPage16, caps11, bootNonce[8], revision[5] |
| 02 READ_TRACK   | track0–3                                                | track, revision[5], length1–64, muted0/1, 64 note/velocity pairs                |
| 03 BEGIN_WRITE  | bootNonce[8], expectedRevision[5], track, length, muted | token[2]                                                                        |
| 04 WRITE_CHUNK  | token[2], offset0–63, count1–16, pairs                  | token[2], offset, count                                                         |
| 05 COMMIT_WRITE | token[2]                                                | revision[5]                                                                     |
| 06 ABORT_WRITE  | token[2]                                                | token[2]                                                                        |
| 07 READ_STATUS  | empty                                                   | revision[5], clockSource, running, positions[4], tempo[2]                       |
| 7F ERROR        | response only                                           | originalCommand, code, currentRevision[5]                                       |

HELLO payload18 bytes. READ_TRACK payload136/frame147 bytes. READ_STATUS payload13/frame24 bytes; tempo occupies payload offsets11–12. No swing byte. ClockSource0internal/1BLE/2TRS; running0/1; positions are next-step indices0–63,127 stopped. Tempo20–300 is the preferred internal BPM, not measured external tempo. Caps11 = staged1 | revision-conflict2 | stopped-only8; notifications are absent. Revision is uint32 carried in5 bytes, boot nonce56 bits in8 bytes. They are not durable causal counters. The app rejects unsupported profiles before editing; there are no tempo, transport, routing or rich-expression writes.

## Preservation and atomicity

READ projects `count ? notes[0] : 0` and `count ? velocity : 0`; empty steps are canonically (0, 0). BEGIN copies the full existing track, not only its projection. Pairs identical to the projected pair leave the entire rich step untouched, including silent entry-velocity presets. A changed pair replaces only the first note and velocity, retaining the ordered chord tail, expression and continuation tie. On an empty step, a changed pair creates count1 even at velocity0 so its edited silent pitch survives Save/Load. On existing note steps, velocity0 retains chord count/tail. A pitch duplicating a retained tail pitch rejects the entire chunk with Range. All 64 slots remain editable regardless of length. Profile 1 cannot represent, create or clear ties; a continuation's stored note/velocity stays dormant while its tie is enabled.

COMMIT compares the global revision again and applies one track atomically, **only while both device clock and sequencer are stopped**. Busy never stops playback. Changes affect RAM and mark the project dirty; physical Save remains necessary for flash persistence. App disconnect sends no device transport command. No read/import starts playback.

Revision advances on musical changes, including hidden/rich steps, project Load, tempo and swing, but not navigation/playback. COMMIT advances even for identical data. Nonce changes on boot; revision and token cannot wrap within a boot. Token exhaustion16383 or revision exhaustion requires reboot.

Errors: malformed1, unsupported2, busy3, conflict4, range5, expired6, bootChanged7. One global stage is owned by ingress BLE/TRS and expires after10s idle. Other ingress receives Busy. Only successful cached BEGIN/chunk replies whose token matches the current live stage refresh its timeout; errors and older-stage replies do not. Retries never resurrect an expired stage.

## Requests, pacing and uncertain results

The firmware shares32 non-evicting cached responses across ingress, keyed by source/request ID. Exact retries return the original result for30s from original execution; retries do not extend cache life. An ID reused with other bytes is malformed. Full cache returns uncached Busy without executing. Ordinary Busy is cached, so a deliberate later attempt uses a fresh ID.

The app serializes requests, uses1s timeout with at most3 identical retries, and never retries after28s elapsed. It persists the next14-bit ID per output before sending, under a same-origin Web Lock, to avoid reusing cached IDs after reconnect. Firmware cannot authenticate this browser identity; other applications and BLE/TRS gateways must coordinate externally. Clearing browser storage loses the local counter.

Cache entries are paced at30.2s. Before BEGIN the client reserves space for status + BEGIN +4chunks + COMMIT, so it never intentionally waits for cache capacity inside a stage. Four-track sends may take over30s. Polls run every10s while visible and back off31s after Busy; they can be delayed by cache pacing. No write is automatic. After an uncertain COMMIT the app reads state before another write; it never equates a timeout with success. Known partial-track acknowledgements survive a later-track failure.

## Device-to-journal gateway

First read explicitly adopts all520 projected fields (4 × (length + mute +64 ×2)), leaving names and app tempo alone. A coherent read brackets all tracks and status with HELLO, requiring matching boot/revision throughout. Subsequent reads import only changes from the acknowledged device baseline, preserving independent unsent app edits. An overlapping physical change wins when observed by this single gateway; original physical edit time is unknown. Conflict triggers reread/merge and asks the user to review/send again. A restart requires an explicit read before further writes. Own writes, including uncertain COMMIT echoes, are not reimported over newer app edits.

Device observations become transactions from a distinct `puffin-UUID` gateway actor after observing the app journal. Normal persistence and BroadcastChannel replication apply. Exactly one companion bridges a device; same-origin Web Locks enforce one output owner, not cross-device/distributed authority. Snapshots cannot recover physical causal history or transient edits that return to their original value. Network peers, durable device actors and encrypted backup remain later layers; see [session-sync.md](session-sync.md).

## Interoperability evidence

Independent firmware fixture:

- Request: `f0 7d 50 46 01 00 01 01 00 6a f7`
- Response: `f0 7d 50 46 01 00 41 01 00 01 04 04 10 0b 01 02 03 04 05 06 07 08 00 00 00 00 00 62 f7`

The real TypeScript SysExClient/PatternBridge exchanged31 requests with the firmware C++ `test/PatternSync.cpp --wire` harness: fixture, coherent reads, status, staged write, hidden slot63 note0/velocity127, length17/mute, revision1, readback and no own-write journal echo. Firmware host tests also passed. App tests cover conflicts, profile/reboot/running rejection, cache pacing across four tracks, incremental journal merges and uncertain commit recovery. Browser UI was exercised with a clearly mocked MIDI endpoint. None of these proves physical BLE/TRS fragmentation, packet delivery, clock timing under read load, or iPad CoreMIDI interoperability.
