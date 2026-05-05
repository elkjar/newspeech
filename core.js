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
       silently no-ops pre-18) and so multiple effects compose cleanly. */
    canvas#bg { filter: var(--ns-canvas-filter, none); }
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
  };
})();
