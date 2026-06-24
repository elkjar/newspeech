// Instrument editor — now embedded in the main ChannelScreen as two always-on
// tabs (PARAMS + AUTOMATION) instead of the old modal dialog. Scoped to the
// focused voice track (like the roll/lfo tabs). Edits write to the global
// voiceEditsStore and apply everywhere (playback + preview) via
// samplePlayer.pickNativeSample. Preview mirrors the Tracker hardware: a
// fixed-note (C3) button that sustains while held.
//
// `view` selects which half renders:
//   • 'params'     — the header: playmode + waveform + volume/tune/trim/loop/
//                    filter/granular controls.
//   • 'automation' — the modulation grid (LFO/ENV per target). Per target the
//                    LFO and ENV are MUTUALLY EXCLUSIVE (one modulator at a
//                    time — Chris, 2026-06-19; also matches the .pti slot model
//                    where each automation is env-XOR-lfo).
// A shared action bar (preview / export / save / save-as / revert) sits at the
// bottom of both views.
import { useEffect, useRef, useState } from 'react';
import {
  useVoiceEditsStore,
  resolvedVoiceEdit,
  DEFAULT_AMP_ENV,
  DEFAULT_FILTER_LFO,
  DEFAULT_ENV_MOD,
  DEFAULT_LFO_MOD,
  DEFAULT_GRANULAR,
  type LoopMode,
  type FilterType,
  type Playmode,
  type GranularEdit,
  type GrainShape,
  type GrainDir,
  type VoiceEdit,
} from '../instruments/voiceEditsStore';
import { useSequencerStore, type Track } from '../state/store';
import { ModEnvSection, ModLfoSection, ModHeader, type DepthCfg } from './ModSection';
import { voiceLabel } from '../audio/voices';
import { saveVoiceInline, saveVoiceAs, voiceIsSaveable } from '../instruments/saveInstrument';
import { monitorNote, monitorRelease } from '../audio/monitor';
import { setMonitorVoice, getMonitorPlayhead } from '../audio/nativeEngine';
import { Waveform } from './Waveform';
import { EnvelopeGraph } from './EnvelopeGraph';
import { Knob } from './Knob';
import { exportVoiceToPti } from '../tracker/exportPti';
import { markManualOverride, type LFODestKnobInstrument } from '../audio/lfo';
import { useRoutedLFOs } from '../hooks/useRoutedLFOs';
import { useLFOValue } from '../hooks/useLFOValue';

// Depth knob configs per modulation target.
const DEPTH_UNIT: DepthCfg = { min: 0, max: 1, format: (d) => `${(d * 100).toFixed(0)}%` };
const DEPTH_BIPOLAR: DepthCfg = {
  min: -1,
  max: 1,
  format: (d) => `${d > 0 ? '+' : ''}${(d * 100).toFixed(0)}%`,
};
const DEPTH_SEMIS: DepthCfg = {
  min: -24,
  max: 24,
  format: (d) => `${d > 0 ? '+' : ''}${d.toFixed(1)}st`,
};

const PLAYHEAD_POLL_MS = 33; // ~30Hz playhead readback while previewing
const PREVIEW_MIDI = 60; // C3 (matches the Tracker preview note + our sample naming)

// Resolve which voice the editor edits: the focused track if it's a voice
// (respect the focus — don't silently swap to another track), else the first
// voice track so the tab isn't empty before anything is focused.
function resolveEditorTrack(tracks: Track[], focusedId: string | null): Track | null {
  if (focusedId) {
    const t = tracks.find((t) => t.id === focusedId);
    if (t) return t.source.kind === 'voice' ? t : null;
  }
  return tracks.find((t) => t.source.kind === 'voice') ?? null;
}

export function InstrumentEditor({ view }: { view: 'params' | 'automation' }) {
  const tracks = useSequencerStore((s) => s.tracks);
  const focusedTrackId = useSequencerStore((s) => s.focusedTrackId);
  const track = resolveEditorTrack(tracks, focusedTrackId);
  const voiceId = track && track.source.kind === 'voice' ? track.source.id : null;

  // Subscribe to the WORKING layer for reactivity + the unsaved indicator…
  const workingEdit = useVoiceEditsStore((s) => (voiceId ? s.voiceEdits[voiceId] : undefined));
  // …but DISPLAY the resolved edit (manifest-baked + working). Save flushes the
  // working layer into the manifest then clears it (resetVoiceEdit), so reading
  // working-only made every saved param — playmode most visibly — snap back to
  // its default in the UI after Save, even though the audio path (which reads
  // resolved) was unaffected. resolvedVoiceEdit recomputes each render; the
  // resetVoiceEdit that fires on save re-renders us with the fresh manifest.
  const edit = voiceId ? resolvedVoiceEdit(voiceId) : undefined;
  const setVoiceEdit = useVoiceEditsStore((s) => s.setVoiceEdit);
  const resetVoiceEdit = useVoiceEditsStore((s) => s.resetVoiceEdit);
  const setTrackSource = useSequencerStore((s) => s.setTrackSource);
  const bpm = useSequencerStore((s) => s.bpm);

  const [saveState, setSaveState] = useState<'idle' | 'working' | 'ok' | 'err'>('idle');
  const [saveAsMode, setSaveAsMode] = useState(false);
  const [saveAsName, setSaveAsName] = useState('');
  const [exportState, setExportState] = useState<'idle' | 'working' | 'ok' | 'err'>('idle');
  const [playhead, setPlayhead] = useState<number | null>(null);
  const [durationSecs, setDurationSecs] = useState(0);
  const previewId = useRef(0);
  const pollRef = useRef<number | null>(null);
  // The track a held preview was started on, so cleanup can release the right
  // note even after the focused track changes.
  const previewTrack = useRef<Track | null>(null);

  // Live LFO-modulated grain position + length for the waveform cursor — mirrors
  // the per-note drift the trigger path applies (samplePlayer), so the cursor
  // visibly travels the sample (and the grain window resizes) while a grain LFO
  // is routed. Computed from the raw edit because `granular` is derived below,
  // after the focus guard — and these are hooks, so they must run before any
  // early return. Keyed to the focused track. No re-render when nothing's routed
  // (useLFOValue bails on an unchanged base).
  const grainPosRouted = useRoutedLFOs(track?.id ?? '', 'grainPosition');
  const grainLenRouted = useRoutedLFOs(track?.id ?? '', 'grainLength');
  const modGrainPos = useLFOValue(
    edit?.granular?.position ?? DEFAULT_GRANULAR.position,
    grainPosRouted,
    1,
  );
  const modGrainMs =
    1 +
    useLFOValue(
      ((edit?.granular?.grainMs ?? DEFAULT_GRANULAR.grainMs) - 1) / 999,
      grainLenRouted,
      1,
    ) *
      999;

  const stopPreview = () => {
    if (previewId.current && previewTrack.current) {
      monitorRelease(previewTrack.current, previewId.current);
    }
    if (pollRef.current != null) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
    previewTrack.current = null;
    setPlayhead(null);
    void setMonitorVoice(0);
  };

  // Stop any in-flight preview on unmount (leaving the params/automation tabs)
  // or when the focused instrument changes, so a held note can't keep droning.
  useEffect(() => {
    return () => stopPreview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voiceId]);

  if (!track || !voiceId) {
    return (
      <div className="h-full flex items-center justify-center text-[11px] uppercase tracking-widest text-white/30 px-6 text-center">
        focus a voice / instrument track to edit it
      </div>
    );
  }

  const gain = edit?.gain ?? 1;
  const tune = edit?.tune ?? 0;
  const finetune = edit?.finetune ?? 0;
  const start = edit?.start ?? 0;
  const end = edit?.end ?? 1;
  const loopMode = edit?.loopMode ?? 'off';
  const filterType = edit?.filterType ?? 'off';
  const cutoff = edit?.cutoff ?? 1;
  const resonance = edit?.resonance ?? 0;
  const reverbSend = edit?.reverbSend ?? 0;
  const delaySend = edit?.delaySend ?? 0;
  const ampEnv = edit?.ampEnv ?? DEFAULT_AMP_ENV;
  const envOn = edit?.ampEnv?.on ?? false;
  // Generic-mod grid values (defaulted for display).
  const volLfo = edit?.volLfo ?? DEFAULT_LFO_MOD;
  const filterLfo = edit?.filterLfo ?? DEFAULT_FILTER_LFO;
  const panEnv = edit?.panEnv ?? DEFAULT_ENV_MOD;
  const panLfo = edit?.panLfo ?? DEFAULT_LFO_MOD;
  const cutoffEnv = edit?.cutoffEnv ?? DEFAULT_ENV_MOD;
  const pitchEnv = edit?.pitchEnv ?? DEFAULT_ENV_MOD;
  const pitchLfo = edit?.pitchLfo ?? DEFAULT_LFO_MOD;
  // Playmode + granular (Phase C). granPos* are the granular-position automation
  // (a contextual 5th modulation column, shown only in granular mode).
  const playmode = edit?.playmode ?? 'sample';
  const granular = { ...DEFAULT_GRANULAR, ...(edit?.granular ?? {}) };
  const isGran = playmode === 'granular';
  const setGranular = (patch: Partial<GranularEdit>) =>
    setVoiceEdit(voiceId, { granular: { ...granular, ...patch } });
  const granPosLfo = edit?.granPosLfo ?? DEFAULT_LFO_MOD;
  const granPosEnv = edit?.granPosEnv ?? DEFAULT_ENV_MOD;

  // The cutoff LFO/env modulate the filter cutoff, so they do nothing while the
  // filter is off — interacting with either switches it on (to LP).
  const ensureFilterOn = () => {
    if (filterType === 'off') setVoiceEdit(voiceId, { filterType: 'lp' });
  };

  // Per-target LFO/ENV pair where enabling one disables the other (one
  // modulator at a time). lfoCur/envCur are already default-merged.
  const setMutex = (
    lfoKey: keyof VoiceEdit,
    lfoCur: unknown,
    envKey: keyof VoiceEdit,
    envCur: unknown,
  ) => ({
    lfo: (patch: Record<string, unknown>) =>
      setVoiceEdit(voiceId, {
        [lfoKey]: { ...(lfoCur as object), ...patch },
        ...(patch.on ? { [envKey]: { ...(envCur as object), on: false } } : {}),
      } as Partial<VoiceEdit>),
    env: (patch: Record<string, unknown>) =>
      setVoiceEdit(voiceId, {
        [envKey]: { ...(envCur as object), ...patch },
        ...(patch.on ? { [lfoKey]: { ...(lfoCur as object), on: false } } : {}),
      } as Partial<VoiceEdit>),
  });
  const volMx = setMutex('volLfo', volLfo, 'ampEnv', ampEnv);
  const cutMxRaw = setMutex('filterLfo', filterLfo, 'cutoffEnv', cutoffEnv);
  const cutMx = {
    lfo: (p: Record<string, unknown>) => {
      ensureFilterOn();
      cutMxRaw.lfo(p);
    },
    env: (p: Record<string, unknown>) => {
      ensureFilterOn();
      cutMxRaw.env(p);
    },
  };
  const panMx = setMutex('panLfo', panLfo, 'panEnv', panEnv);
  const pitchMx = setMutex('pitchLfo', pitchLfo, 'pitchEnv', pitchEnv);
  const granMx = setMutex('granPosLfo', granPosLfo, 'granPosEnv', granPosEnv);

  const startPreview = () => {
    const id = ++previewId.current;
    previewTrack.current = track;
    monitorNote(track, PREVIEW_MIDI, 0.85, id);
    void setMonitorVoice(id);
    if (pollRef.current != null) window.clearInterval(pollRef.current);
    pollRef.current = window.setInterval(() => {
      void getMonitorPlayhead().then((p) => setPlayhead(p >= 0 ? p : null));
    }, PLAYHEAD_POLL_MS);
  };
  const doExport = async () => {
    setExportState('working');
    try {
      const res = await exportVoiceToPti(voiceId);
      setExportState(res.ok ? 'ok' : 'err');
    } catch {
      setExportState('err');
    }
    window.setTimeout(() => setExportState('idle'), 2000);
  };
  const doSave = async () => {
    setSaveState('working');
    const res = await saveVoiceInline(voiceId);
    setSaveState(res.ok ? 'ok' : 'err');
    window.setTimeout(() => setSaveState('idle'), 2000);
  };
  const doSaveAs = async () => {
    const name = saveAsName.trim();
    if (!name) return;
    setSaveState('working');
    const res = await saveVoiceAs(voiceId, name);
    if (res.ok && res.newVoiceId) {
      setTrackSource(track.id, { kind: 'voice', id: res.newVoiceId });
      setSaveAsMode(false);
      setSaveAsName('');
      setSaveState('ok');
    } else {
      setSaveState('err');
    }
    window.setTimeout(() => setSaveState('idle'), 2000);
  };
  const doRevert = () => resetVoiceEdit(voiceId);
  const saveable = voiceIsSaveable(voiceId);
  const isUnsaved = workingEdit !== undefined;

  // ---- params view -------------------------------------------------------
  const paramsBody = (
    <div className="flex-1 min-h-0 flex gap-4 p-3 overflow-auto">
      <div className="flex-[6] min-w-0">
        <Waveform
          voiceId={voiceId}
          start={start}
          end={end}
          loopMode={loopMode}
          playhead={playhead}
          onChange={(patch) => setVoiceEdit(voiceId, patch)}
          granular={isGran ? { position: modGrainPos, grainMs: modGrainMs } : null}
          onGranularPosition={(p) => {
            markManualOverride(track.id, 'grainPosition');
            setGranular({ position: p });
          }}
          onGranularGrain={(ms) => {
            markManualOverride(track.id, 'grainLength');
            setGranular({ grainMs: ms });
          }}
          onDuration={setDurationSecs}
        />
        <div
          className={`flex justify-between text-[9px] uppercase tracking-widest tabular-nums px-1 -mt-2 ${
            isGran ? 'text-white/40' : 'invisible'
          }`}
        >
          <span>grain {modGrainMs.toFixed(0)} ms</span>
          <span>
            pos{' '}
            {durationSecs > 0
              ? `${(modGrainPos * durationSecs).toFixed(3)}s`
              : `${(modGrainPos * 100).toFixed(0)}%`}
          </span>
        </div>
      </div>
      {/* Playmode picker — a vertical stack directly to the right of the
          visualizer, so it's out of the controls grid (which now has the room
          to breathe rather than competing with a horizontal tab row). */}
      <div className="shrink-0 flex flex-col gap-2 pt-1">
        <span className="text-[9px] uppercase tracking-widest text-white/40">playmode</span>
        <PlaymodeTabs vertical value={playmode} onChange={(p) => setVoiceEdit(voiceId, { playmode: p })} />
      </div>
      {/* Controls grouped into vertical stacks, divider lines between groups.
          Order: level (vol/tune) · filter · mode-specific (loop | direction +
          grain) — so the first two columns stay put when switching playmode. */}
      <div className="flex-[7] min-w-0 flex items-start gap-5">
        {/* level — 2×2 grid mirroring the .pti instrument param set:
              volume · rev send
              tune   · delay send
            Sends save with the instrument + export to .pti. (The native delay
            aux isn't built yet, so delay send is silent in-app for now.) */}
        <div className="grid grid-cols-2 gap-x-4 gap-y-3 items-start">
          <TopKnob
            label="volume"
            value={gain / 2}
            display={`×${gain.toFixed(2)}`}
            onChange={(v) => setVoiceEdit(voiceId, { gain: v * 2 })}
          />
          <TopKnob
            label="rev send"
            value={reverbSend}
            display={`${(reverbSend * 100).toFixed(0)}%`}
            onChange={(v) => setVoiceEdit(voiceId, { reverbSend: v })}
          />
          <TopKnob
            label="tune"
            value={(tune + 24) / 48}
            bipolar
            display={`${tune > 0 ? '+' : ''}${tune} st`}
            onChange={(v) => setVoiceEdit(voiceId, { tune: Math.round(v * 48 - 24) })}
          />
          <TopKnob
            label="finetune"
            value={(finetune + 100) / 200}
            bipolar
            display={`${finetune > 0 ? '+' : ''}${finetune} ct`}
            onChange={(v) => setVoiceEdit(voiceId, { finetune: Math.round(v * 200 - 100) })}
          />
          <TopKnob
            label="delay send"
            value={delaySend}
            display={`${(delaySend * 100).toFixed(0)}%`}
            onChange={(v) => setVoiceEdit(voiceId, { delaySend: v })}
          />
        </div>
        <Divider />
        {/* filter — label on top, mode-button row, then cutoff + reso */}
        <LabeledStack label="filter">
          <div className="flex gap-1">
            {(['off', 'lp', 'hp', 'bp'] as FilterType[]).map((f) => (
              <SegButton
                key={f}
                active={filterType === f}
                onClick={() => setVoiceEdit(voiceId, { filterType: f })}
              >
                {f}
              </SegButton>
            ))}
          </div>
          <div className="flex items-start gap-4">
            <TopKnob
              label="cutoff"
              value={cutoff}
              display={`${(cutoff * 100).toFixed(0)}%`}
              onChange={(v) => setVoiceEdit(voiceId, { cutoff: v })}
            />
            <TopKnob
              label="reso"
              value={resonance}
              display={`${(resonance * 100).toFixed(0)}%`}
              onChange={(v) => setVoiceEdit(voiceId, { resonance: v })}
            />
          </div>
        </LabeledStack>
        <Divider />
        {/* loop (sample mode) — label on top, buttons stacked vertically */}
        {!isGran && (
          <LabeledStack label="loop">
            <div className="flex flex-col gap-1 items-stretch">
              {(['off', 'fwd', 'bwd', 'pingpong'] as LoopMode[]).map((m) => (
                <SegButton
                  key={m}
                  active={loopMode === m}
                  onClick={() => setVoiceEdit(voiceId, { loopMode: m })}
                >
                  {m === 'pingpong' ? 'ping' : m}
                </SegButton>
              ))}
            </div>
          </LabeledStack>
        )}
        {/* grain (granular mode): direction column · grain (shape + scatter) */}
        {isGran && (
          <>
            <LabeledStack label="direction">
              <div className="flex flex-col gap-1 items-stretch">
                {(['fwd', 'bwd', 'pingpong'] as GrainDir[]).map((d) => (
                  <SegButton
                    key={d}
                    active={granular.direction === d}
                    onClick={() => setGranular({ direction: d })}
                  >
                    {d === 'pingpong' ? 'ping' : d}
                  </SegButton>
                ))}
              </div>
            </LabeledStack>
            <Divider />
            <LabeledStack label="grain">
              <TopControl label="shape">
                <div className="flex gap-1">
                  {(['square', 'triangle', 'gauss'] as GrainShape[]).map((s) => (
                    <SegButton
                      key={s}
                      active={granular.shape === s}
                      onClick={() => setGranular({ shape: s })}
                    >
                      {s === 'triangle' ? 'tri' : s === 'square' ? 'sqr' : 'gss'}
                    </SegButton>
                  ))}
                </div>
              </TopControl>
              {/* length + position are global-LFO destinations (per-note drift);
                  scatter is a plain local knob. */}
              <div className="flex gap-2">
                <GranLfoKnob
                  trackId={track.id}
                  knob="grainLength"
                  label="length"
                  value={(granular.grainMs - 1) / 999}
                  display={(v) => `${Math.round(1 + v * 999)} ms`}
                  onChange={(v) => setGranular({ grainMs: 1 + v * 999 })}
                />
                <GranLfoKnob
                  trackId={track.id}
                  knob="grainPosition"
                  label="pos"
                  value={granular.position}
                  display={(v) => `${Math.round(v * 100)}%`}
                  onChange={(v) => setGranular({ position: v })}
                />
                <TopKnob
                  label="scatter"
                  value={granular.spray}
                  display={`${(granular.spray * 100).toFixed(0)}%`}
                  onChange={(v) => setGranular({ spray: v })}
                />
              </div>
            </LabeledStack>
          </>
        )}
      </div>
    </div>
  );

  // ---- automation view ---------------------------------------------------
  const ms = (s: number) => `${Math.round(s * 1000)}`;
  const automationBody = (
    <div className="flex-1 min-h-0 overflow-auto p-3">
      <div className="flex gap-5 items-start">
        {/* VOL — tremolo LFO + amp (volume) envelope */}
        <div className="flex-1 min-w-0">
          <ModLfoSection
            label="vol lfo"
            value={volLfo}
            depthCfg={DEPTH_UNIT}
            bpm={bpm}
            compact
            onChange={(p) => volMx.lfo(p)}
          />
          <div className="mb-2">
            <ModHeader label="vol env" on={envOn} onToggle={() => volMx.env({ on: !envOn })} />
            <div className={envOn ? '' : 'opacity-50'}>
              <EnvelopeGraph env={ampEnv} onChange={(patch) => volMx.env(patch)} height={44} />
            </div>
            <div className="flex justify-between text-[9px] uppercase tracking-widest text-white/40 tabular-nums px-1">
              <span>atk {ms(ampEnv.attack)}</span>
              <span>dcy {ms(ampEnv.decay)}</span>
              <span>sus {(ampEnv.sustain * 100).toFixed(0)}%</span>
              <span>rel {ms(ampEnv.release)}</span>
            </div>
          </div>
        </div>

        {/* CUTOFF */}
        <div className="flex-1 min-w-0">
          <ModLfoSection
            label="cutoff lfo"
            value={filterLfo}
            depthCfg={DEPTH_UNIT}
            bpm={bpm}
            compact
            onChange={(p) => cutMx.lfo(p)}
          />
          <ModEnvSection
            label="cutoff env"
            value={cutoffEnv}
            depthCfg={DEPTH_BIPOLAR}
            compact
            onChange={(p) => cutMx.env(p)}
          />
        </div>

        {/* PAN */}
        <div className="flex-1 min-w-0">
          <ModLfoSection
            label="pan lfo"
            value={panLfo}
            depthCfg={DEPTH_BIPOLAR}
            bpm={bpm}
            compact
            onChange={(p) => panMx.lfo(p)}
          />
          <ModEnvSection
            label="pan env"
            value={panEnv}
            depthCfg={DEPTH_BIPOLAR}
            compact
            onChange={(p) => panMx.env(p)}
          />
        </div>

        {/* PITCH */}
        <div className="flex-1 min-w-0">
          <ModLfoSection
            label="pitch lfo"
            value={pitchLfo}
            depthCfg={DEPTH_SEMIS}
            bpm={bpm}
            compact
            onChange={(p) => pitchMx.lfo(p)}
          />
          <ModEnvSection
            label="pitch env"
            value={pitchEnv}
            depthCfg={DEPTH_SEMIS}
            compact
            onChange={(p) => pitchMx.env(p)}
          />
        </div>

        {/* GRAIN POSITION — contextual: granular mode only (.pti automations[4]) */}
        {isGran && (
          <div className="flex-1 min-w-0">
            <ModLfoSection
              label="grain pos lfo"
              value={granPosLfo}
              depthCfg={DEPTH_UNIT}
              bpm={bpm}
              compact
              onChange={(p) => granMx.lfo(p)}
            />
            <ModEnvSection
              label="grain pos env"
              value={granPosEnv}
              depthCfg={DEPTH_UNIT}
              compact
              onChange={(p) => granMx.env(p)}
            />
          </div>
        )}
      </div>
    </div>
  );

  // ---- shared action bar -------------------------------------------------
  const actionBar = (
    <div className="flex items-center justify-between gap-2 px-3 py-2 border-t border-white/10">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onPointerDown={startPreview}
          onPointerUp={stopPreview}
          onPointerLeave={stopPreview}
          className="px-3 py-1.5 border border-white/30 hover:border-white text-[10px] uppercase tracking-widest text-white/80 hover:text-white transition-colors select-none"
          title="hold to preview at C3 (releases on release)"
        >
          ▶ preview · C3
        </button>
        <button
          type="button"
          onClick={doExport}
          disabled={exportState === 'working'}
          className="px-3 py-1.5 border border-white/30 hover:border-white text-[10px] uppercase tracking-widest text-white/80 hover:text-white transition-colors select-none"
          title="export this instrument to a Polyend Tracker .pti file"
        >
          {exportState === 'working'
            ? '… .pti'
            : exportState === 'ok'
              ? '✓ .pti'
              : exportState === 'err'
                ? '✗ .pti'
                : 'export .pti'}
        </button>
      </div>
      <div className="flex items-center gap-2">
        {saveable && isUnsaved && (
          <span className="text-[9px] uppercase tracking-widest text-white/50 select-none">
            ● unsaved
          </span>
        )}
        {saveable && isUnsaved && (
          <button
            type="button"
            onClick={doRevert}
            className="px-3 py-1.5 border border-white/15 hover:border-white text-[10px] uppercase tracking-widest text-white/60 hover:text-white transition-colors"
            title="discard unsaved changes (back to the saved instrument)"
          >
            revert
          </button>
        )}
        {saveable && !saveAsMode && (
          <>
            <button
              type="button"
              onClick={doSave}
              disabled={!isUnsaved || saveState === 'working'}
              className="px-3 py-1.5 border border-white/30 hover:border-white disabled:opacity-30 disabled:hover:border-white/30 text-[10px] uppercase tracking-widest text-white/80 hover:text-white transition-colors"
              title="save changes to this instrument, globally"
            >
              {saveState === 'working'
                ? '…'
                : saveState === 'ok'
                  ? '✓ saved'
                  : saveState === 'err'
                    ? '✗ save'
                    : 'save'}
            </button>
            <button
              type="button"
              onClick={() => {
                setSaveAsName(`${voiceLabel(voiceId)} var`);
                setSaveAsMode(true);
              }}
              className="px-3 py-1.5 border border-white/30 hover:border-white text-[10px] uppercase tracking-widest text-white/80 hover:text-white transition-colors"
              title="fork a new instrument off the same samples"
            >
              save as
            </button>
          </>
        )}
        {saveable && saveAsMode && (
          <>
            <input
              type="text"
              value={saveAsName}
              autoFocus
              onChange={(e) => setSaveAsName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void doSaveAs();
                if (e.key === 'Escape') setSaveAsMode(false);
              }}
              placeholder="new instrument name"
              className="px-2 py-1.5 w-44 bg-transparent border border-white/30 focus:outline-none focus:border-white text-[11px] text-white/90 placeholder:text-white/30"
            />
            <button
              type="button"
              onClick={doSaveAs}
              disabled={!saveAsName.trim() || saveState === 'working'}
              className="px-3 py-1.5 border border-white/30 hover:border-white disabled:opacity-30 text-[10px] uppercase tracking-widest text-white/80 hover:text-white transition-colors"
            >
              {saveState === 'working' ? '…' : '✓'}
            </button>
            <button
              type="button"
              onClick={() => setSaveAsMode(false)}
              className="px-3 py-1.5 border border-white/15 hover:border-white text-[10px] uppercase tracking-widest text-white/60 hover:text-white transition-colors"
            >
              ✕
            </button>
          </>
        )}
      </div>
    </div>
  );

  return (
    <div className="h-full flex flex-col">
      {view === 'params' ? paramsBody : automationBody}
      {actionBar}
    </div>
  );
}

// A control group with its label ON TOP and everything stacked below it
// (loop / filter) — saves horizontal space vs the knob-over-label units.
function LabeledStack({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2">
      <span className="text-[9px] uppercase tracking-widest text-white/40">{label}</span>
      {children}
    </div>
  );
}

// Vertical rule between control stacks.
function Divider() {
  return <div className="self-stretch w-px bg-white/10" />;
}

// Segmented-toggle button (loop / shape / direction / filter pickers).
function SegButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-2 py-1 text-[9px] uppercase tracking-widest border transition-colors ${
        active ? 'border-white text-white' : 'border-white/15 text-white/40 hover:text-white/70'
      }`}
    >
      {children}
    </button>
  );
}

// Instrument-header control unit — control on top, label + value below.
function TopControl({
  label,
  value,
  children,
}: {
  label: string;
  value?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-1">
      <div className="h-12 flex items-center justify-center">{children}</div>
      <span className="text-[10px] uppercase tracking-[0.14em] text-white/60 whitespace-nowrap">
        {label}
      </span>
      {value && <span className="text-[9px] tabular-nums text-white/40">{value}</span>}
    </div>
  );
}

// FX-style labeled knob (size 44) for the instrument header.
function TopKnob({
  label,
  value,
  display,
  onChange,
  bipolar = false,
}: {
  label: string;
  value: number;
  display: string;
  onChange: (v: number) => void;
  bipolar?: boolean;
}) {
  return (
    <TopControl label={label} value={display}>
      <Knob value={value} displayValue={value} bipolar={bipolar} onChange={onChange} size={44} title={label} />
    </TopControl>
  );
}

// A grain knob that's also a global-LFO destination (per-note drift of grain
// length/position). Mirrors TrackKnob: shows the live modulated value, click
// while an LFO is in select-mode to bind it, and a hand-drag marks a manual
// override so the LFO yields. Keyed by the focused track's id + the instrument
// knob name. value/onChange operate in 0..1; `display` formats the modulated v.
function GranLfoKnob({
  trackId,
  knob,
  label,
  value,
  display,
  onChange,
}: {
  trackId: string;
  knob: LFODestKnobInstrument;
  label: string;
  value: number;
  display: (v: number) => string;
  onChange: (v: number) => void;
}) {
  const selectingLFO = useSequencerStore((s) => s.selectingLFO);
  const toggleLFODestination = useSequencerStore((s) => s.toggleLFODestination);
  const routed = useRoutedLFOs(trackId, knob);
  const modValue = useLFOValue(value, routed, 1);
  const lfoLabels = routed.map((l) => `L${l.id + 1}`).join(',');
  const onModulationClick =
    selectingLFO !== null
      ? () => toggleLFODestination(selectingLFO, { trackId, knob })
      : undefined;
  const modulationLabel =
    selectingLFO !== null
      ? lfoLabels || undefined
      : routed.length > 0
        ? lfoLabels
        : undefined;
  return (
    <TopControl label={label} value={display(modValue)}>
      <Knob
        value={value}
        displayValue={modValue}
        onChange={(v) => {
          markManualOverride(trackId, knob);
          onChange(v);
        }}
        size={44}
        title={label}
        onModulationClick={onModulationClick}
        modulationLabel={modulationLabel}
      />
    </TopControl>
  );
}

// Playmode selector — same segmented-tab visual as the main screen tabs.
// sample + granular are live; slice + wavetable are scaffolded (disabled).
const PLAYMODES: { id: Playmode; label: string; ready: boolean }[] = [
  { id: 'sample', label: 'sample', ready: true },
  { id: 'slice', label: 'slice', ready: false },
  { id: 'wavetable', label: 'wavetable', ready: false },
  { id: 'granular', label: 'granular', ready: true },
];

function PlaymodeTabs({
  value,
  onChange,
  vertical = false,
}: {
  value: Playmode;
  onChange: (p: Playmode) => void;
  vertical?: boolean;
}) {
  return (
    <div
      className={`flex gap-1.5 text-[10px] uppercase tracking-widest ${
        vertical ? 'flex-col' : ''
      }`}
    >
      {PLAYMODES.map((m) => (
        <button
          key={m.id}
          type="button"
          disabled={!m.ready}
          onClick={() => m.ready && onChange(m.id)}
          title={m.ready ? m.label : `${m.label} — coming soon`}
          className={[
            'px-2.5 py-1 border transition-colors',
            vertical ? 'text-left' : '',
            value === m.id
              ? 'bg-white text-ink border-white'
              : m.ready
                ? 'border-white/15 text-white/60 hover:text-white hover:border-white'
                : 'border-white/10 text-white/25 cursor-not-allowed',
          ].join(' ')}
        >
          {m.label}
        </button>
      ))}
    </div>
  );
}
