// core.js — newspeech visualizer infrastructure.
// Loaded by every N-*.html page. Provides the intensity envelope, the
// poisson scheduler, mouse-activity tracking, mic-driven audio analysis
// (opt-in via the "a" key), and two panels: per-page params (toggle "0",
// bottom-right) and shared audio controls (toggle "9", bottom-left).

(function () {
  // ---- shared CSS (injected once) ----
  const css = `
    #panel, #audio-panel {
      position: fixed;
      bottom: 32px;
      padding: 12px 14px 14px;
      background: rgba(10, 10, 10, 0.78);
      border: 1px solid rgba(255, 255, 255, 0.14);
      font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
      font-size: 11px;
      color: rgba(255, 255, 255, 0.9);
      z-index: 10;
      cursor: auto;
      user-select: none;
      backdrop-filter: blur(6px);
      -webkit-backdrop-filter: blur(6px);
    }
    #panel       { right: 32px; width: 260px; }
    #audio-panel { left:  32px; width: 240px; }
    #panel[hidden], #audio-panel[hidden] { display: none; }
    #panel .panel-title, #audio-panel .panel-title {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.10em;
      opacity: 0.55;
      margin-bottom: 4px;
    }
    #audio-panel .audio-state {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.10em;
      opacity: 0.45;
      margin-bottom: 12px;
      cursor: pointer;
    }
    #audio-panel .audio-state.on {
      opacity: 0.95;
      color: rgba(180, 220, 255, 1);
    }
    #panel label, #audio-panel label {
      display: grid;
      grid-template-columns: 1fr auto;
      align-items: baseline;
      gap: 2px 10px;
      margin-bottom: 10px;
    }
    #panel label:last-child { margin-bottom: 0; }
    #panel label .name, #audio-panel label .name { opacity: 0.75; }
    #panel label .val, #audio-panel label .val {
      opacity: 0.5;
      font-variant-numeric: tabular-nums;
      text-align: right;
    }
    #panel input[type="range"], #audio-panel input[type="range"] {
      grid-column: 1 / -1;
      width: 100%;
      margin: 4px 0 0;
      accent-color: rgba(255, 255, 255, 0.75);
    }
    #audio-panel .audio-meters {
      display: grid;
      grid-template-columns: 32px 1fr;
      align-items: center;
      gap: 6px 10px;
      margin-top: 6px;
    }
    #audio-panel .audio-meters .label {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      opacity: 0.55;
    }
    #audio-panel .audio-meters .bar {
      height: 6px;
      background: rgba(255, 255, 255, 0.06);
      border-radius: 1px;
      overflow: hidden;
    }
    #audio-panel .audio-meters .bar > i {
      display: block;
      height: 100%;
      width: 0%;
      background: rgba(255, 255, 255, 0.85);
      transition: width 60ms linear;
    }
    #panel .panel-close {
      position: absolute;
      top: 6px;
      right: 8px;
      background: transparent;
      border: none;
      color: rgba(255, 255, 255, 0.55);
      font-family: inherit;
      font-size: 11px;
      letter-spacing: 0.06em;
      cursor: pointer;
      padding: 4px 6px;
      line-height: 1;
    }
    #panel .panel-close:hover { color: rgba(255, 255, 255, 1); }
    #panel-handle {
      position: fixed;
      bottom: 32px;
      right: 32px;
      padding: 8px 12px;
      background: rgba(10, 10, 10, 0.78);
      border: 1px solid rgba(255, 255, 255, 0.14);
      color: rgba(255, 255, 255, 0.85);
      font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
      font-size: 11px;
      letter-spacing: 0.06em;
      cursor: pointer;
      z-index: 10;
      backdrop-filter: blur(6px);
      -webkit-backdrop-filter: blur(6px);
    }
    #panel-handle[hidden] { display: none; }
    #panel-handle:hover { background: rgba(20, 20, 20, 0.85); }
    /* desktop has the [0] keyboard toggle — only show the tap chrome on mobile. */
    @media (min-width: 721px) {
      #panel .panel-close,
      #panel-handle { display: none !important; }
    }
    /* keyboard-shortcut hints in panel titles disappear on mobile so they
       don't collide with the [x] close button (no keyboard there anyway). */
    @media (max-width: 720px) {
      .panel-title .kbd-hint { display: none; }
    }

    /* display-level filter (grayscale + contrast). composed via a CSS
       variable in core.js so it works on mobile Safari (ctx.filter
       silently no-ops pre-18) and so multiple effects compose cleanly.
       hud-overlay shares the filter so markers + telemetry stay in the
       same monochrome treatment as the visualizer beneath. */
    canvas#bg, canvas#hud-overlay { filter: var(--ns-canvas-filter, none); }
    canvas#hud-overlay {
      position: fixed; inset: 0;
      pointer-events: none;
      z-index: 5;
      display: block;
    }
    #panel .panel-globals {
      margin-top: 12px;
      padding-top: 10px;
      border-top: 1px solid rgba(255, 255, 255, 0.08);
    }
    #panel .panel-grayscale {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.10em;
      opacity: 0.55;
      cursor: pointer;
      margin-bottom: 10px;
    }
    #panel .panel-grayscale.on { opacity: 0.95; color: rgba(180, 220, 255, 1); }
    /* contrast slider — outside <label> so MIDI slot indexing skips it. */
    #panel .panel-row {
      display: grid;
      grid-template-columns: 1fr auto;
      align-items: baseline;
      gap: 2px 10px;
    }
    #panel .panel-row .name { opacity: 0.75; }
    #panel .panel-row .val {
      opacity: 0.5;
      font-variant-numeric: tabular-nums;
      text-align: right;
    }
    #panel .panel-row input[type="range"] {
      grid-column: 1 / -1;
      width: 100%;
      margin: 4px 0 0;
      accent-color: rgba(255, 255, 255, 0.75);
    }

    /* ---- midi mapping ---- */
    #audio-panel .midi-section {
      margin-top: 14px;
      padding-top: 12px;
      border-top: 1px solid rgba(255, 255, 255, 0.08);
    }
    #audio-panel .midi-state {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.10em;
      opacity: 0.45;
      margin-bottom: 8px;
      cursor: pointer;
    }
    #audio-panel .midi-state.on    { opacity: 0.85; color: rgba(180, 220, 255, 1); }
    #audio-panel .midi-state.learn { opacity: 0.95; color: rgba(255, 220, 180, 1); }
    #audio-panel .midi-state.unsupported { opacity: 0.5; cursor: default; }
    #audio-panel .midi-buttons { display: flex; gap: 8px; }
    #audio-panel .midi-btn {
      background: rgba(255, 255, 255, 0.08);
      color: rgba(255, 255, 255, 0.85);
      border: 1px solid rgba(255, 255, 255, 0.18);
      padding: 4px 10px;
      font-family: inherit;
      font-size: 10px;
      letter-spacing: 0.04em;
      cursor: pointer;
    }
    #audio-panel .midi-btn:hover    { background: rgba(255, 255, 255, 0.16); }
    #audio-panel .midi-btn.active   { background: rgba(255, 220, 180, 0.20); color: rgba(255, 220, 180, 1); border-color: rgba(255, 220, 180, 0.45); }

    /* dot after slider name when its slot has a MIDI binding */
    #panel label.midi-mapped .name::after { content: " ●"; font-size: 9px; opacity: 0.55; }
    /* in learn mode, the slider input itself is inert so label clicks select it as target */
    #panel.midi-learn input[type="range"] { pointer-events: none; opacity: 0.6; }
    #panel.midi-learn label { cursor: pointer; border-radius: 2px; }
    #panel.midi-learn label:hover { background: rgba(180, 220, 255, 0.06); }
    #panel label.midi-target {
      outline: 1px solid rgba(255, 220, 180, 0.9);
      outline-offset: 2px;
      background: rgba(255, 220, 180, 0.06);
    }

    /* inline tap-targets in slider names (e.g. [s] next to "telemetry") */
    #panel .ns-shuffle {
      margin-left: 6px;
      opacity: 0.45;
      cursor: pointer;
      font-size: 10px;
      letter-spacing: 0.04em;
    }
    #panel .ns-shuffle:hover { opacity: 0.95; color: rgba(180, 220, 255, 1); }
  `;
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);

  // ---- mouse activity ----
  let _mouseActivity = 0;
  const _config = {
    moveSensitivity: 0.004,
    decay: 1.2,
    intensityMouseWeight: 0.4,
  };

  // ---- audio (mic, opt-in via "a" key) ----
  let _audioCtx = null;
  let _analyser = null;
  let _stream = null;
  let _fftBuf = null;
  let _audioActive = false;
  let _audioPending = false;
  let _audioGain = 1;

  let _audioLevel = 0;
  const _bandLevel = { low: 0, mid: 0, high: 0 };
  const _bandPeak  = { low: 1e-3, mid: 1e-3, high: 1e-3 };
  const _bandCool  = { low: 0, mid: 0, high: 0 };
  const _bandOnset = { low: false, mid: false, high: false };

  const PEAK_DECAY = 0.995;
  const ONSET_RISE = 0.06;
  const ONSET_COOL_MS = 80;

  async function enableAudio() {
    if (_audioActive || _audioPending) return _audioActive;
    _audioPending = true;
    try {
      _stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
      const Ctx = window.AudioContext || window.webkitAudioContext;
      _audioCtx = new Ctx();
      const src = _audioCtx.createMediaStreamSource(_stream);
      _analyser = _audioCtx.createAnalyser();
      _analyser.fftSize = 1024;
      _analyser.smoothingTimeConstant = 0;
      src.connect(_analyser);
      _fftBuf = new Uint8Array(_analyser.frequencyBinCount);
      _stream.getTracks().forEach(t => {
        t.addEventListener("ended", () => {
          if (_audioActive) { disableAudio(); updateAudioStatus(); }
        });
      });
      _audioActive = true;
      return true;
    } catch (e) {
      console.warn("audio enable failed:", e);
      return false;
    } finally {
      _audioPending = false;
    }
  }

  function disableAudio() {
    if (!_audioActive) return;
    if (_stream) _stream.getTracks().forEach(t => t.stop());
    if (_audioCtx) _audioCtx.close().catch(() => {});
    _audioCtx = null;
    _analyser = null;
    _stream = null;
    _fftBuf = null;
    _audioActive = false;
    _audioLevel = 0;
    _bandLevel.low = _bandLevel.mid = _bandLevel.high = 0;
    _bandOnset.low = _bandOnset.mid = _bandOnset.high = false;
  }

  // analyser → smoothed overall + 3-band levels + per-band onset detection.
  // mirrors the live.html analyser tap so existing tuning carries over.
  function tickAudio(dtMs) {
    if (!_audioActive || !_analyser) return;
    _analyser.getByteFrequencyData(_fftBuf);
    const N = _fftBuf.length;
    const lowEnd  = Math.max(1, Math.floor(N * 0.08));
    const midEnd  = Math.max(lowEnd + 1, Math.floor(N * 0.25));
    const highEnd = Math.max(midEnd + 1, Math.floor(N * 0.60));
    let sumAll = 0, sumLow = 0, sumMid = 0, sumHigh = 0;
    for (let i = 0; i < highEnd; i++) {
      const v = _fftBuf[i] / 255;
      sumAll += v;
      if (i < lowEnd) sumLow += v;
      else if (i < midEnd) sumMid += v;
      else sumHigh += v;
    }
    const overall = sumAll / highEnd;
    const low  = sumLow  / lowEnd;
    const mid  = sumMid  / (midEnd - lowEnd);
    const high = sumHigh / (highEnd - midEnd);

    _audioLevel    += (overall - _audioLevel)    * 0.25;
    _bandLevel.low  += (low  - _bandLevel.low)  * 0.35;
    _bandLevel.mid  += (mid  - _bandLevel.mid)  * 0.35;
    _bandLevel.high += (high - _bandLevel.high) * 0.40;

    _bandCool.low  = Math.max(0, _bandCool.low  - dtMs);
    _bandCool.mid  = Math.max(0, _bandCool.mid  - dtMs);
    _bandCool.high = Math.max(0, _bandCool.high - dtMs);
    _bandOnset.low  = _bandCool.low  === 0 && low  > _bandPeak.low  + ONSET_RISE;
    _bandOnset.mid  = _bandCool.mid  === 0 && mid  > _bandPeak.mid  + ONSET_RISE;
    _bandOnset.high = _bandCool.high === 0 && high > _bandPeak.high + ONSET_RISE;
    if (_bandOnset.low)  _bandCool.low  = ONSET_COOL_MS;
    if (_bandOnset.mid)  _bandCool.mid  = ONSET_COOL_MS;
    if (_bandOnset.high) _bandCool.high = ONSET_COOL_MS;
    _bandPeak.low  = Math.max(low,  _bandPeak.low  * PEAK_DECAY);
    _bandPeak.mid  = Math.max(mid,  _bandPeak.mid  * PEAK_DECAY);
    _bandPeak.high = Math.max(high, _bandPeak.high * PEAK_DECAY);

    updateAudioMeters();
  }

  function gain(v) { return Math.min(1, v * _audioGain); }

  function audioActive() { return _audioActive; }
  function audioLevel()  { return _audioActive ? gain(_audioLevel) : 0; }
  function bandLevel(b)  { return _audioActive ? gain(_bandLevel[b] || 0) : 0; }
  function onset(b)      { return _audioActive ? !!_bandOnset[b] : false; }

  function updateAudioStatus() {
    const text = `[a] mic ${_audioActive ? "on" : "off"}`;
    document.querySelectorAll("#audio-panel .audio-state").forEach(s => {
      s.textContent = text;
      s.classList.toggle("on", _audioActive);
    });
  }

  // ---- audio panel (built by core.js, shared across pages) ----
  let _meterEls = null;
  function buildAudioPanel() {
    if (document.getElementById("audio-panel")) return;
    const div = document.createElement("div");
    div.id = "audio-panel";
    div.hidden = true;
    div.innerHTML = `
      <div class="panel-title">audio · <span class="kbd-hint">[9] toggle</span></div>
      <div class="audio-state">[a] mic off</div>
      <label>
        <span class="name">sensitivity</span><span class="val"></span>
        <input type="range" min="0.1" max="5" step="0.05" value="1" data-k="audioGain">
      </label>
      <div class="audio-meters">
        <span class="label">low</span>  <span class="bar"><i data-band="low"></i></span>
        <span class="label">mid</span>  <span class="bar"><i data-band="mid"></i></span>
        <span class="label">high</span> <span class="bar"><i data-band="high"></i></span>
      </div>
      <div class="midi-section">
        <div class="midi-state">[m] midi off — tap learn to enable</div>
        <div class="midi-buttons">
          <button class="midi-btn" data-act="learn" type="button">[learn]</button>
          <button class="midi-btn" data-act="clear" type="button">[clear]</button>
        </div>
      </div>
    `;
    document.body.appendChild(div);

    const slider = div.querySelector('input[data-k="audioGain"]');
    const valEl = slider.parentElement.querySelector(".val");
    const sync = () => {
      _audioGain = parseFloat(slider.value);
      valEl.textContent = _audioGain.toFixed(2) + "×";
    };
    slider.addEventListener("input", sync);
    sync();

    div.querySelector(".audio-state").addEventListener("click", toggleMic);

    div.querySelector('.midi-state').addEventListener("click", () => {
      if (midiSupported()) toggleMidiLearn();
    });
    div.querySelector('.midi-btn[data-act="learn"]').addEventListener("click", toggleMidiLearn);
    div.querySelector('.midi-btn[data-act="clear"]').addEventListener("click", clearMidiMap);

    _meterEls = {
      low:  div.querySelector('i[data-band="low"]'),
      mid:  div.querySelector('i[data-band="mid"]'),
      high: div.querySelector('i[data-band="high"]'),
    };

    refreshMidiUI();
  }
  function updateAudioMeters() {
    const panel = document.getElementById("audio-panel");
    if (!panel || panel.hidden || !_meterEls) return;
    _meterEls.low.style.width  = (gain(_bandLevel.low)  * 100).toFixed(1) + "%";
    _meterEls.mid.style.width  = (gain(_bandLevel.mid)  * 100).toFixed(1) + "%";
    _meterEls.high.style.width = (gain(_bandLevel.high) * 100).toFixed(1) + "%";
  }

  function toggleMic() {
    if (_audioActive) {
      disableAudio();
      updateAudioStatus();
      updateAudioMeters();
    } else {
      enableAudio().then(updateAudioStatus);
    }
  }

  // ---- midi (CC → panel slider, by panel-slot position) ----
  // mapping is global (cc number → slot index) and persisted in localStorage,
  // so the same physical knob drives the same panel slot across visualizers.
  const MIDI_STORAGE_KEY = "newspeech.midi.cc2slot";
  let _midiAccess = null;
  let _midiEnabled = false;
  let _midiLearn = false;
  let _midiLearnSlot = null;     // slot index awaiting next CC twist
  const _ccToSlot = new Map();   // cc number → slot index

  function midiSupported() { return !!navigator.requestMIDIAccess; }

  function loadMidiMap() {
    try {
      const raw = localStorage.getItem(MIDI_STORAGE_KEY);
      if (!raw) return;
      for (const [cc, slot] of JSON.parse(raw)) _ccToSlot.set(Number(cc), Number(slot));
    } catch (_) {}
  }
  function saveMidiMap() {
    try { localStorage.setItem(MIDI_STORAGE_KEY, JSON.stringify([..._ccToSlot.entries()])); }
    catch (_) {}
  }

  async function enableMidi() {
    if (_midiEnabled) return true;
    if (!midiSupported()) return false;
    try {
      _midiAccess = await navigator.requestMIDIAccess({ sysex: false });
      for (const input of _midiAccess.inputs.values()) input.onmidimessage = onMidiMessage;
      _midiAccess.onstatechange = (e) => {
        if (e.port && e.port.type === "input" && e.port.state === "connected") {
          e.port.onmidimessage = onMidiMessage;
        }
      };
      _midiEnabled = true;
      return true;
    } catch (e) {
      console.warn("midi access denied:", e);
      return false;
    }
  }

  function onMidiMessage(e) {
    const [status, d1, d2] = e.data;
    if ((status & 0xf0) !== 0xb0) return; // CC only
    const cc = d1, value = d2;
    if (_midiLearn && _midiLearnSlot != null) {
      // remove any previous mapping that pointed at this slot, so each slot
      // ends up bound to exactly one cc.
      for (const [oldCc, slot] of _ccToSlot.entries()) {
        if (slot === _midiLearnSlot && oldCc !== cc) _ccToSlot.delete(oldCc);
      }
      _ccToSlot.set(cc, _midiLearnSlot);
      saveMidiMap();
      setLearnTarget(null);
      refreshSliderBadges();
      refreshMidiUI();
      return;
    }
    const slot = _ccToSlot.get(cc);
    if (slot == null) return;
    applyToSlot(slot, value / 127);
  }

  function panelSliderInputs() {
    // per-page sliders only — global controls (contrast, etc.) live outside
    // <label> wrappers and carry data-global so MIDI slot indexing skips them.
    const panel = document.getElementById("panel");
    return panel ? panel.querySelectorAll('label input[type="range"]:not([data-global])') : [];
  }

  function applyToSlot(slot, t) {
    const inputs = panelSliderInputs();
    if (slot < 0 || slot >= inputs.length) return;
    const input = inputs[slot];
    const min = parseFloat(input.min);
    const max = parseFloat(input.max);
    const step = parseFloat(input.step) || 1;
    let v = min + (max - min) * t;
    v = Math.round(v / step) * step;
    if (v < min) v = min; else if (v > max) v = max;
    input.value = v;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function setLearnTarget(slot) {
    document.querySelectorAll("#panel label.midi-target").forEach(el => el.classList.remove("midi-target"));
    _midiLearnSlot = slot;
    if (slot == null) return;
    const inputs = panelSliderInputs();
    if (slot < 0 || slot >= inputs.length) return;
    const label = inputs[slot].closest("label");
    if (label) label.classList.add("midi-target");
  }

  function setMidiLearn(on) {
    _midiLearn = !!on;
    const panel = document.getElementById("panel");
    if (panel) panel.classList.toggle("midi-learn", _midiLearn);
    if (!_midiLearn) setLearnTarget(null);
    refreshMidiUI();
  }

  function toggleMidiLearn() {
    if (!midiSupported()) { refreshMidiUI(); return; }
    if (!_midiLearn) {
      enableMidi().then((ok) => {
        if (ok) setMidiLearn(true);
        else refreshMidiUI();
      });
    } else {
      setMidiLearn(false);
    }
  }

  function clearMidiMap() {
    _ccToSlot.clear();
    saveMidiMap();
    refreshSliderBadges();
    refreshMidiUI();
  }

  function refreshSliderBadges() {
    const inputs = panelSliderInputs();
    const mappedSlots = new Set(_ccToSlot.values());
    for (let i = 0; i < inputs.length; i++) {
      const label = inputs[i].closest("label");
      if (!label) continue;
      label.classList.toggle("midi-mapped", mappedSlots.has(i));
    }
  }

  function refreshMidiUI() {
    const stateEl = document.querySelector("#audio-panel .midi-state");
    if (!stateEl) return;
    const learnBtn = document.querySelector('#audio-panel .midi-btn[data-act="learn"]');
    stateEl.classList.remove("on", "learn", "unsupported");
    if (!midiSupported()) {
      stateEl.textContent = "midi unsupported in this browser";
      stateEl.classList.add("unsupported");
    } else if (!_midiEnabled) {
      stateEl.textContent = "[m] midi off — tap learn to enable";
    } else if (_midiLearn) {
      let target = "click a slider";
      if (_midiLearnSlot != null) {
        const inputs = panelSliderInputs();
        const input = inputs[_midiLearnSlot];
        const label = input && input.closest("label");
        const nameEl = label && label.querySelector(".name");
        const name = nameEl ? nameEl.textContent.replace(/\s*●\s*$/, "").trim() : `slot ${_midiLearnSlot + 1}`;
        target = `${name} — twist a knob`;
      }
      stateEl.textContent = `[m] learn: ${target}`;
      stateEl.classList.add("learn");
    } else {
      const n = _ccToSlot.size;
      stateEl.textContent = `[m] midi ready · ${n} knob${n === 1 ? "" : "s"} mapped`;
      stateEl.classList.add("on");
    }
    if (learnBtn) learnBtn.classList.toggle("active", _midiLearn);
  }

  function wirePanelSlots(panel) {
    // tag each slider's <label> with its slot index and intercept clicks while
    // in learn mode so the click selects that label as the next learn target.
    const labels = [];
    panel.querySelectorAll("label").forEach((label) => {
      if (label.querySelector('input[type="range"]')) labels.push(label);
    });
    labels.forEach((label, i) => {
      label.dataset.slot = i;
      if (label.dataset.midiWired === "1") return;
      label.dataset.midiWired = "1";
      label.addEventListener("click", (e) => {
        if (!_midiLearn) return;
        e.preventDefault();
        e.stopPropagation();
        setLearnTarget(i);
      }, true);
    });
  }

  // ---- display filter (grayscale + contrast) ----
  // composed via CSS var on <html> so it works on mobile Safari (ctx.filter
  // silently no-ops pre-18) and so the two effects layer cleanly. Both states
  // persisted across reloads; grayscale defaults ON, contrast defaults 1.0.
  const GRAYSCALE_KEY = "newspeech.grayscale";
  const CONTRAST_KEY  = "newspeech.contrast";
  let _grayscale = true;
  let _contrast  = 1;
  function loadGrayscale() {
    try {
      const raw = localStorage.getItem(GRAYSCALE_KEY);
      if (raw === "0") _grayscale = false;
    } catch (_) {}
  }
  function loadContrast() {
    try {
      const raw = localStorage.getItem(CONTRAST_KEY);
      if (raw != null) {
        const v = parseFloat(raw);
        if (isFinite(v) && v > 0) _contrast = v;
      }
    } catch (_) {}
  }
  function rebuildCanvasFilter() {
    const parts = [];
    if (_grayscale) parts.push("grayscale(1)");
    if (Math.abs(_contrast - 1) > 0.001) parts.push(`contrast(${_contrast})`);
    document.documentElement.style.setProperty(
      "--ns-canvas-filter", parts.length ? parts.join(" ") : "none"
    );
  }
  function applyGrayscale() {
    document.querySelectorAll("#panel .panel-grayscale").forEach(el => {
      el.textContent = `grayscale: ${_grayscale ? "on" : "off"}`;
      el.classList.toggle("on", _grayscale);
    });
    rebuildCanvasFilter();
  }
  function applyContrast() {
    document.querySelectorAll("#panel .panel-contrast input").forEach(input => {
      if (parseFloat(input.value) !== _contrast) input.value = _contrast;
    });
    document.querySelectorAll("#panel .panel-contrast .val").forEach(el => {
      el.textContent = _contrast.toFixed(2);
    });
    rebuildCanvasFilter();
  }
  function toggleGrayscale() {
    _grayscale = !_grayscale;
    try { localStorage.setItem(GRAYSCALE_KEY, _grayscale ? "1" : "0"); } catch (_) {}
    applyGrayscale();
  }
  function setContrast(v) {
    if (!isFinite(v) || v <= 0) return;
    _contrast = v;
    try { localStorage.setItem(CONTRAST_KEY, String(_contrast)); } catch (_) {}
    applyContrast();
  }

  // ---- HUD overlay canvas (shared by markers + telemetry) ----
  // separate canvas stacked above #bg so HUD pixels don't end up in the
  // visualizer's render pipeline. critical for pages that fade trails on
  // the main canvas (9-swarm) — without this, the canvas-fallback sobel
  // reads its own marker text as edges and markers stop tracking.
  let _hudCanvas = null;
  let _hudCtx = null;
  function _ensureHud() {
    const bg = document.getElementById("bg");
    if (!bg || bg.width === 0) return null;
    if (!_hudCanvas) {
      _hudCanvas = document.createElement("canvas");
      _hudCanvas.id = "hud-overlay";
      document.body.appendChild(_hudCanvas);
      _hudCtx = _hudCanvas.getContext("2d");
    }
    if (_hudCanvas.width !== bg.width) _hudCanvas.width = bg.width;
    if (_hudCanvas.height !== bg.height) _hudCanvas.height = bg.height;
    if (_hudCanvas.style.width !== bg.style.width) _hudCanvas.style.width = bg.style.width;
    if (_hudCanvas.style.height !== bg.style.height) _hudCanvas.style.height = bg.style.height;
    return _hudCanvas;
  }

  // ---- markers (source-driven overlay) ----
  // shared infra: small sobel pass on whatever video/image element the page
  // exposes via getSource/getSourceDims, sample high-magnitude pixels into a
  // marker pool, snap each marker to the local edge center-of-mass each frame
  // (so markers track features as the source moves), draw nearest-neighbor
  // connector lines + [xyz] labels on top of #bg.
  const MARKER_SOBEL_LONG = 480;
  let _mkSw = 0, _mkSh = 0;
  let _mkOff = null, _mkOffCtx = null;
  let _mkGray = null, _mkMag = null;
  const _markers = [];
  let _markerCooldown = 0;
  let _markerLastSrc = null;
  let _markerParams = null;
  let _markerGetSource = null;
  let _markerGetDims = null;
  let _markerGetEdgeData = null;

  const _LABEL_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";
  function _randLabel() {
    let s = "";
    for (let i = 0; i < 3; i++) s += _LABEL_CHARS[(Math.random() * _LABEL_CHARS.length) | 0];
    return `[${s}]`;
  }

  function _ensureMarkerBuffers(srcW, srcH) {
    const scale = MARKER_SOBEL_LONG / Math.max(srcW, srcH);
    const sw = Math.max(2, Math.floor(srcW * scale));
    const sh = Math.max(2, Math.floor(srcH * scale));
    if (sw === _mkSw && sh === _mkSh && _mkOff) return;
    _mkSw = sw; _mkSh = sh;
    _mkOff = document.createElement("canvas");
    _mkOff.width = sw; _mkOff.height = sh;
    _mkOffCtx = _mkOff.getContext("2d", { willReadFrequently: true });
    const n = sw * sh;
    _mkGray = new Float32Array(n);
    _mkMag = new Float32Array(n);
  }

  function _computeMarkerSobel(srcEl) {
    _mkOffCtx.drawImage(srcEl, 0, 0, _mkSw, _mkSh);
    const { data } = _mkOffCtx.getImageData(0, 0, _mkSw, _mkSh);
    const g = _mkGray;
    for (let i = 0, j = 0; i < g.length; i++, j += 4) {
      g[i] = (data[j] * 0.299 + data[j+1] * 0.587 + data[j+2] * 0.114) / 255;
    }
    const mag = _mkMag;
    let maxMag = 1e-6;
    for (let i = 0; i < mag.length; i++) mag[i] = 0;
    for (let y = 1; y < _mkSh - 1; y++) {
      for (let x = 1; x < _mkSw - 1; x++) {
        const i = y * _mkSw + x;
        const a = g[i - _mkSw - 1], b = g[i - _mkSw], c = g[i - _mkSw + 1];
        const d = g[i - 1],                            f = g[i + 1];
        const e = g[i + _mkSw - 1], h = g[i + _mkSw], k = g[i + _mkSw + 1];
        const gx = -a + c - 2 * d + 2 * f - e + k;
        const gy = -a - 2 * b - c + e + 2 * h + k;
        const m = Math.hypot(gx, gy);
        mag[i] = m;
        if (m > maxMag) maxMag = m;
      }
    }
    // normalize against 95th-percentile magnitude so contrast stays sane
    // across very different source images.
    const sample = [];
    for (let i = 0; i < mag.length; i += 5) if (mag[i] > 0) sample.push(mag[i]);
    sample.sort((a, b) => a - b);
    const norm = sample.length ? sample[Math.floor(sample.length * 0.95)] : maxMag;
    const inv = 1 / Math.max(1e-6, norm);
    for (let i = 0; i < mag.length; i++) {
      const v = mag[i] * inv;
      mag[i] = v > 1 ? 1 : v;
    }
  }

  function _pickMarkerEdgePoint() {
    if (!_mkMag || _mkMag.length === 0) return null;
    let bestIdx = -1, bestMag = 0;
    for (let i = 0; i < 60; i++) {
      const idx = (Math.random() * _mkMag.length) | 0;
      if (_mkMag[idx] > bestMag) { bestMag = _mkMag[idx]; bestIdx = idx; }
    }
    if (bestIdx < 0 || bestMag < 0.25) return null;
    return { sx: bestIdx % _mkSw, sy: (bestIdx / _mkSw) | 0 };
  }

  function _snapMarker(m, dt) {
    const radius = 6;
    const cx = m.sx | 0, cy = m.sy | 0;
    const x0 = Math.max(1, cx - radius), x1 = Math.min(_mkSw - 2, cx + radius);
    const y0 = Math.max(1, cy - radius), y1 = Math.min(_mkSh - 2, cy + radius);
    let sumW = 0, sumX = 0, sumY = 0;
    for (let y = y0; y <= y1; y++) {
      const row = y * _mkSw;
      for (let x = x0; x <= x1; x++) {
        const v = _mkMag[row + x];
        if (v > 0.2) {
          const w = v * v;
          sumW += w; sumX += w * x; sumY += w * y;
        }
      }
    }
    if (sumW > 0) {
      const tx = sumX / sumW, ty = sumY / sumW;
      const k = Math.min(1, dt * 18);
      m.sx += (tx - m.sx) * k;
      m.sy += (ty - m.sy) * k;
      m.lostTime = 0;
    } else {
      m.lostTime += dt;
      if (m.lostTime > 0.3) m.life = Math.min(m.life, m.age + 0.3);
    }
  }

  function _updateMarkers(dt, cw, ch, dims) {
    const target = _markerParams ? (_markerParams.dataPoints | 0) : 0;
    if (_mkMag) for (const m of _markers) _snapMarker(m, dt);
    for (let i = _markers.length - 1; i >= 0; i--) {
      const m = _markers[i];
      m.age += dt;
      if (m.age > m.life) _markers.splice(i, 1);
    }
    while (_markers.length > target) {
      let oldest = 0;
      for (let i = 1; i < _markers.length; i++) if (_markers[i].age > _markers[oldest].age) oldest = i;
      _markers.splice(oldest, 1);
    }
    _markerCooldown -= dt;
    while (_markers.length < target && _markerCooldown <= 0) {
      const p = _pickMarkerEdgePoint();
      if (!p) break;
      _markers.push({
        sx: p.sx, sy: p.sy,
        label: _randLabel(),
        age: 0,
        life: 5 + Math.random() * 7,
        fadeIn: 0.4,
        lostTime: 0,
      });
      _markerCooldown = 0.06;
    }
    const scale = Math.max(cw / dims.w, ch / dims.h);
    const drawW = dims.w * scale, drawH = dims.h * scale;
    const offX = (cw - drawW) * 0.5, offY = (ch - drawH) * 0.5;
    const fx = drawW / _mkSw, fy = drawH / _mkSh;
    for (const m of _markers) {
      m.x = offX + (m.sx + 0.5) * fx;
      m.y = offY + (m.sy + 0.5) * fy;
    }
  }

  function _drawMarkers(ctx) {
    if (_markers.length === 0) return;
    const cw = ctx.canvas.width, ch = ctx.canvas.height;
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const fontSize = Math.round(11 * dpr);
    const maxLineDist = Math.hypot(cw, ch) * 0.28;
    const maxLineDist2 = maxLineDist * maxLineDist;

    ctx.save();
    // standalone visualizers apply ctx.setTransform(dpr, ...) for logical-px
    // drawing and may leave text/composite state set (e.g. 5-stars uses
    // textAlign="center") — normalize all of it so the HUD always renders
    // at left-anchored device-px space regardless of what the page did.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.font = `${fontSize}px ui-monospace, "SF Mono", Menlo, monospace`;
    ctx.textBaseline = "top";
    ctx.textAlign = "left";
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";

    ctx.strokeStyle = "rgba(255, 255, 255, 0.28)";
    ctx.lineWidth = Math.max(1, dpr * 0.75);
    ctx.beginPath();
    for (let i = 0; i < _markers.length; i++) {
      const a = _markers[i];
      let bestJ = -1, bestD = Infinity;
      for (let j = 0; j < _markers.length; j++) {
        if (j === i) continue;
        const dx = _markers[j].x - a.x;
        const dy = _markers[j].y - a.y;
        const d = dx * dx + dy * dy;
        if (d < bestD) { bestD = d; bestJ = j; }
      }
      if (bestJ >= 0 && bestD <= maxLineDist2) {
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(_markers[bestJ].x, _markers[bestJ].y);
      }
    }
    ctx.stroke();

    for (const m of _markers) {
      const tIn = Math.min(1, m.age / m.fadeIn);
      const remain = 1 - m.age / m.life;
      const fade = Math.min(tIn, Math.min(1, remain * 4));
      ctx.fillStyle = `rgba(255, 255, 255, ${0.85 * fade})`;
      ctx.beginPath();
      ctx.arc(m.x, m.y, 2 * dpr, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = `rgba(255, 255, 255, ${0.7 * fade})`;
      ctx.fillText(m.label, m.x + 5 * dpr, m.y + 5 * dpr);
    }
    ctx.restore();
  }

  function installMarkers(opts) {
    if (!opts) return;
    // when getSource is omitted, tickMarkers falls back to sobeling the
    // canvas itself — lets the standalone visualizers anchor markers to
    // bright pixels in their own rendered output.
    _markerGetSource = opts.getSource || null;
    _markerGetDims = opts.getSourceDims || null;
    // optional: page already runs its own sobel (10-edges, 12-edgemask) and
    // can hand its buffer over to skip the duplicate readback. should return
    // { mag: Float32Array, w: int, h: int } or null when not yet computed.
    _markerGetEdgeData = opts.getEdgeData || null;
    _markerParams = opts.params || {};
    if (_markerParams.dataPoints == null) _markerParams.dataPoints = 0;
    // auto-inject the data-points slider into #panel (before .panel-globals
    // if present, otherwise at the end). pages don't need to declare it.
    const panel = document.getElementById("panel");
    if (panel && !panel.querySelector('input[data-k="dataPoints"]')) {
      const label = document.createElement("label");
      label.innerHTML =
        '<span class="name">data points</span><span class="val"></span>' +
        '<input type="range" min="0" max="128" step="1" data-k="dataPoints">';
      const globals = panel.querySelector(".panel-globals");
      if (globals) panel.insertBefore(label, globals);
      else panel.appendChild(label);
    }
  }

  function tickMarkers(dt) {
    if (!_markerParams) return;
    const canvas = document.getElementById("bg");
    if (!canvas || canvas.width === 0) return;
    let src = _markerGetSource ? _markerGetSource() : null;
    let dims = _markerGetDims ? _markerGetDims() : null;
    let usingCanvas = false;
    if (!src || !dims || !dims.w || !dims.h) {
      // canvas-fallback: sobel whatever the page just rendered. tickMarkers
      // is called at end of render, so the canvas already has this frame's
      // visualizer content but no markers yet (last frame's markers were
      // wiped by the visualizer's redraw).
      src = canvas;
      dims = { w: canvas.width, h: canvas.height };
      usingCanvas = true;
    }
    const sourceChanged = src !== _markerLastSrc;
    if (sourceChanged) {
      _markers.length = 0;
      _markerLastSrc = src;
    }
    if (_markerGetEdgeData && !usingCanvas) {
      const e = _markerGetEdgeData();
      if (!e || !e.mag) return;
      _mkMag = e.mag;
      _mkSw = e.w;
      _mkSh = e.h;
    } else if (usingCanvas) {
      _ensureMarkerBuffers(dims.w, dims.h);
      _computeMarkerSobel(src);
    } else {
      if (sourceChanged) {
        _ensureMarkerBuffers(dims.w, dims.h);
        _computeMarkerSobel(src);
      } else if (src.tagName === "VIDEO" && src.readyState >= 2 && !src.paused) {
        _computeMarkerSobel(src);
      }
    }
    _updateMarkers(dt, canvas.width, canvas.height, dims);
    // draw markers on the HUD overlay (cleared each frame in tickInputs)
    // rather than directly on #bg, so they don't pollute the canvas the
    // fallback sobel reads on the next frame.
    const hud = _ensureHud();
    if (!hud) return;
    _drawMarkers(_hudCtx);
  }

  // ---- telemetry (top-left HUD overlay) ----
  // pinned vertical stack of small monospace widgets that render a
  // surveillance-feed look. each widget reads live core.js signals (band
  // levels, intensity, audio level) when available and synthesizes plausible
  // "documentation" content otherwise. layout is fixed: slot order is
  // bands → waveform → coords → xfer → events → coords (extra). slider
  // controls how many slots are visible from the top.
  const TELEMETRY_PAD_TOP = 28;
  const TELEMETRY_PAD_LEFT = 32;
  const TELEMETRY_GAP = 18;
  const TELEMETRY_LAYOUT = ["bands", "waveform", "coords", "xfer", "events", "hex"];
  const _telemetryOrder = [...TELEMETRY_LAYOUT];
  const _telemetrySlots = [];
  let _telemetryParams = null;

  function _bandLive(b, t) {
    const real = bandLevel(b);
    if (real > 0.001) return Math.min(1, real);
    if (b === "low")  return Math.max(0, 0.30 + 0.25 * Math.sin(t / 1100));
    if (b === "mid")  return Math.max(0, 0.40 + 0.30 * Math.sin(t / 800 + 1));
    return                  Math.max(0, 0.35 + 0.25 * Math.sin(t / 600 + 2));
  }
  function _audioLive(t) {
    const real = audioLevel();
    if (real > 0.001) return Math.min(1, real);
    return Math.max(0, 0.35 + 0.20 * Math.sin(t / 950));
  }
  function _hexLine(len) {
    const c = "0123456789abcdef";
    let s = "";
    for (let i = 0; i < len; i++) s += c[(Math.random() * 16) | 0];
    return s;
  }
  function _padBar(level, width) {
    const filled = Math.max(0, Math.min(width, Math.round(level * width)));
    return "█".repeat(filled) + "░".repeat(width - filled);
  }
  function _drawHeader(ctx, text, x, y, dpr) {
    ctx.font = `${Math.round(9 * dpr)}px ui-monospace, "SF Mono", Menlo, monospace`;
    ctx.fillStyle = "rgba(255, 255, 255, 0.45)";
    ctx.fillText(text, x, y);
  }
  function _bodyFont(ctx, dpr) {
    ctx.font = `${Math.round(10 * dpr)}px ui-monospace, "SF Mono", Menlo, monospace`;
  }

  function _makeBands() {
    return {
      type: "bands",
      tick(dt) {},
      render(ctx, x, y, dpr) {
        const t = performance.now();
        const headerH = Math.round(11 * dpr);
        const lineH   = Math.round(13 * dpr);
        _drawHeader(ctx, "BAND.LMH", x, y, dpr);
        let yy = y + headerH + Math.round(4 * dpr);
        _bodyFont(ctx, dpr);
        ctx.fillStyle = "rgba(255, 255, 255, 0.78)";
        const bands = ["low", "mid", "high"];
        const labels = ["LO", "MD", "HI"];
        for (let i = 0; i < 3; i++) {
          const v = _bandLive(bands[i], t);
          ctx.fillText(`${labels[i]} ${v.toFixed(2)} ${_padBar(v, 14)}`, x, yy);
          yy += lineH;
        }
        return yy - y;
      },
    };
  }

  function _makeWaveform() {
    const N = 32;
    const samples = new Float32Array(N);
    let idx = 0, lastTick = 0;
    return {
      type: "waveform",
      tick(dt) {},
      render(ctx, x, y, dpr) {
        const now = performance.now();
        if (now - lastTick > 35) {
          lastTick = now;
          samples[idx] = _audioLive(now);
          idx = (idx + 1) % N;
        }
        const headerH = Math.round(11 * dpr);
        _drawHeader(ctx, "WAVEFORM.RT", x, y, dpr);
        const yy = y + headerH + Math.round(4 * dpr);
        const barH = Math.round(28 * dpr);
        const barW = Math.max(2, Math.floor(2 * dpr));
        const gap  = Math.max(1, Math.floor(1 * dpr));
        ctx.fillStyle = "rgba(255, 255, 255, 0.75)";
        for (let i = 0; i < N; i++) {
          const v = samples[(idx + i) % N];
          const h = Math.max(1, Math.round(v * barH));
          ctx.fillRect(x + i * (barW + gap), yy + barH - h, barW, h);
        }
        return headerH + Math.round(4 * dpr) + barH;
      },
    };
  }

  function _makeCoords() {
    const N = 3;
    const seeds = [];
    for (let i = 0; i < N; i++) {
      seeds.push({
        lat: (Math.random() - 0.5) * 160,
        lon: (Math.random() - 0.5) * 360,
        driftLat: (Math.random() - 0.5) * 0.0006,
        driftLon: (Math.random() - 0.5) * 0.0006,
        id: _hexLine(6).toUpperCase(),
      });
    }
    return {
      type: "coords",
      tick(dt) {
        for (const s of seeds) {
          s.lat += s.driftLat * dt * 60;
          s.lon += s.driftLon * dt * 60;
          if (Math.random() < dt * 0.04) s.id = _hexLine(6).toUpperCase();
        }
      },
      render(ctx, x, y, dpr) {
        const headerH = Math.round(11 * dpr);
        const lineH   = Math.round(13 * dpr);
        _drawHeader(ctx, "COORDS.LIVE", x, y, dpr);
        let yy = y + headerH + Math.round(4 * dpr);
        _bodyFont(ctx, dpr);
        ctx.fillStyle = "rgba(255, 255, 255, 0.78)";
        for (const s of seeds) {
          const latDir = s.lat >= 0 ? "N" : "S";
          const lonDir = s.lon >= 0 ? "E" : "W";
          const lat = Math.abs(s.lat).toFixed(4);
          const lon = Math.abs(s.lon).toFixed(4);
          ctx.fillText(`${s.id}  ${lat}° ${latDir}  ${lon}° ${lonDir}`, x, yy);
          yy += lineH;
        }
        return yy - y;
      },
    };
  }

  const _XFER_NAMES = ["frame.dat", "spectro.bin", "feed.cap", "stream.tap", "drone.fix", "raw.idx", "tile.lz4", "thumb.idx", "vox.q"];
  function _makeXfer() {
    const transfers = [];
    function newXfer() {
      const base = _XFER_NAMES[(Math.random() * _XFER_NAMES.length) | 0];
      return {
        name: `${base}.${_hexLine(4)}`,
        progress: 0,
        total: 1 + Math.random() * 12,
        rate: 0.4 + Math.random() * 1.8,
      };
    }
    transfers.push(newXfer(), newXfer());
    return {
      type: "xfer",
      tick(dt) {
        for (let i = 0; i < transfers.length; i++) {
          transfers[i].progress += transfers[i].rate * dt;
          if (transfers[i].progress >= transfers[i].total) transfers[i] = newXfer();
        }
      },
      render(ctx, x, y, dpr) {
        const headerH = Math.round(11 * dpr);
        const lineH   = Math.round(13 * dpr);
        _drawHeader(ctx, "XFER.QUEUE", x, y, dpr);
        let yy = y + headerH + Math.round(4 * dpr);
        _bodyFont(ctx, dpr);
        ctx.fillStyle = "rgba(255, 255, 255, 0.78)";
        for (const t of transfers) {
          const pct = Math.min(1, t.progress / t.total);
          const bar = _padBar(pct, 12);
          const pctStr = `${(pct * 100).toFixed(0).padStart(3, " ")}%`;
          const nameClipped = t.name.slice(0, 18).padEnd(18, " ");
          ctx.fillText(`${nameClipped} ${bar} ${pctStr}`, x, yy);
          yy += lineH;
        }
        return yy - y;
      },
    };
  }

  const _EVT_LEVELS  = ["INF", "WRN", "DBG", "TRC"];
  const _EVT_MODULES = ["sig", "frame", "tap", "iface", "vfx", "drv", "ctl", "buf", "asy", "io", "px"];
  const _EVT_VERBS   = ["captured", "scheduled", "ack", "flushed", "queued", "stalled", "rebound",
                        "dispatched", "subscribed", "synced", "expired", "rotated", "verified", "tapped"];
  // EP title + track titles seeded into the event stream as decoded payloads.
  // sometimes whole titles surface, sometimes single words, sometimes
  // recombined word fragments — mirrors how a surveillance feed would only
  // catch coherent strings intermittently.
  const _RELEASE_ALBUM = "HOW STRANGE TO BE ANYTHING";
  const _RELEASE_TRACKS = [
    "Solutions for Modern Culting",
    "Sinewaves at The Scope",
    "Subset Field Error",
    "Concrete Crown / Metanoia",
    "Vacation to French Hospitals",
  ];
  const _RELEASE_WORDS = (() => {
    const set = new Set();
    const all = [_RELEASE_ALBUM, ..._RELEASE_TRACKS].join(" ");
    for (const w of all.split(/\s+/)) {
      const c = w.replace(/[^A-Za-z]/g, "");
      if (c.length >= 2) set.add(c);
    }
    return [...set];
  })();
  function _pickReleaseFragment() {
    const r = Math.random();
    if (r < 0.60) {
      return _RELEASE_WORDS[(Math.random() * _RELEASE_WORDS.length) | 0];
    } else if (r < 0.85) {
      const n = 2 + ((Math.random() * 2) | 0);
      const parts = [];
      for (let i = 0; i < n; i++) parts.push(_RELEASE_WORDS[(Math.random() * _RELEASE_WORDS.length) | 0]);
      return parts.join(" ");
    } else if (r < 0.97) {
      return _RELEASE_TRACKS[(Math.random() * _RELEASE_TRACKS.length) | 0];
    } else {
      return _RELEASE_ALBUM;
    }
  }
  function _makeEvents() {
    const lines = [];
    let lastSpawn = performance.now();
    function timeStr(ms) {
      const d = new Date(ms);
      const hh = String(d.getHours()).padStart(2, "0");
      const mm = String(d.getMinutes()).padStart(2, "0");
      const ss = String(d.getSeconds()).padStart(2, "0");
      const sss = String(d.getMilliseconds()).padStart(3, "0");
      return `${hh}:${mm}:${ss}.${sss}`;
    }
    function newLine() {
      // ~30% of new lines surface "decoded" content drawn from the release
      // word pool (single words, short fragments, full titles, occasionally
      // the album title as a top-priority match).
      if (Math.random() < 0.30) {
        const frag = _pickReleaseFragment();
        const isAlbum = frag === _RELEASE_ALBUM;
        const lvl = isAlbum ? "ERR" : (Math.random() < 0.5 ? "INF" : "TRC");
        const verb = isAlbum
          ? "match.album"
          : (Math.random() < 0.45 ? "match.signature" : "dec.payload");
        return `${timeStr(Date.now())} ${lvl} ${verb}="${frag}"`;
      }
      const lvl = _EVT_LEVELS[(Math.random() * _EVT_LEVELS.length) | 0];
      const mod = _EVT_MODULES[(Math.random() * _EVT_MODULES.length) | 0];
      const verb = _EVT_VERBS[(Math.random() * _EVT_VERBS.length) | 0];
      return `${timeStr(Date.now())} ${lvl} ${mod}.${verb} ${_hexLine(8)}`;
    }
    for (let i = 0; i < 7; i++) lines.push(newLine());
    return {
      type: "events",
      tick(dt) {
        const now = performance.now();
        const env = intensity();
        const interval = 600 - env * 380; // 220-600ms
        if (now - lastSpawn > interval) {
          lastSpawn = now;
          lines.push(newLine());
          while (lines.length > 7) lines.shift();
        }
      },
      render(ctx, x, y, dpr) {
        const headerH = Math.round(11 * dpr);
        const lineH   = Math.round(12 * dpr);
        _drawHeader(ctx, "EVENTS.STREAM", x, y, dpr);
        let yy = y + headerH + Math.round(4 * dpr);
        _bodyFont(ctx, dpr);
        for (let i = 0; i < lines.length; i++) {
          const fade = 0.30 + 0.55 * (i / Math.max(1, lines.length - 1));
          ctx.fillStyle = `rgba(255, 255, 255, ${fade.toFixed(2)})`;
          ctx.fillText(lines[i], x, yy);
          yy += lineH;
        }
        return yy - y;
      },
    };
  }

  function _makeHex() {
    const ROWS = 6;
    const COLS = 16;
    const bytes = new Uint8Array(ROWS * COLS);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (Math.random() * 256) | 0;
    let baseAddr = (Math.random() * 0xffff0) & 0xffff0;
    let lastShift = performance.now();
    return {
      type: "hex",
      tick(dt) {
        // mutate a fraction of bytes each frame so the dump reads like
        // memory being scanned, not random noise
        const churn = Math.max(1, Math.round(bytes.length * dt * 0.6));
        for (let k = 0; k < churn; k++) {
          bytes[(Math.random() * bytes.length) | 0] = (Math.random() * 256) | 0;
        }
        const now = performance.now();
        if (now - lastShift > 1800) {
          lastShift = now;
          baseAddr = (baseAddr + 0x10) & 0xffffff;
        }
      },
      render(ctx, x, y, dpr) {
        const headerH = Math.round(11 * dpr);
        const lineH   = Math.round(12 * dpr);
        _drawHeader(ctx, "MEM.DUMP", x, y, dpr);
        let yy = y + headerH + Math.round(4 * dpr);
        _bodyFont(ctx, dpr);
        ctx.fillStyle = "rgba(255, 255, 255, 0.78)";
        for (let r = 0; r < ROWS; r++) {
          const addr = ((baseAddr + r * COLS) & 0xffffff).toString(16).padStart(6, "0");
          let line = `${addr}:`;
          for (let c = 0; c < COLS; c++) {
            line += " " + bytes[r * COLS + c].toString(16).padStart(2, "0");
          }
          ctx.fillText(line, x, yy);
          yy += lineH;
        }
        return yy - y;
      },
    };
  }

  function _makeTelemetrySlot(type) {
    if (type === "bands")    return _makeBands();
    if (type === "waveform") return _makeWaveform();
    if (type === "coords")   return _makeCoords();
    if (type === "xfer")     return _makeXfer();
    if (type === "events")   return _makeEvents();
    if (type === "hex")      return _makeHex();
    return null;
  }

  function _telemetryEnsureSlots() {
    if (!_telemetryParams) return;
    const max = _telemetryOrder.length;
    const count = Math.max(0, Math.min(max, _telemetryParams.telemetry | 0));
    while (_telemetrySlots.length < count) {
      const i = _telemetrySlots.length;
      _telemetrySlots.push(_makeTelemetrySlot(_telemetryOrder[i]));
    }
    while (_telemetrySlots.length > count) _telemetrySlots.pop();
  }

  function shuffleTelemetry() {
    for (let i = _telemetryOrder.length - 1; i > 0; i--) {
      const j = (Math.random() * (i + 1)) | 0;
      const tmp = _telemetryOrder[i]; _telemetryOrder[i] = _telemetryOrder[j]; _telemetryOrder[j] = tmp;
    }
    // drop existing slots so they rebuild against the new order — also
    // refreshes widget state, which reads as a fresh capture
    _telemetrySlots.length = 0;
  }

  function installTelemetry(opts) {
    _telemetryParams = (opts && opts.params) || {};
    if (_telemetryParams.telemetry == null) _telemetryParams.telemetry = 0;
    const panel = document.getElementById("panel");
    if (panel && !panel.querySelector('input[data-k="telemetry"]')) {
      const label = document.createElement("label");
      label.innerHTML =
        '<span class="name">telemetry<span class="ns-shuffle" role="button" title="shuffle order">[s]</span></span><span class="val"></span>' +
        `<input type="range" min="0" max="${TELEMETRY_LAYOUT.length}" step="1" data-k="telemetry">`;
      const shuffleBtn = label.querySelector(".ns-shuffle");
      shuffleBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        shuffleTelemetry();
      });
      const globals = panel.querySelector(".panel-globals");
      if (globals) panel.insertBefore(label, globals);
      else panel.appendChild(label);
    }
  }

  function tickTelemetry(dt) {
    if (!_telemetryParams) return;
    _telemetryEnsureSlots();
    if (_telemetrySlots.length === 0) return;
    const hud = _ensureHud();
    if (!hud) return;
    const ctx = _hudCtx;
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    ctx.save();
    // standalone visualizers apply ctx.setTransform(dpr, ...) for logical-px
    // drawing and may leave text/composite state set (e.g. 5-stars uses
    // textAlign="center") — normalize all of it so the HUD always renders
    // at left-anchored device-px space regardless of what the page did.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.textBaseline = "top";
    ctx.textAlign = "left";
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    let y = TELEMETRY_PAD_TOP * dpr;
    const x = TELEMETRY_PAD_LEFT * dpr;
    for (const slot of _telemetrySlots) {
      slot.tick(dt);
      const h = slot.render(ctx, x, y, dpr);
      y += h + TELEMETRY_GAP * dpr;
    }
    ctx.restore();
  }

  function intensity() {
    if (_audioActive) return gain(_audioLevel);
    const t = performance.now();
    const sum = 0.5
      + 0.25 * Math.sin(t / 17000)
      + 0.18 * Math.sin(t / 31000)
      + 0.12 * Math.sin(t / 47000);
    return Math.max(0, Math.min(1, sum + _mouseActivity * _config.intensityMouseWeight));
  }

  function poisson(rateFn, fire) {
    function step() {
      const ratePerMs = Math.max(0.0001, rateFn()) / 1000;
      const wait = -Math.log(1 - Math.random()) / ratePerMs;
      setTimeout(() => { fire(); step(); }, wait);
    }
    step();
  }

  function installInputs(opts) {
    Object.assign(_config, opts || {});
    let lastX = -1e4, lastY = -1e4;
    window.addEventListener("mousemove", (e) => {
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      const dist = Math.hypot(dx, dy);
      lastX = e.clientX;
      lastY = e.clientY;
      _mouseActivity = Math.min(1, _mouseActivity + dist * _config.moveSensitivity);
    });
  }

  function tickInputs(dt) {
    _mouseActivity = Math.max(0, _mouseActivity - _config.decay * dt);
    if (_audioActive) tickAudio(dt * 1000);
    // clear the HUD overlay once per frame at the top so subsequent
    // tickMarkers/tickTelemetry calls render on a fresh surface.
    if (_hudCanvas && _hudCtx) {
      _hudCtx.save();
      _hudCtx.setTransform(1, 0, 0, 1, 0, 0);
      _hudCtx.clearRect(0, 0, _hudCanvas.width, _hudCanvas.height);
      _hudCtx.restore();
    }
  }

  function bumpActivity(target) {
    const t = target == null ? 1 : target;
    _mouseActivity = Math.min(1, Math.max(_mouseActivity, t));
  }

  // panel close [x] + reopen handle — keyboard `0` works on desktop, but
  // mobile users need a tap target for both directions.
  function setPanelVisible(visible) {
    const panel = document.getElementById("panel");
    if (!panel) return;
    panel.hidden = !visible;
    const handle = document.getElementById("panel-handle");
    if (handle) handle.hidden = visible;
  }
  function ensurePanelChrome(panel) {
    if (!panel.querySelector(".panel-close")) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "panel-close";
      btn.setAttribute("aria-label", "close panel");
      btn.textContent = "[x]";
      btn.addEventListener("click", () => setPanelVisible(false));
      panel.appendChild(btn);
    }
    if (!document.getElementById("panel-handle")) {
      const h = document.createElement("button");
      h.type = "button";
      h.id = "panel-handle";
      h.textContent = "[params]";
      h.hidden = panel.hidden ? false : true; // mirror current panel state
      h.addEventListener("click", () => setPanelVisible(true));
      document.body.appendChild(h);
    }
  }

  // wrap "· [N] toggle" tail of a panel-title in a .kbd-hint span so the
  // mobile media query can hide it (it overlaps the [x] close button there
  // and the keyboard shortcut is meaningless on touch).
  function wrapPanelTitleHint(panel) {
    const title = panel.querySelector(".panel-title");
    if (!title || title.dataset.kbdWrapped === "1") return;
    if (title.querySelector(".kbd-hint")) { title.dataset.kbdWrapped = "1"; return; }
    const m = title.textContent.match(/^(.*?)(\s*·\s*\[[^\]]+\]\s*toggle\s*)$/);
    if (!m) return;
    title.textContent = "";
    title.appendChild(document.createTextNode(m[1].trimEnd() + " "));
    const span = document.createElement("span");
    span.className = "kbd-hint";
    span.textContent = m[2].replace(/^\s*/, "").trimEnd();
    title.appendChild(span);
    title.dataset.kbdWrapped = "1";
  }

  // append a globals block to the params panel: grayscale tap-row + contrast
  // slider. global render settings, sit alongside per-page params, reachable
  // on mobile by tap. the contrast slider is wrapped in a div (not <label>)
  // so MIDI slot indexing skips it — knobs continue to map to per-page sliders.
  function ensurePanelGlobals(panel) {
    if (panel.querySelector(".panel-globals")) return;
    const wrap = document.createElement("div");
    wrap.className = "panel-globals";

    const gray = document.createElement("div");
    gray.className = "panel-grayscale";
    gray.addEventListener("click", toggleGrayscale);
    wrap.appendChild(gray);

    const contrast = document.createElement("div");
    contrast.className = "panel-row panel-contrast";
    contrast.innerHTML =
      '<span class="name">contrast</span><span class="val"></span>' +
      '<input type="range" min="0.5" max="2.5" step="0.01" data-global="1">';
    const input = contrast.querySelector("input");
    input.value = _contrast;
    input.addEventListener("input", () => setContrast(parseFloat(input.value)));
    wrap.appendChild(contrast);

    panel.appendChild(wrap);
  }

  function installPanel(params) {
    const panel = document.getElementById("panel");
    if (!panel) return;
    wrapPanelTitleHint(panel);
    panel.querySelectorAll("label input[type=range][data-k]").forEach(input => {
      const k = input.dataset.k;
      const valEl = input.parentElement.querySelector(".val");
      const step = parseFloat(input.step) || 1;
      const precision = step >= 1 ? 0 : Math.max(0, -Math.floor(Math.log10(step)));
      input.value = params[k];
      const sync = () => {
        params[k] = parseFloat(input.value);
        valEl.textContent = parseFloat(input.value).toFixed(precision);
        if (typeof window.onParamChange === "function") window.onParamChange(k);
      };
      input.addEventListener("input", sync);
      sync();
    });
    ensurePanelGlobals(panel);
    ensurePanelChrome(panel);
    updateAudioStatus();
    applyGrayscale();
    applyContrast();
    wirePanelSlots(panel);
    refreshSliderBadges();
    refreshMidiUI();
  }

  // page-wide keys: "0" toggles params panel, "9" toggles audio panel,
  // "a" toggles the mic.
  window.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target && e.target.tagName === "INPUT") return;
    if (e.key === "0") {
      const panel = document.getElementById("panel");
      if (panel) setPanelVisible(panel.hidden);
    } else if (e.key === "9") {
      const ap = document.getElementById("audio-panel");
      if (ap) { ap.hidden = !ap.hidden; if (!ap.hidden) updateAudioMeters(); }
    } else if (e.key === "a" || e.key === "A") {
      toggleMic();
    } else if (e.key === "m" || e.key === "M") {
      toggleMidiLearn();
    }
  });

  // load any persisted midi mappings before audio panel is built so initial UI
  // reflects the count.
  loadMidiMap();
  loadGrayscale();
  loadContrast();

  // build the audio dialog and apply persisted display-filter state at module
  // load (so the canvas filter is set before the page's first paint, not just
  // when the visualizer page later calls installPanel).
  function _coreInit() { buildAudioPanel(); rebuildCanvasFilter(); }
  if (document.body) _coreInit();
  else document.addEventListener("DOMContentLoaded", _coreInit);

  window.Newspeech = {
    intensity, poisson, installInputs, tickInputs, bumpActivity, installPanel,
    enableAudio, disableAudio, audioActive, audioLevel, bandLevel, onset,
    installMarkers, tickMarkers,
    installTelemetry, tickTelemetry,
  };
})();
