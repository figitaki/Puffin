<script lang="ts">
  import { onMount } from 'svelte';
  import {
    SessionReplica,
    noteName,
    parseJournal,
    type Session,
    type Write
  } from '../lib/session';
  import { Player, PreviewSynth } from '../lib/player';
  import {
    PatternBridge,
    SysExClient,
    DeviceError,
    pendingTracks,
    type DeviceSnapshot
  } from '../lib/sysex';
  import '../style.css';

  const storageKey = 'puffin-session-v1';
  let replica: SessionReplica;
  let session = $state<Session>(
    new SessionReplica('loading', 'loading').state()
  );
  let selectedTrack = $state(0);
  let cursors = $state([0, 0, 0, 0]);
  let track = $derived(session.tracks[selectedTrack]);
  let cursor = $derived(cursors[selectedTrack]);
  let page = $derived(Math.floor(cursor / 16));
  let step = $derived(track.steps[cursor]);
  let ready = $state(false);
  let running = $state(false);
  let positions = $state([-1, -1, -1, -1]);
  let message = $state('');
  let saveStatus = $state('Opening local session…');
  let editCount = $state(0);
  let synthEnabled = $state(true);
  let octave = $state(4);
  let player: Player;
  let synth: PreviewSynth;
  let channel: BroadcastChannel | undefined;
  let midi: MIDIAccess | undefined;
  let outputs = $state<MIDIOutput[]>([]);
  let outputId = $state('');
  let output: MIDIOutput | undefined;
  let midiMode = $state('notes');
  let midiStatus = $state('Not connected');
  let fileInput: HTMLInputElement;
  let nextTick = 0;
  let inputs = $state<MIDIInput[]>([]);
  let sysexEnabled = $state(false);
  let syncInputId = $state('');
  let syncOutputId = $state('');
  let syncBusy = $state(false);
  let syncLinked = $state(false);
  let syncBaseline = $state<DeviceSnapshot>();
  let syncStatus = $state(
    'Not connected. Pattern sync needs firmware with Puffin SysEx profile 1.'
  );
  let bridge: PatternBridge | undefined;
  let deviceReplica: SessionReplica | undefined;
  let releaseSync: (() => void) | undefined;
  let nextPoll = 0;
  let syncGeneration = 0;
  const pendingPatterns = $derived(pendingTracks(session, syncBaseline));

  function disconnectPatterns() {
    syncGeneration++;
    bridge?.close();
    bridge = undefined;
    deviceReplica = undefined;
    releaseSync?.();
    releaseSync = undefined;
    syncLinked = false;
    syncBusy = false;
    syncBaseline = undefined;
    syncStatus =
      'Pattern link disconnected. No device transport command was sent.';
  }
  function deviceEdits(writes: Write[]) {
    if (!deviceReplica) throw new Error('Device journal actor unavailable');
    // Observe any same-origin peer edits before stamping an imported physical edit.
    persist();
    deviceReplica.merge(replica.journal());
    deviceReplica.edit(writes);
    replica.merge(deviceReplica.journal());
    refresh();
    persist();
    channel?.postMessage({ type: 'journal', journal: replica.journal() });
  }
  async function openPatternLink() {
    if (bridge) return bridge;
    const input = inputs.find((port) => port.id === syncInputId);
    const port = outputs.find((port) => port.id === syncOutputId);
    if (!sysexEnabled || !input || !port)
      throw new Error('Enable SysEx and select both Puffin input and output.');
    if (!navigator.locks)
      throw new Error(
        'Pattern sync requires Web Locks to prevent two tabs writing the same output.'
      );
    const generation = syncGeneration;
    const acquired = new Promise<void>((resolve, reject) => {
      void navigator.locks
        .request(
          `puffin-pattern-output:${port.id}`,
          { ifAvailable: true },
          async (lock) => {
            if (!lock) {
              reject(
                new Error(
                  'Another tab owns this pattern output. Disconnect it there first.'
                )
              );
              return;
            }
            if (generation !== syncGeneration) {
              reject(new Error('Pattern connection canceled'));
              return;
            }
            await new Promise<void>((release) => {
              releaseSync = release;
              resolve();
            });
          }
        )
        .catch(reject);
    });
    await acquired;
    if (generation !== syncGeneration)
      throw new Error('Pattern connection canceled');
    try {
      const key = `puffin-sysex-next:${port.id}`;
      const stored = localStorage.getItem(key);
      const next = stored === null ? undefined : Number(stored);
      if (
        next !== undefined &&
        (!Number.isInteger(next) || next < 0 || next > 16383)
      )
        throw new Error('Invalid stored MIDI request counter');
      deviceReplica = new SessionReplica(
        replica.sessionId,
        `puffin-${crypto.randomUUID()}`
      );
      bridge = new PatternBridge(
        new SysExClient(
          input,
          port,
          1000,
          next,
          (status) => {
            syncStatus = status;
          },
          (request) => localStorage.setItem(key, String(request))
        ),
        () => replica.state(),
        deviceEdits
      );
      syncLinked = true;
      return bridge;
    } catch (error) {
      disconnectPatterns();
      throw error;
    }
  }
  async function syncPatterns(action: 'read' | 'write' | 'poll') {
    if (syncBusy) return;
    const generation = syncGeneration;
    syncBusy = true;
    syncStatus =
      action === 'write'
        ? 'Sending changed patterns; Puffin must be stopped…'
        : action === 'read'
          ? 'Reading a revision-consistent Puffin snapshot…'
          : 'Checking Puffin…';
    try {
      const connection = await openPatternLink();
      await connection[action]();
      if (generation !== syncGeneration) return;
      syncBaseline = connection.baseline
        ? structuredClone(connection.baseline)
        : undefined;
      const pending = pendingTracks(replica.state(), syncBaseline);
      syncStatus = syncBaseline
        ? `Device revision ${syncBaseline.revision} acknowledged · ${pending ? `${pending} track${pending === 1 ? '' : 's'} pending send` : 'Pattern projection matches'} · Puffin ${syncBaseline.status.running ? 'playing' : 'stopped'}`
        : 'Read Puffin to establish the device baseline.';
      nextPoll = performance.now() + 10000;
    } catch (error) {
      if (generation !== syncGeneration) return;
      if (bridge?.baseline) syncBaseline = structuredClone(bridge.baseline);
      syncStatus = String(error instanceof Error ? error.message : error);
      // Busy replies can be cache-pressure or running-state errors. Use a new request ID
      // only after deliberate retry/backoff, never spin on the same cached Busy reply.
      nextPoll =
        performance.now() +
        (error instanceof DeviceError && error.code === 3 ? 31000 : 10000);
    } finally {
      if (generation === syncGeneration) syncBusy = false;
    }
  }
  function readPatterns() {
    if (
      !syncBaseline &&
      !confirm(
        'Read Puffin’s first-note/velocity patterns into this session? The initial read replaces overlapping pattern fields, not session or track names. Export the app session first if needed. Later reads merge device changes only.'
      )
    )
      return;
    void syncPatterns('read');
  }
  async function enableSysEx() {
    disconnectPatterns();
    if (!navigator.requestMIDIAccess) {
      syncStatus =
        'Web MIDI is unavailable. Use a supported desktop browser; native iPad needs CoreMIDI.';
      return;
    }
    try {
      const access = await navigator.requestMIDIAccess({ sysex: true });
      if (!access.sysexEnabled)
        throw new Error('SysEx permission was not granted');
      installMIDI(access);
      syncStatus =
        'SysEx enabled. Select Puffin input and output, then Read Puffin. Only one companion may coordinate this device.';
    } catch (error) {
      syncStatus = `SysEx unavailable or denied: ${String(error)}`;
    }
  }
  function installMIDI(access: MIDIAccess) {
    if (midi) midi.onstatechange = null;
    midi = access;
    sysexEnabled = access.sysexEnabled;
    const update = () => {
      outputs = [...access.outputs.values()].filter(
        (port) => port.state === 'connected'
      );
      inputs = [...access.inputs.values()].filter(
        (port) => port.state === 'connected'
      );
      if (outputId && !outputs.some((port) => port.id === outputId)) {
        changeOutput('');
        message = 'MIDI output disconnected; browser playback stopped.';
      }
      if (
        bridge &&
        (!inputs.some((port) => port.id === syncInputId) ||
          !outputs.some((port) => port.id === syncOutputId))
      )
        disconnectPatterns();
    };
    update();
    access.onstatechange = update;
    output = outputs.find((port) => port.id === outputId);
  }

  function refresh() {
    session = replica.state();
    cursors = cursors.map((c, i) => Math.min(c, session.tracks[i].length - 1));
    editCount = replica.journal().transactions.length;
    player?.update(session);
  }
  function persist() {
    try {
      const stored = localStorage.getItem(storageKey);
      if (stored) {
        const journal = parseJournal(JSON.parse(stored));
        if (journal.sessionId === replica.sessionId && replica.merge(journal))
          refresh();
      }
      localStorage.setItem(storageKey, JSON.stringify(replica.journal()));
      saveStatus = 'Saved on this browser';
    } catch (error) {
      saveStatus = 'Not saved — export a backup';
      message = String(error);
    }
  }
  function edit(writes: Write[]) {
    try {
      replica.edit(writes);
      refresh();
      persist();
      channel?.postMessage({ type: 'journal', journal: replica.journal() });
    } catch (error) {
      message = String(error);
    }
  }
  function field(path: string, value: number | string | boolean) {
    edit([{ path: `tracks/${selectedTrack}/${path}`, value }]);
  }
  function select(t: number, i: number) {
    selectedTrack = t;
    cursors[t] = i;
  }
  function setPage(p: number) {
    cursors[selectedTrack] = Math.min(p * 16 + (cursor % 16), track.length - 1);
  }
  function enterNote(note: number) {
    edit([
      { path: `tracks/${selectedTrack}/steps/${cursor}/note`, value: note },
      {
        path: `tracks/${selectedTrack}/steps/${cursor}/velocity`,
        value: step.velocity || 95
      }
    ]);
  }
  function toggleRest() {
    field(`steps/${cursor}/velocity`, step.velocity ? 0 : 95);
  }
  function send(bytes: number[]) {
    synth?.receive(bytes);
    const realtime = bytes[0] >= 0xf8;
    if (
      !output ||
      (realtime && midiMode === 'notes') ||
      (!realtime && midiMode === 'clock')
    )
      return;
    try {
      output.send(bytes);
    } catch (error) {
      message = `MIDI output failed: ${String(error)}`;
    }
  }
  async function play(resume = false) {
    try {
      if (synthEnabled) await synth.unlock();
      nextTick = performance.now() + 60000 / (session.tempo * 24);
      if (resume) player.resume();
      else player.start();
    } catch (error) {
      message = `Playback unavailable: ${String(error)}`;
    }
  }
  function stop() {
    player?.stop();
  }
  function changeOutput(id: string) {
    stop(); // Release notes and transport on the old route before switching.
    outputId = id;
    output = outputs.find((port) => port.id === id);
    midiStatus = output
      ? `Output: ${output.name || 'MIDI device'}`
      : 'No output selected';
  }
  async function connectMIDI() {
    if (!navigator.requestMIDIAccess) {
      midiStatus = 'Web MIDI unavailable. Try desktop Chrome or Edge.';
      return;
    }
    try {
      if (!midi)
        installMIDI(await navigator.requestMIDIAccess({ sysex: false }));
      midiStatus = outputs.length
        ? 'Choose an output below'
        : 'No outputs. Pair BLE MIDI in your OS, then reconnect.';
    } catch (error) {
      midiStatus = `MIDI access denied or unavailable: ${String(error)}`;
    }
  }
  function exportSession() {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(replica.journal(), null, 2)], {
        type: 'application/json'
      })
    );
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'puffin-session.json';
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function importSession(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    try {
      if (file.size > 8 * 1024 * 1024) throw new Error('File exceeds 8 MB');
      const journal = parseJournal(JSON.parse(await file.text()));
      const candidate = new SessionReplica(
        journal.sessionId,
        crypto.randomUUID()
      );
      candidate.merge(journal);
      if (journal.sessionId === replica.sessionId)
        candidate.merge(replica.journal());
      else if (
        !confirm(
          'Open a different session? Export the current session first if you need a backup.'
        )
      )
        return;
      stop();
      disconnectPatterns();
      replica = candidate;
      refresh();
      persist();
      channel?.postMessage({ type: 'hello', journal: replica.journal() });
      message =
        'Session imported. Matching sessions merge; transport stays stopped.';
    } catch (error) {
      message = `Import rejected: ${String(error)}`;
    } finally {
      input.value = '';
    }
  }
  function keydown(event: KeyboardEvent) {
    const target = event.target as HTMLElement;
    if (
      !ready ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      target.closest('input, select, textarea')
    )
      return;
    if (event.code === 'Space') {
      if (target.closest('button:not(.step):not(.piano button)')) return;
      event.preventDefault();
      if (running) stop();
      else void play();
    } else if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault();
      cursors[selectedTrack] =
        (cursor + (event.key === 'ArrowRight' ? 1 : track.length - 1)) %
        track.length;
    } else if (event.key === 'Backspace' || event.key === 'Delete') {
      event.preventDefault();
      field(`steps/${cursor}/velocity`, 0);
    } else {
      const offset = 'awsedftgyhuj'.indexOf(event.key.toLowerCase());
      const pitch = (octave + 1) * 12 + offset;
      if (
        offset >= 0 &&
        pitch <= 127 &&
        event.key.length === 1 &&
        !event.repeat
      ) {
        event.preventDefault();
        enterNote(pitch);
      }
    }
  }

  onMount(() => {
    const actor = crypto.randomUUID();
    replica = new SessionReplica(crypto.randomUUID(), actor);
    try {
      const stored = localStorage.getItem(storageKey);
      if (stored) {
        const journal = parseJournal(JSON.parse(stored));
        replica = new SessionReplica(journal.sessionId, actor);
        replica.merge(journal);
      }
    } catch (error) {
      message = `Could not restore session: ${String(error)}. Export before editing if recovery is needed.`;
    }
    synth = new PreviewSynth();
    refresh();
    player = new Player(session, send, () => {
      running = player.running;
      positions = [...player.positions];
    });
    persist();
    ready = true;
    if ('BroadcastChannel' in window) {
      channel = new BroadcastChannel('puffin-session-v1');
      channel.onmessage = (event) => {
        try {
          const data = event.data;
          if (
            !data ||
            !['hello', 'journal'].includes(data.type) ||
            data.journal?.sessionId !== replica.sessionId
          )
            return;
          if (replica.merge(data.journal)) {
            refresh();
            persist();
          }
          if (data.type === 'hello')
            channel?.postMessage({
              type: 'journal',
              journal: replica.journal()
            });
        } catch (error) {
          message = `Peer update rejected: ${String(error)}`;
        }
      };
      channel.postMessage({ type: 'hello', journal: replica.journal() });
    }
    const storageChanged = (event: StorageEvent) => {
      if (event.key !== storageKey || !event.newValue) return;
      try {
        const journal = parseJournal(JSON.parse(event.newValue));
        if (journal.sessionId === replica.sessionId && replica.merge(journal)) {
          refresh();
          persist();
        }
      } catch (error) {
        message = `Storage update rejected: ${String(error)}`;
      }
    };
    const visibility = () => {
      if (document.hidden && player.running) {
        stop();
        message =
          'Playback stopped while the tab is hidden. This prototype uses the browser clock.';
      }
    };
    const leave = () => {
      stop();
      disconnectPatterns();
    };
    const poller = setInterval(() => {
      if (
        !document.hidden &&
        bridge?.baseline &&
        !syncBusy &&
        performance.now() >= nextPoll
      )
        void syncPatterns('poll');
    }, 1000);
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('storage', storageChanged);
    window.addEventListener('pagehide', leave);
    const timer = setInterval(() => {
      if (!player.running) return;
      const now = performance.now();
      if (now < nextTick) return;
      if (now - nextTick > 100) {
        stop();
        message =
          'Clock paused after a browser timing delay. Press Play to restart.';
        return;
      }
      // Never burst a backlog of stale clocks; one pulse per scheduler turn.
      player.clock();
      nextTick += 60000 / (session.tempo * 24);
    }, 4);
    return () => {
      stop();
      clearInterval(timer);
      clearInterval(poller);
      disconnectPatterns();
      channel?.close();
      synth.close();
      if (midi) midi.onstatechange = null;
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('storage', storageChanged);
      window.removeEventListener('pagehide', leave);
    };
  });
</script>

<svelte:head
  ><title>Puffin — Pattern studio</title><meta
    name="description"
    content="An offline-first four-track pattern studio for Puffin. Edit, play and keep your musical ideas."
  /></svelte:head
>
<svelte:window onkeydown={keydown} />

<div class="app-shell">
  <header class="masthead">
    <a class="brand" href="/" aria-label="Puffin home"
      ><img src="/icon.svg" alt="" /><span
        >puffin<span class="brand-dot">.</span></span
      ></a
    >
    <span class="product-label"
      >PATTERN STUDIO <span class="version">/ 001</span></span
    >
    <div class="masthead-actions">
      <span class="local-badge"><i></i> LOCAL FIRST</span><button
        class="quiet"
        onclick={exportSession}
        disabled={!ready}>Export session ↗</button
      ><button class="quiet" onclick={() => fileInput.click()} disabled={!ready}
        >Import</button
      >
    </div>
    <input
      class="file-input"
      type="file"
      accept="application/json,.json"
      bind:this={fileInput}
      onchange={importSession}
      aria-label="Import session file"
    />
  </header>

  <main>
    <section class="session-heading" aria-label="Session">
      <div>
        <p class="eyebrow">YOUR SESSION / FOUR TRACKS, ONE CURRENT</p>
        <input
          class="session-title"
          aria-label="Session name"
          maxlength="80"
          value={session.name}
          onchange={(e) =>
            edit([{ path: 'name', value: e.currentTarget.value }])}
          disabled={!ready}
        />
        <p class="subtitle">Small patterns. Open possibilities.</p>
      </div>
      <div class="device-badge">
        <span class="status-light"></span>
        <div>
          <strong
            >{syncBaseline
              ? 'Puffin patterns linked'
              : 'Simulated Puffin'}</strong
          ><span
            >{syncBaseline
              ? 'Device projection · local playback preview'
              : 'Local playback · no hardware state read'}</span
          >
        </div>
        <span class="device-mark">⌘</span>
      </div>
    </section>

    <section class="transport" aria-label="Transport">
      <div class="transport-buttons">
        <button
          class="play-button"
          onclick={() => play()}
          disabled={!ready}
          aria-label="Play from beginning"><span>▶</span> Play</button
        ><button
          class="icon-button"
          onclick={stop}
          disabled={!running}
          aria-label="Stop">■</button
        ><button
          class="continue-button"
          onclick={() => play(true)}
          disabled={!ready || running}>Continue</button
        >
      </div>
      <div class="tempo-control">
        <label for="tempo">TEMPO</label><input
          id="tempo"
          type="number"
          min="20"
          max="300"
          value={session.tempo}
          onchange={(e) =>
            edit([{ path: 'tempo', value: Number(e.currentTarget.value) }])}
        /><span>BPM</span>
      </div>
      <div class="clock-label">
        <span class:active-light={running} class="status-light"></span>
        <div>
          <strong>{running ? 'Playing' : 'Stopped'}</strong><span
            >Browser clock · 24 PPQN</span
          >
        </div>
      </div>
      <label class="preview-toggle"
        ><input
          type="checkbox"
          checked={synthEnabled}
          onchange={(e) => {
            synthEnabled = e.currentTarget.checked;
            synth.enabled = synthEnabled;
            if (!synthEnabled) synth.silence();
          }}
        /> Preview audio</label
      >
      <span class="meter">4/4 <span>·</span> 1/16</span>
    </section>

    <div class="workspace">
      <section class="pattern-panel" aria-label="Pattern editor">
        <div class="panel-top">
          <div>
            <span class="eyebrow">SEQUENCER</span>
            <h2>A little repetition.<br />A lot of possibility.</h2>
          </div>
          <div class="page-selector">
            <span>VIEW PAGE</span>
            <div>
              {#each [0, 1, 2, 3] as p}<button
                  aria-label={`View page ${p + 1}`}
                  aria-pressed={page === p}
                  class:chosen={page === p}
                  disabled={p >= Math.ceil(track.length / 16)}
                  onclick={() => setPage(p)}
                  >{String(p + 1).padStart(2, '0')}</button
                >{/each}
            </div>
          </div>
        </div>
        <div class="pattern-scroll">
          <div class="pattern-grid">
            <div class="step-ruler">
              <span>TRACK / MIDI</span>{#each Array(16) as _, i}<span
                  class:downbeat={i % 4 === 0}
                  >{String(page * 16 + i + 1).padStart(2, '0')}</span
                >{/each}
            </div>
            {#each session.tracks as t, ti}
              <div
                class="track-row"
                class:selected-row={selectedTrack === ti}
                class:muted-row={t.muted}
                style={`--track-color: var(--track-${ti}); --track-soft: var(--soft-${ti})`}
              >
                <div class="track-meta">
                  <button
                    class="track-select"
                    aria-label={`Select track ${ti + 1}`}
                    aria-pressed={selectedTrack === ti}
                    onclick={() => (selectedTrack = ti)}
                    ><span class="track-number"
                      >{String(ti + 1).padStart(2, '0')}</span
                    ><span
                      ><strong>{t.name}</strong><small
                        >CH {t.channel} <span>·</span> {t.length} STEPS</small
                      ></span
                    ></button
                  ><button
                    class="mute"
                    class:is-muted={t.muted}
                    aria-label={`${t.muted ? 'Unmute' : 'Mute'} track ${ti + 1}`}
                    aria-pressed={t.muted}
                    onclick={() =>
                      edit([{ path: `tracks/${ti}/muted`, value: !t.muted }])}
                    >M</button
                  >
                </div>
                {#each Array(16) as _, i}
                  {@const index = page * 16 + i}
                  {@const s = t.steps[index]}
                  <button
                    class="step"
                    class:has-note={s.velocity > 0}
                    class:beat-start={i % 4 === 0}
                    class:step-selected={selectedTrack === ti &&
                      cursor === index}
                    class:playing={running && positions[ti] === index}
                    disabled={index >= t.length}
                    aria-label={`Track ${ti + 1} step ${index + 1}: ${s.velocity ? noteName(s.note) + ', velocity ' + s.velocity : 'rest'}`}
                    aria-pressed={selectedTrack === ti && cursor === index}
                    onclick={() => select(ti, index)}
                    ondblclick={() =>
                      edit([
                        {
                          path: `tracks/${ti}/steps/${index}/velocity`,
                          value: s.velocity ? 0 : 95
                        }
                      ])}
                    ><span class="step-led"></span><span
                      >{s.velocity ? noteName(s.note) : '—'}</span
                    ><span
                      class="velocity-bar"
                      style={`width: ${(s.velocity / 127) * 72}%`}
                    ></span></button
                  >
                {/each}
              </div>
            {/each}
          </div>
        </div>
        <div class="grid-caption">
          <span
            ><i class="selection-key"></i> Select a step, then play a note below</span
          ><span>Double-click to toggle a rest</span>
        </div>

        <section class="note-entry" aria-label="Note entry">
          <div class="note-entry-heading">
            <div>
              <span class="eyebrow">NOTE ENTRY</span>
              <p>Give this step a voice.</p>
            </div>
            <div class="octave-control">
              <button
                aria-label="Lower octave"
                onclick={() => (octave = Math.max(-1, octave - 1))}
                disabled={octave <= -1}>−</button
              ><span>OCT {octave}</span><button
                aria-label="Higher octave"
                onclick={() => (octave = Math.min(8, octave + 1))}
                disabled={octave >= 8}>+</button
              >
            </div>
          </div>
          <div class="piano">
            {#each ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'] as name, i}{@const pitch =
                (octave + 1) * 12 + i}<button
                class:black-key={name.includes('♯')}
                class:current-note={step.velocity > 0 && step.note === pitch}
                aria-label={`Enter ${name}${octave}`}
                disabled={pitch > 127}
                onclick={() => enterNote(pitch)}
                ><span>{name}</span><small>{'AWSEDFTGYHUJ'[i]}</small></button
              >{/each}
          </div>
          <div class="keyboard-hints">
            <span><kbd>←</kbd> <kbd>→</kbd> Move step</span><span
              ><kbd>delete</kbd> Rest</span
            ><span><kbd>space</kbd> Play / stop</span><span
              >Entry keeps the edit cursor in place</span
            >
          </div>
        </section>
      </section>

      <aside class="inspector" aria-label="Selected track and step">
        <div class="inspector-heading">
          <span class="eyebrow">THE DETAILS</span><span class="inspector-track"
            >TRACK {String(selectedTrack + 1).padStart(2, '0')}</span
          >
        </div>
        <label class="field-label" for="track-name">Track name</label><input
          id="track-name"
          class="text-field"
          maxlength="80"
          value={track.name}
          onchange={(e) => field('name', e.currentTarget.value)}
        />
        <div class="field-pair">
          <div>
            <label class="field-label" for="length">End step</label><input
              id="length"
              class="text-field"
              type="number"
              min="1"
              max="64"
              value={track.length}
              onchange={(e) => field('length', Number(e.currentTarget.value))}
            />
          </div>
          <div>
            <label class="field-label" for="pages">Pattern pages</label><select
              id="pages"
              value={Math.ceil(track.length / 16)}
              onchange={(e) =>
                field('length', Number(e.currentTarget.value) * 16)}
              >{#each [1, 2, 3, 4] as p}<option value={p}
                  >{p} {p === 1 ? 'page' : 'pages'}</option
                >{/each}</select
            >
          </div>
        </div>
        <p class="field-help">
          1–64 steps. Shortening keeps hidden notes and stops playback.
        </p>
        <div class="step-detail">
          <div class="step-detail-top">
            <span class="eyebrow">SELECTED STEP</span><strong
              >{String(cursor + 1).padStart(2, '0')}<span>
                / {track.length}</span
              ></strong
            >
          </div>
          <div class="selected-note">
            {noteName(step.note)}<span>{step.velocity ? 'NOTE' : 'REST'}</span>
          </div>
          <div class="field-pair">
            <div>
              <label class="field-label" for="pitch">MIDI note</label><input
                id="pitch"
                class="text-field"
                type="number"
                min="0"
                max="127"
                value={step.note}
                onchange={(e) =>
                  field(`steps/${cursor}/note`, Number(e.currentTarget.value))}
              />
            </div>
            <div>
              <label class="field-label" for="velocity">Velocity</label><input
                id="velocity"
                class="text-field"
                type="number"
                min="0"
                max="127"
                value={step.velocity}
                onchange={(e) =>
                  field(
                    `steps/${cursor}/velocity`,
                    Number(e.currentTarget.value)
                  )}
              />
            </div>
          </div>
          <button class="rest-button" onclick={toggleRest}
            >{step.velocity ? '− Make rest' : '+ Activate note'}</button
          >
          <p class="field-help">Velocity 0 is a rest. Pitch is remembered.</p>
        </div>
        <div class="sync-note">
          <span class="sync-symbol">↔</span>
          <div>
            <strong>Ideas stay together.</strong>
            <p>
              Tabs on this browser merge edits. Export your journal for a
              backup.
            </p>
            <span
              >{editCount}
              {editCount === 1 ? 'edit' : 'edits'} in the session journal</span
            >
          </div>
        </div>
      </aside>
    </div>

    <section class="midi-panel" aria-label="MIDI output">
      <div class="midi-title">
        <span class="port-icon">⏣</span>
        <div>
          <h3>Out into the world.</h3>
          <p>Send MIDI to Puffin or another instrument.</p>
        </div>
      </div>
      <button class="connect-button" onclick={connectMIDI}
        >Enable Web MIDI ↗</button
      ><label class="midi-select"
        >OUTPUT<select
          aria-label="MIDI output"
          value={outputId}
          onchange={(e) => changeOutput(e.currentTarget.value)}
          ><option value="">No device selected</option
          >{#each outputs as port}<option value={port.id}
              >{port.name || port.id}</option
            >{/each}</select
        ></label
      ><label class="midi-select"
        >SEND<select
          aria-label="MIDI send mode"
          value={midiMode}
          onchange={(e) => {
            stop();
            midiMode = e.currentTarget.value;
          }}
          ><option value="notes">Notes only</option><option value="both"
            >Notes + clock</option
          ><option value="clock">Clock + transport only</option></select
        ></label
      >
      <p class="midi-status" role="status">{midiStatus}</p>
      <p class="midi-help">
        For Puffin clock input, select BLE or TRS clock on the device.
        Clock-only plays its own patterns; notes + clock may layer both
        sequences. Pattern read/write is separate below. Browser-clock playback
        stops if this tab is hidden or its output disconnects. The pattern link
        never sends Start, Stop, notes or clock to Puffin.
      </p>
    </section>
    <section class="pattern-sync" aria-label="Puffin pattern sync">
      <div class="pattern-sync-heading">
        <div>
          <h3>Puffin pattern link</h3>
          <p>
            Read device edits into your journal. Send app changes only when
            Puffin is stopped.
          </p>
        </div>
        <button
          class="connect-button"
          onclick={enableSysEx}
          disabled={syncBusy || syncLinked}
        >
          {sysexEnabled ? 'SysEx enabled' : 'Enable SysEx MIDI ↗'}
        </button>
      </div>
      <div class="pattern-sync-controls">
        <label
          >Puffin input<select
            aria-label="Puffin pattern input"
            value={syncInputId}
            disabled={!sysexEnabled || syncLinked || syncBusy}
            onchange={(e) => {
              syncInputId = e.currentTarget.value;
            }}
          >
            <option value="">Select input</option>{#each inputs as port}<option
                value={port.id}>{port.name || port.id}</option
              >{/each}
          </select></label
        >
        <label
          >Puffin output<select
            aria-label="Puffin pattern output"
            value={syncOutputId}
            disabled={!sysexEnabled || syncLinked || syncBusy}
            onchange={(e) => {
              syncOutputId = e.currentTarget.value;
            }}
          >
            <option value="">Select output</option
            >{#each outputs as port}<option value={port.id}
                >{port.name || port.id}</option
              >{/each}
          </select></label
        >
        <button
          onclick={readPatterns}
          disabled={!sysexEnabled || !syncInputId || !syncOutputId || syncBusy}
          >Read Puffin</button
        >
        <button
          onclick={() => syncPatterns('write')}
          disabled={!syncBaseline ||
            syncBusy ||
            !pendingPatterns ||
            syncBaseline.status.running}
        >
          Send app changes{pendingPatterns ? ` (${pendingPatterns})` : ''}
        </button>
        <button onclick={disconnectPatterns} disabled={!syncLinked && !syncBusy}
          >Disconnect link</button
        >
      </div>
      <p class="pattern-sync-status" role="status" aria-live="polite">
        {syncStatus}
      </p>
      {#if syncBaseline}
        <p class="pattern-sync-summary">
          {pendingPatterns
            ? `${pendingPatterns} track${pendingPatterns === 1 ? '' : 's'} differ from the last device acknowledgement.`
            : 'All four pattern projections match the device acknowledgement.'}
          Device tempo {syncBaseline.status.tempo} BPM (read-only) · Clock {[
            'internal',
            'BLE',
            'TRS'
          ][syncBaseline.status.clock]}.
          {#if syncBaseline.status.running}
            Stop Puffin on the device to send changes.{/if}
        </p>
      {/if}
      <p class="pattern-sync-help">
        Profile 1 edits the first chord note, velocity, length and mute,
        including all 64 stored steps. Puffin preserves chord tails, chance,
        ratchets, CC locks, gates and swing; they are not shown or backed up by
        this journal. A duplicate chord pitch can be rejected. Device changes
        are checked every 10 seconds while visible; use Read Puffin for an
        immediate check. One companion only, even across BLE/TRS. A full
        four-track send may pause for the device’s 30-second reply cache.
        Initial read adopts device pattern fields; subsequent reads merge
        physical changes. Nothing is sent automatically.
      </p>
    </section>
    {#if message}<div class="notice" role="status">
        <span>{message}</span><button
          aria-label="Dismiss message"
          onclick={() => (message = '')}>×</button
        >
      </div>{/if}
    <footer>
      <span><i></i>{saveStatus}</span><span
        >OFFLINE CAPABLE <span class="footer-dot">/</span> MADE FOR MAKING MUSIC</span
      >
    </footer>
  </main>
</div>
