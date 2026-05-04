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
    #panel .panel-audio-status, #audio-panel .audio-state {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.10em;
      opacity: 0.45;
      margin-bottom: 12px;
    }
    #panel .panel-audio-status.on, #audio-panel .audio-state.on {
      opacity: 0.95;
      color: rgba(180, 220, 255, 1);
    }
    #audio-panel .audio-state { cursor: pointer; }
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

  function ensureAudioStatusEl(panel) {
    let s = panel.querySelector(".panel-audio-status");
    if (!s) {
      s = document.createElement("div");
      s.className = "panel-audio-status";
      const title = panel.querySelector(".panel-title");
      if (title) title.parentNode.insertBefore(s, title.nextSibling);
      else panel.insertBefore(s, panel.firstChild);
    }
    return s;
  }
  function updateAudioStatus() {
    const text = `[a] mic ${_audioActive ? "on" : "off"}`;
    document.querySelectorAll("#panel").forEach(panel => {
      const s = ensureAudioStatusEl(panel);
      s.textContent = text;
      s.classList.toggle("on", _audioActive);
    });
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
      <div class="panel-title">audio · [9] toggle</div>
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

    _meterEls = {
      low:  div.querySelector('i[data-band="low"]'),
      mid:  div.querySelector('i[data-band="mid"]'),
      high: div.querySelector('i[data-band="high"]'),
    };
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

  function installPanel(params) {
    const panel = document.getElementById("panel");
    if (!panel) return;
    panel.querySelectorAll("input[type=range]").forEach(input => {
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
    ensureAudioStatusEl(panel);
    updateAudioStatus();
  }

  // page-wide keys: "0" toggles params panel, "9" toggles audio panel,
  // "a" toggles the mic.
  window.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target && e.target.tagName === "INPUT") return;
    if (e.key === "0") {
      const panel = document.getElementById("panel");
      if (panel) panel.hidden = !panel.hidden;
    } else if (e.key === "9") {
      const ap = document.getElementById("audio-panel");
      if (ap) { ap.hidden = !ap.hidden; if (!ap.hidden) updateAudioMeters(); }
    } else if (e.key === "a" || e.key === "A") {
      toggleMic();
    }
  });

  // build the audio dialog at module load (hidden by default).
  if (document.body) buildAudioPanel();
  else document.addEventListener("DOMContentLoaded", buildAudioPanel);

  window.Newspeech = {
    intensity, poisson, installInputs, tickInputs, bumpActivity, installPanel,
    enableAudio, disableAudio, audioActive, audioLevel, bandLevel, onset,
  };
})();
