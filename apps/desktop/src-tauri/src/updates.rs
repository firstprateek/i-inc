// The app updates itself from the daemon it shows (apps/daemon/src/desktop-updates.ts serves the builds under
// /desktop/, and apps/desktop/scripts/release.ts puts them there). Tauri's updater plugin downloads a build,
// checks it against the public key in tauri.conf.json (only the host's signing key can make one it accepts, and
// the signature must name the version announced), and puts it in this app's place. The page then offers a
// restart (apps/web/src/app-update.ts). It asks when a daemon page loads and every half hour while the app runs
// (the web app routes by #hash, so a window left open has no page loads), and from i.inc › Check for Updates…;
// only the daemon the launcher chose is ever asked.
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager, Url, WebviewWindow};
use tauri_plugin_updater::UpdaterExt;

pub const EVERY: Duration = Duration::from_secs(30 * 60);
/// The longest a download may take; without it a laptop that sleeps mid-download would keep `busy` set and
/// drop every later check, the menu's included (the plugin sets no timeout on the download itself).
const DOWNLOAD_LIMIT: Duration = Duration::from_secs(15 * 60);

#[derive(Default)]
pub struct Updates {
    busy: AtomicBool,
    last: Mutex<Option<Instant>>,
    /// The version installed in this app's place, waiting for a restart to run.
    ready: Mutex<Option<String>>,
}

/// True for a copy that may replace itself: a release build that is not running from a cargo `target` folder
/// (a build being tested is left alone).
fn installed_copy() -> bool {
    if cfg!(debug_assertions) {
        return false;
    }
    std::env::current_exe()
        .ok()
        .and_then(|p| p.canonicalize().ok())
        .is_some_and(|p| !p.components().any(|c| c.as_os_str() == "target"))
}

/// True when the plugin can swap the bundle without asking for a password: a file can be made next to it, and the
/// bundle folder itself is writable (moving a folder to another parent needs write access to the folder, so a copy
/// installed by another account fails there even when /Applications is writable). Nothing is written inside the
/// bundle, which would break its signature.
fn bundle_folder_writable() -> bool {
    let Some(app) = std::env::current_exe()
        .ok()
        .and_then(|p| p.canonicalize().ok())
        .and_then(|p| p.ancestors().find(|a| a.extension().is_some_and(|e| e == "app")).map(|a| a.to_path_buf()))
    else {
        return false;
    };
    let Some(dir) = app.parent() else { return false };
    let probe = dir.join(format!(".i-inc-write-test-{}", std::process::id()));
    let ok = std::fs::write(&probe, b"").is_ok();
    let _ = std::fs::remove_file(&probe);
    ok && can_write(&app)
}

fn can_write(path: &std::path::Path) -> bool {
    use std::os::unix::ffi::OsStrExt;
    let Ok(c) = std::ffi::CString::new(path.as_os_str().as_bytes()) else { return false };
    // SAFETY: a valid NUL-terminated path; access() only reads it.
    unsafe { libc::access(c.as_ptr(), libc::W_OK) == 0 }
}

/// One line for the page to show for a few seconds (apps/web/src/app-update.ts).
pub fn note(app: &AppHandle, text: &str) {
    let Some(window) = app.get_webview_window("main") else { return };
    let text = serde_json::to_string(text).unwrap_or_else(|_| "\"\"".into());
    let _ = window.eval(format!("window.dispatchEvent(new CustomEvent('i-inc:app-note', {{ detail: {text} }}));"));
}

/// Tells the page that a newer build is installed and a restart will run it. Sent after every page load, since
/// the window moves between pages.
pub fn push_ready(window: &WebviewWindow) {
    let ready = window.state::<Updates>().ready.lock().ok().and_then(|r| r.clone());
    if let Some(version) = ready {
        let version = serde_json::to_string(&version).unwrap_or_else(|_| "\"\"".into());
        let _ = window.eval(format!(
            "window.__I_INC_APP_UPDATE__ = {{ version: {version} }}; window.dispatchEvent(new Event('i-inc:app-update'));"
        ));
    }
}

/// Asks the daemon at `origin` for a newer build and installs it. `loud` (the menu item) says what happened
/// either way and ignores the half-hour pause; a check on page load is silent unless there is an update.
pub fn check(app: &AppHandle, origin: String, loud: bool) {
    let state = app.state::<Updates>();
    if !loud {
        let Ok(mut last) = state.last.lock() else { return };
        if last.is_some_and(|t| t.elapsed() < EVERY) {
            return;
        }
        *last = Some(Instant::now());
    }
    if state.busy.swap(true, Ordering::SeqCst) {
        if loud {
            note(app, "Already checking for an update…");
        }
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let said: Result<Option<String>, String> = async {
            if !installed_copy() {
                return Err("this copy runs from a build folder, so it is left alone".into());
            }
            if app.state::<Updates>().ready.lock().is_ok_and(|r| r.is_some()) {
                return Ok(None);
            }
            // In a folder this account can't write to, the plugin would ask for an administrator password: only
            // when asked from the menu, never out of the blue on a page load or the timer.
            if !loud && !bundle_folder_writable() {
                return Err("the app's folder is not writable".into());
            }
            let endpoint = Url::parse(&format!("{origin}/desktop/latest.json")).map_err(|e| e.to_string())?;
            let updater = app
                .updater_builder()
                .endpoints(vec![endpoint])
                .map_err(|e| e.to_string())?
                .timeout(Duration::from_secs(30))
                .build()
                .map_err(|e| e.to_string())?;
            match updater.check().await.map_err(|e| format!("could not ask the daemon ({e})"))? {
                None => Ok(Some(format!("The i.inc app is up to date ({}).", app.package_info().version))),
                Some(mut update) => {
                    update.timeout = Some(DOWNLOAD_LIMIT);
                    update
                        .download_and_install(|_, _| {}, || {})
                        .await
                        .map_err(|e| format!("could not install {} ({e})", update.version))?;
                    if let Ok(mut ready) = app.state::<Updates>().ready.lock() {
                        *ready = Some(update.version.clone());
                    }
                    Ok(None)
                }
            }
        }
        .await;
        app.state::<Updates>().busy.store(false, Ordering::SeqCst);
        if std::env::var_os("I_INC_DEBUG_UPDATES").is_some() {
            eprintln!("update check at {origin}: {said:?}");
        }
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || match said {
            Ok(None) => {
                if let Some(w) = handle.get_webview_window("main") {
                    push_ready(&w);
                }
            }
            Ok(Some(line)) if loud => note(&handle, &line),
            Err(why) if loud => note(&handle, &format!("No update: {why}.")),
            _ => {}
        });
    });
}
