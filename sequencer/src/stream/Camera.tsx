import { useEffect, useRef, useState } from 'react';

// Camera source — raw webcam feed via getUserMedia. The Tauri WKUIDelegate
// auto-grants the permission so the request never prompts.
//
// On unmount we explicitly stop the MediaStream tracks; without it the
// camera LED would stay on after switching back to the flare source.

type Status = 'loading' | 'ready' | 'error';

export function Camera() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [status, setStatus] = useState<Status>('loading');
  const [errorMsg, setErrorMsg] = useState<string>('');

  useEffect(() => {
    let stream: MediaStream | null = null;
    let cancelled = false;

    void (async () => {
      try {
        const s = await navigator.mediaDevices.getUserMedia({
          // Reasonable HD ask — the browser/OS will negotiate down if the
          // camera can't deliver. No audio (don't want feedback if camera
          // mic is the default input).
          video: { width: { ideal: 1920 }, height: { ideal: 1080 } },
          audio: false,
        });
        if (cancelled) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        stream = s;
        const v = videoRef.current;
        if (v) {
          v.srcObject = s;
          await v.play().catch(() => {
            // play() can reject if the element was unmounted mid-await;
            // safe to ignore — the cleanup path will tear down the stream.
          });
          if (!cancelled) setStatus('ready');
        }
      } catch (e) {
        if (cancelled) return;
        setStatus('error');
        setErrorMsg(e instanceof Error ? e.message : String(e));
      }
    })();

    return () => {
      cancelled = true;
      if (stream) {
        stream.getTracks().forEach((t) => t.stop());
      }
      const v = videoRef.current;
      if (v) v.srcObject = null;
    };
  }, []);

  return (
    <div className="absolute inset-0">
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        // object-cover keeps aspect; the datafeed overlays the left third
        // either way. CSS `filter: grayscale(1)` desaturates the live feed
        // to match the newspeech monochrome aesthetic — applied on the
        // element rather than via `ctx.filter` since the latter no-ops on
        // some WKWebView versions.
        className="absolute inset-0 w-full h-full object-cover"
        style={{ filter: 'grayscale(1)' }}
      />
      {status !== 'ready' && (
        <div className="absolute inset-0 flex items-center justify-center bg-[#050505] text-white font-mono">
          <div className="text-[10px] uppercase tracking-[0.3em] opacity-60">
            {status === 'loading' ? 'camera · acquiring' : 'camera · error'}
          </div>
          {status === 'error' && errorMsg && (
            <div className="mt-2 text-[9px] opacity-50 max-w-md text-center">
              {errorMsg}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
