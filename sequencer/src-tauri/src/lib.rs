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
      audio::audio_set_lfos,
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
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
