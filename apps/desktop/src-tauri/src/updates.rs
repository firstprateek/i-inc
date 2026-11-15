// The app updates itself from the daemon it shows (apps/daemon/src/desktop-updates.ts serves the builds under
// /desktop/, and apps/desktop/scripts/release.ts puts them there). Tauri's updater plugin downloads a build,
// checks it against the public key in tauri.conf.json (only the host's signing key can make one it accepts, and
// the signature must name the version announced), and puts it in this app's place. The page then offers a
// restart (apps/web/src/app-update.ts). It asks when a daemon page loads, at most every half hour, and from
// i.inc › Check for Updates…; only the daemon the launcher chose is ever asked.
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager, Url, WebviewWindow};
use tauri_plugin_updater::UpdaterExt;

const EVERY: Duration = Duration::from_secs(30 * 60);

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
            let endpoint = Url::parse(&format!("{origin}/desktop/latest.json")).map_err(|e| e.to_string())?;
            let updater = app
                .updater_builder()
                .endpoints(vec![endpoint])
                .map_err(|e| e.to_string())?
                .timeout(Duration::from_secs(120))
                .build()
                .map_err(|e| e.to_string())?;
            match updater.check().await.map_err(|e| format!("could not ask the daemon ({e})"))? {
                None => Ok(Some(format!("The i.inc app is up to date ({}).", app.package_info().version))),
                Some(update) => {
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
