# Puffin Pattern Studio

A TypeScript + SvelteKit static, offline-capable PWA in the product repository. The firmware submodule is deliberately untouched. Four monophonic tracks on MIDI channels 1–4, 16 steps per page, 1–64 active steps per track, independent mutes/cursors, shared transport, 20–300 BPM, note and velocity entry. The initial **Tidal motion** session is example content, not device state.

## Run

Requires Node 22.17 or newer (verified here with Node 26).

```sh
npm ci
npm run dev
```

For the installable/offline build, run `npm run build` then `npm run preview`. Deploy `build/` to a static HTTPS host at the origin root. The service worker caches the shell and assets after the first successful online load; reload once to let it control the page. Installability depends on the browser. Safari/iPad Web MIDI is not assumed supported; a native CoreMIDI client or gateway will be needed there.

## Try it

1. Press **Play** to hear the built-in preview synth. **Play** restarts; **Continue** retains the stopped position and pulse phase. Each track advances independently.
2. Select any step, then click a note key or use A/W/S/E/D/F/T/G/Y/H/U/J. Use arrows to move, Delete to write a rest, and Space to play/stop outside form controls. A note writes at the existing nonzero velocity, or 95 if previously a rest. Note entry does not auto-advance or emit live MIDI; press Play to hear the sequence.
3. Change **Pattern pages** to allocate 16/32/48/64 active steps; use **End step** for any inclusive end 1–64. View page buttons retain the within-page offset and clamp at the end. Shortening keeps all hidden pitches/velocities and stops the shared transport.
4. Open a second tab on the same origin. Both tabs load the same session and merge edits, but selection and transport stay local. Only run ONE tab as the clock/MIDI source; this prototype does not negotiate clock authority between tabs.
5. **Export session** downloads the complete unencrypted journal. **Import** merges the same session, or asks before opening another. Invalid imports leave the current session intact and restore never starts playback. Browser storage is best effort, not a substitute for backups.

## MIDI output

In desktop Chrome/Edge on HTTPS (or a secure local development origin), enable Web MIDI, grant permission and choose an output. Pair BLE MIDI through the OS first; this app does not use Web Bluetooth and Puffin's USB port is not assumed to expose MIDI.

- **Notes only** emits channel 1–4 note-on/off without clock or transport.
- **Notes + clock** adds MIDI Start/Stop/Continue and 24 PPQN clock. Select BLE or TRS as Puffin's external clock source. Its own patterns may layer with the web notes.
- **Clock + transport only** clocks Puffin's existing patterns, without sending the web pattern's notes.

Switching outputs or send modes stops and cleans up the old route. The browser is the temporary clock master and stops if hidden or delayed more than 100 ms; there is no sample-accurate timing guarantee. Disconnect/unload cleanup is best effort. Use device panic if an OS/device disconnect strands a note. Puffin is a MIDI controller/router, not an audio synth; MIDI reaching it does not itself imply audible output. No hardware round trip has been verified in this orb.

## Pattern read/write over SysEx

Requires firmware implementing the frozen profile1 protocol (merged in [firmware main c3fa1b9](https://github.com/figitaki/puffin-firmware/commit/c3fa1b9)), desktop Web MIDI with explicit SysEx permission, and paired BLE MIDI or a TRS MIDI interface. A physical BLE/TRS round trip with this merged firmware has not been tested yet. Ordinary note output does not grant SysEx permission.

1. In **Puffin pattern link**, click **Enable SysEx MIDI**, then explicitly select Puffin's input and output. Only one companion may coordinate the device, even over separate BLE/TRS connections; a Web Lock prevents two tabs on this origin owning the same output.
2. **Read Puffin** confirms adopting the device's first-note/velocity, length and mute fields into the app journal. Export your app session first if needed. Names and app tempo are not replaced.
3. Edit locally. **Send app changes** explicitly writes differing tracks when Puffin is stopped. The app never stops the device for you. Device physical edits are polled every10s while visible and merged into the journal; overlapping observed device changes win, independent app edits survive. Review and resend after a conflict. A restart requires another explicit read.
4. Device tempo/clock are read-only. Disconnect sends no transport command. Writes remain in device RAM; use physical Save for flash persistence.

**Projection, not full backup:** firmware retains chord tails, chance, ratchets, CC locks, gates and swing, but the app neither displays nor exports them. A changed primary pitch duplicating a retained chord note is rejected. All64 slots, including hidden slots, are transferred. Four-track sends may pause for the firmware's30s reply-cache window. Nothing is sent automatically. See the [frozen wire contract and gateway behavior](docs/sysex-proposal.md).

The app client/bridge passed31 byte-level requests against the actual C++ firmware harness, including staged hidden-step writes and readback. Browser controls were checked with mocked Web MIDI; physical BLE/TRS round trips remain unverified. Firmware runs its own playback after pattern-link disconnect; browser preview/clock is a separate optional route, not production clock authority.

## Sync architecture

Read [the session sync design](docs/session-sync.md) before extending sync. Implemented: validated immutable transactions, Lamport/actor/sequence per-field LWW, duplicate-safe merges, atomic rejection, localStorage persistence, JSON journals and same-origin BroadcastChannel exchange. The fixed v1 profile's initial state is the deterministic example session in `session.ts`; that base must remain immutable for v1 compatibility. Track and step IDs are fixed by the profile. No dynamic lists, routing graph, network pairing, WebRTC, relay service, encryption, snapshot compaction, or remote backup peer is implemented.

Proposed next layer: bounded incremental delta exchange with contiguous per-actor frontiers and gap requests; ordered stable-ID list operations; a separately fenced clock authority; optional encrypted store-and-relay peers. Lamport ordering is deterministic eventual convergence, not distributed consensus. The journal limit is 10,000 transactions; import files are limited to 8 MB. Export before reaching browser quota or the journal limit.

## Checks

```sh
npm run check
npm test
npm run build
npx tsc --project src/service-worker/tsconfig.json
```

Tests cover independent and conflicting edits, delivery reversal/duplication/gaps, malformed transactions, hidden-step/rest restoration, MIDI note zero, original-pitch release, clock/transport and independent lengths. Browser verification covers editor entry, partial final pages, mutes, local tab merge, mocked Web MIDI output, journal import/reload and offline reload. Physical BLE/TRS MIDI and native iPad behavior need real-device testing.

The current dependency audit reports four low-severity development-tool advisories through the upstream Svelte Vite plugin's `deepmerge`; there are no production runtime dependencies. No unsafe force override is applied.
