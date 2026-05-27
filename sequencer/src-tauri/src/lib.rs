mod audio;
mod midi;
mod projectfs;
mod recording;
mod reverb;
mod samples;

#[cfg(target_os = "macos")]
mod media_permission {
  // WKWebView auto-denies getUserMedia and media-device enumeration when no
  // WKUIDelegate is set. We register a delegate class at runtime that
  // always grants the request, so `navigator.mediaDevices.getUserMedia` and
  // the subsequent `enumerateDevices()` return full device lists. Without
  // this the audio-output picker can only see "default".
  //
  // The delegate also requires NSMicrophoneUsageDescription in the app's
  // Info.plist for the bundled release; tauri-build's embedded dev plist
  // currently has enough for the dev binary to proceed.

  use cocoa::base::{id, nil};
  use objc::declare::ClassDecl;
  use objc::runtime::{Class, Object, Sel};
  use objc::{class, msg_send, sel, sel_impl};
  use std::ffi::c_void;
  use std::sync::Once;

  static REGISTER: Once = Once::new();
  static mut DELEGATE_CLASS: *const Class = std::ptr::null();

  // ObjC block invocation. Layout per libdispatch ABI:
  //   offset 0  isa
  //   offset 8  flags
  //   offset 12 reserved
  //   offset 16 invoke (fn pointer)
  //   offset 24 descriptor
  unsafe fn call_decision_handler(block: id, decision: i64) {
    let invoke_ptr = *((block as *const u8).add(16) as *const *mut c_void);
    let invoke: extern "C" fn(id, i64) = std::mem::transmute(invoke_ptr);
    invoke(block, decision);
  }

  extern "C" fn grant_media_capture(
    _this: &Object,
    _sel: Sel,
    _webview: id,
    _origin: id,
    _frame: id,
    _capture_type: i64,
    decision_handler: id,
  ) {
    // WKPermissionDecisionGrant = 1
    unsafe { call_decision_handler(decision_handler, 1) };
  }

  pub fn install_on_webview(webview: id) {
    if webview == nil {
      return;
    }
    unsafe {
      REGISTER.call_once(|| {
        let superclass = class!(NSObject);
        let mut decl = match ClassDecl::new("SequenceMediaPermissionDelegate", superclass) {
          Some(d) => d,
          None => return,
        };
        decl.add_method(
          sel!(webView:requestMediaCapturePermissionForOrigin:initiatedByFrame:type:decisionHandler:),
          grant_media_capture
            as extern "C" fn(&Object, Sel, id, id, id, i64, id),
        );
        DELEGATE_CLASS = decl.register();
      });
      if DELEGATE_CLASS.is_null() {
        return;
      }
      let cls = DELEGATE_CLASS;
      let delegate: id = msg_send![cls, alloc];
      let delegate: id = msg_send![delegate, init];
      let _: () = msg_send![webview, setUIDelegate: delegate];
    }
  }
}

#[cfg(target_os = "macos")]
fn set_dock_icon() {
  // Programmatic Dock icon binding bypasses macOS IconServices caching of
  // the dev binary — the cache otherwise sticks to whatever icon resource
  // was resolved first against this binary path.
  use cocoa::base::{id, nil};
  use objc::{class, msg_send, sel, sel_impl};
  static ICON_BYTES: &[u8] = include_bytes!("../icons/icon.png");
  unsafe {
    let data: id = msg_send![
      class!(NSData),
      dataWithBytes: ICON_BYTES.as_ptr() as *const std::ffi::c_void
      length: ICON_BYTES.len() as u64
    ];
    let image_alloc: id = msg_send![class!(NSImage), alloc];
    let image: id = msg_send![image_alloc, initWithData: data];
    if image != nil {
      let app: id = msg_send![class!(NSApplication), sharedApplication];
      let _: () = msg_send![app, setApplicationIconImage: image];
    }
  }
}

// Visualizer pool — list/scan `~/Documents/newspeech-visuals/` for video
// and still files. Pool.tsx loads files via `convertFileSrc` against the
// asset protocol scope set in tauri.conf.json. Folder is auto-created on
// first list so the user can just open the app and drop files in.

fn pool_dir_path() -> Result<std::path::PathBuf, String> {
  let home = std::env::var("HOME").map_err(|e| format!("HOME: {}", e))?;
  Ok(std::path::PathBuf::from(home)
    .join("Documents")
    .join("newspeech-visuals"))
}

#[tauri::command]
fn pool_list_visuals() -> Result<Vec<String>, String> {
  let dir = pool_dir_path()?;
  if !dir.exists() {
    std::fs::create_dir_all(&dir).map_err(|e| format!("create_dir_all: {}", e))?;
    return Ok(vec![]);
  }
  let allowed = ["mp4", "mov", "webm", "jpg", "jpeg", "png"];
  let mut files = Vec::new();
  for entry in std::fs::read_dir(&dir).map_err(|e| format!("read_dir: {}", e))? {
    let entry = match entry {
      Ok(e) => e,
      Err(_) => continue,
    };
    let path = entry.path();
    let ext = path
      .extension()
      .and_then(|e| e.to_str())
      .map(|s| s.to_lowercase());
    let Some(ext) = ext else { continue };
    if !allowed.contains(&ext.as_str()) {
      continue;
    }
    if let Some(s) = path.to_str() {
      files.push(s.to_string());
    }
  }
  files.sort();
  Ok(files)
}

#[tauri::command]
fn pool_get_dir() -> Result<String, String> {
  let dir = pool_dir_path()?;
  if !dir.exists() {
    std::fs::create_dir_all(&dir).map_err(|e| format!("create_dir_all: {}", e))?;
  }
  dir
    .to_str()
    .map(|s| s.to_string())
    .ok_or_else(|| "path encoding".to_string())
}

#[tauri::command]
async fn toggle_stream_window(app: tauri::AppHandle) -> Result<(), String> {
  use tauri::Manager;

  // Toggle: clicking the toolbar button a second time closes the window
  // instead of just refocusing it. Cleaner than a separate close path.
  if let Some(existing) = app.get_webview_window("stream") {
    let _ = existing.close();
    return Ok(());
  }

  let window = tauri::WebviewWindowBuilder::new(
    &app,
    "stream",
    tauri::WebviewUrl::App("index.html?window=stream".into()),
  )
  .title("Sequence — Stream")
  .inner_size(1920.0, 1080.0)
  .min_inner_size(960.0, 540.0)
  .decorations(false)
  .resizable(true)
  .fullscreen(false)
  .build()
  .map_err(|e| e.to_string())?;

  // Position on the first non-primary monitor if one exists, sized to
  // fill it. Borderless + matched-size reads as fullscreen on an
  // external display (HDMI/AirPlay to TV for the shoot) without taking
  // over a macOS space the way `set_fullscreen(true)` does — that
  // forces a space transition each open and is awkward when the
  // performer wants the sequencer view on the laptop screen.
  let monitors = app.available_monitors().unwrap_or_default();
  let primary_pos = app
    .primary_monitor()
    .ok()
    .flatten()
    .map(|m| (m.position().x, m.position().y));

  log::info!(
    "[stream] available monitors: {} | primary pos: {:?}",
    monitors.len(),
    primary_pos
  );
  for (i, m) in monitors.iter().enumerate() {
    log::info!(
      "[stream] monitor {}: name={:?} pos=({},{}) size=({},{}) scale={}",
      i,
      m.name(),
      m.position().x,
      m.position().y,
      m.size().width,
      m.size().height,
      m.scale_factor()
    );
  }

  let target = monitors.iter().find(|m| {
    let p = m.position();
    match primary_pos {
      Some((px, py)) => p.x != px || p.y != py,
      None => true,
    }
  });
  if let Some(m) = target {
    log::info!(
      "[stream] target monitor: name={:?} pos=({},{}) size=({},{}) scale={}",
      m.name(),
      m.position().x,
      m.position().y,
      m.size().width,
      m.size().height,
      m.scale_factor()
    );
    // Convert the monitor's reported PhysicalPosition/Size to LOGICAL
    // coordinates using the monitor's own scale factor. macOS lays
    // monitors out in a single logical point space (e.g. Retina primary
    // at scale 2 occupies logical 0..2560; a 1× TV to its right starts
    // at logical 2560). `set_position(PhysicalPosition)` re-divides by
    // the WINDOW's current scale, not the target monitor's, so a raw
    // physical hand-off lands on the wrong screen when scales differ.
    // LogicalPosition is interpreted as macOS points directly.
    let scale = m.scale_factor();
    let lx = m.position().x as f64 / scale;
    let ly = m.position().y as f64 / scale;
    let lw = m.size().width as f64 / scale;
    let lh = m.size().height as f64 / scale;
    // WindowServer can also no-op a set_position called too soon after
    // build() while the OS-level window is still being realized, so
    // defer the move to a worker thread after a short delay.
    let win = window.clone();
    std::thread::spawn(move || {
      std::thread::sleep(std::time::Duration::from_millis(150));
      if let Err(e) = win.set_position(tauri::LogicalPosition::new(lx, ly)) {
        log::warn!("[stream] set_position err: {}", e);
      }
      if let Err(e) = win.set_size(tauri::LogicalSize::new(lw, lh)) {
        log::warn!("[stream] set_size err: {}", e);
      }
      // Re-assert position after size — set_size can nudge the window
      // back onto the primary monitor on some macOS releases.
      let _ = win.set_position(tauri::LogicalPosition::new(lx, ly));
      // Raise above the menu bar so the secondary monitor doesn't
      // show a thin strip of macOS chrome along the top. Only the
      // multi-monitor path lifts the level — single-display launches
      // stay at default level so the user can still reach their menu
      // bar on the laptop. NSStatusWindowLevel (25) sits one notch
      // above NSMainMenuWindowLevel (24).
      #[cfg(target_os = "macos")]
      {
        let _ = win.with_webview(|webview| unsafe {
          use cocoa::base::{id, nil};
          use objc::{msg_send, sel, sel_impl};
          let wk: id = webview.inner() as id;
          let ns_window: id = msg_send![wk, window];
          if ns_window != nil {
            let _: () = msg_send![ns_window, setLevel: 25_i64];
          }
        });
      }
      log::info!(
        "[stream] repositioned to logical ({:.0},{:.0}) {:.0}×{:.0}, raised above menu bar",
        lx, ly, lw, lh
      );
    });
  } else {
    log::info!("[stream] no secondary monitor found, leaving at default position");
  }

  // Re-grant getUserMedia on the new webview — the WKUIDelegate registered
  // on the main webview doesn't propagate to webviews created later, so
  // the stream window's camera input would silently fail without this.
  #[cfg(target_os = "macos")]
  {
    let _ = window.with_webview(|webview| {
      let wk: cocoa::base::id = webview.inner() as cocoa::base::id;
      media_permission::install_on_webview(wk);
    });
  }

  Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  #[cfg(target_os = "macos")]
  use tauri::Manager;

  tauri::Builder::default()
    .plugin(tauri_plugin_fs::init())
    .plugin(tauri_plugin_dialog::init())
    .manage(recording::RecordingRegistry::default())
    .manage(midi::MidiRegistry::default())
    .invoke_handler(tauri::generate_handler![
      recording::recording_start,
      recording::recording_write_chunk,
      recording::recording_finalize,
      recording::recording_cancel,
      projectfs::save_text_file,
      projectfs::read_text_file,
      projectfs::get_recordings_dir,
      projectfs::reveal_in_finder,
      midi::midi_list_ports,
      midi::midi_subscribe_input,
      midi::midi_unsubscribe_input,
      midi::midi_unsubscribe_all_inputs,
      midi::midi_send,
      midi::midi_panic,
      samples::list_sample_kits,
      samples::get_user_samples_dir,
      samples::read_audio_file,
      samples::trash_sample_kit,
      audio::audio_list_output_devices,
      audio::audio_open_device,
      audio::audio_close_device,
      audio::audio_status,
      audio::audio_test_tone,
      audio::audio_load_sample,
      audio::audio_load_sample_from_bytes,
      audio::audio_load_bundled_sample,
      audio::audio_trigger_sample,
      audio::audio_set_track_filter,
      audio::audio_set_track_filters_bulk,
      audio::audio_set_reverb_params,
      audio::audio_set_mix_routing,
      audio::audio_set_saturation_params,
      audio::audio_set_tape_params,
      audio::audio_set_glitch_params,
      audio::audio_glitch_fire,
      audio::audio_set_master_filters,
      audio::audio_set_master_comp,
      audio::audio_set_master_dist,
      audio::audio_set_master_gate,
      audio::audio_set_master_bypass,
      audio::audio_start_recording_combined,
      audio::audio_stop_recording_combined,
      audio::audio_is_recording_combined,
      audio::audio_start_recording_splits,
      audio::audio_stop_recording_splits,
      audio::audio_is_recording_splits,
      audio::audio_stop_all,
      audio::audio_fade_textures,
      audio::audio_freeze_voice_params,
      audio::audio_set_lfos,
      toggle_stream_window,
      pool_list_visuals,
      pool_get_dir,
    ])
    .setup(|app| {
      #[cfg(target_os = "macos")]
      {
        set_dock_icon();
        if let Some(window) = app.get_webview_window("main") {
          let _ = window.with_webview(|webview| {
            // wry's PlatformWebview on macOS exposes the underlying
            // WKWebView via .inner() as a *mut c_void (NSObject pointer).
            let wk: cocoa::base::id = webview.inner() as cocoa::base::id;
            media_permission::install_on_webview(wk);
          });
        }
      }
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }

      // Audio output level emitter — reads the per-block peak the cpal
      // callback stashes in audio::AUDIO_OUTPUT_LEVEL and forwards it
      // to all webviews as the `audio:level` Tauri event at ~30Hz.
      // Daemon thread (no shutdown plumbing) — OS reaps on app exit.
      {
        use tauri::Emitter;
        let app_handle = app.handle().clone();
        std::thread::spawn(move || loop {
          std::thread::sleep(std::time::Duration::from_millis(33));
          let level = audio::audio_output_level();
          if let Err(e) = app_handle.emit("audio:level", level) {
            log::warn!("[audio:level emit] {}", e);
          }
        });
      }

      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
