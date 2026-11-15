// i.inc desktop: a window onto the daemon. The bundled launcher page picks the daemon's address, then the
// window loads the daemon's own pages, so the desktop app is the web app (same login cookie, same build) and a
// web change needs no new app. The window has no system title bar: the web app's header is the title bar.
// Build with I_INC_URL set to the tailnet address (https://iinc.<tailnet>.ts.net) to open straight onto it;
// on the Mac mini itself the launcher finds the daemon on loopback first.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;
use std::sync::Mutex;

use tauri::menu::{Menu, MenuItem, MenuItemKind, PredefinedMenuItem, Submenu};
use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::{AppHandle, Manager, Url, WebviewWindow, WebviewWindowBuilder, WindowEvent};

/// The page zoom (⌘+ / ⌘− / ⌘0): WebKit has no zoom shortcuts of its own in an app window. It is kept in a
/// file in the app's config folder and applied on every page load.
struct Zoom(Mutex<f64>);

const ZOOM_STEPS: [f64; 5] = [0.8, 0.9, 1.0, 1.1, 1.2];

fn zoom_file(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("zoom"))
}

fn saved_zoom(app: &AppHandle) -> f64 {
    zoom_file(app)
        .and_then(|f| std::fs::read_to_string(f).ok())
        .and_then(|t| t.trim().parse::<f64>().ok())
        .map(nearest_step)
        .unwrap_or(1.0)
}

/// The step closest to `zoom` (a level saved by an older build may not be one).
fn nearest_step(zoom: f64) -> f64 {
    ZOOM_STEPS
        .iter()
        .copied()
        .min_by(|a, b| (a - zoom).abs().total_cmp(&(b - zoom).abs()))
        .unwrap_or(1.0)
}

/// The next step up or down from `now`, or 1 for `0`.
fn step_zoom(now: f64, dir: i8) -> f64 {
    match dir {
        0 => 1.0,
        d if d > 0 => ZOOM_STEPS.iter().copied().find(|z| *z > now + 1e-6).unwrap_or(now),
        _ => ZOOM_STEPS.iter().copied().rev().find(|z| *z < now - 1e-6).unwrap_or(now),
    }
}

/// Zooms the page and tells it the level, so the header (the window's title bar) can stay the size of the
/// window buttons, which do not zoom, and, when `show`, so it shows the level for a moment (apps/web/src/
/// desktop.ts). A page load reapplies the level without showing it. Only an `f64` and a `bool` are formatted
/// into the script.
fn apply_zoom(window: &WebviewWindow, zoom: f64, show: bool) {
    let _ = window.set_zoom(zoom);
    let _ = window.eval(format!(
        "window.__I_INC_ZOOM__ = {zoom}; window.dispatchEvent(new CustomEvent('i-inc:zoom', {{ detail: {{ show: {show} }} }}));"
    ));
}

/// Tells the page whether the window is in full screen, where macOS hides the window buttons and the header
/// needs no room for them. The page cannot tell by itself: page zoom changes its own size, and on a Mac with a
/// notch a full-screen window is shorter than the screen.
fn push_fullscreen(window: &WebviewWindow) {
    let full = window.is_fullscreen().unwrap_or(false);
    let _ = window.eval(format!(
        "window.__I_INC_FULLSCREEN__ = {full}; window.dispatchEvent(new Event('i-inc:fullscreen'));"
    ));
}

/// Tells the page which build of the app it is in, so a page newer than the app can say the app is out of date
/// (apps/web/src/desktop.ts, `MIN_APP_VERSION`). A semver string: digits, letters, dots, `-` and `+` only.
fn push_version(window: &WebviewWindow) {
    let version = window.app_handle().package_info().version.to_string();
    if version.chars().all(|c| c.is_ascii_alphanumeric() || ".-+".contains(c)) {
        let _ = window.eval(format!("window.__I_INC_APP_VERSION__ = \"{version}\";"));
    }
}

/// The daemon the launcher connected to (its origin). The window may show only that daemon's pages and the
/// launcher; any other address opens in the default browser, so no other site ever gets the pages' capability.
struct Daemon(Mutex<Option<String>>);

/// The launcher names the daemon it is about to open (`launcher.js`); only the bundled launcher may call this.
#[tauri::command]
fn use_daemon(origin: String, daemon: tauri::State<'_, Daemon>) -> Result<(), String> {
    let url = Url::parse(&origin).map_err(|_| "not an address".to_string())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("not a web address".to_string());
    }
    *daemon.0.lock().unwrap() = Some(url.origin().ascii_serialization());
    Ok(())
}

/// True for an address the window may show: the bundled launcher, or the chosen daemon's own pages.
fn may_show(url: &Url, daemon: Option<&str>) -> bool {
    match url.scheme() {
        "tauri" | "about" => true,
        "http" | "https" if url.host_str() == Some("tauri.localhost") => true,
        "http" | "https" => daemon.is_some_and(|d| url.origin().ascii_serialization() == d),
        _ => false,
    }
}

fn change_zoom(app: &AppHandle, window: &WebviewWindow, dir: i8) {
    let state = app.state::<Zoom>();
    let mut zoom = state.0.lock().unwrap();
    *zoom = step_zoom(*zoom, dir);
    apply_zoom(window, *zoom, true);
    if let Some(file) = zoom_file(app) {
        let _ = file.parent().map(std::fs::create_dir_all);
        let _ = std::fs::write(file, zoom.to_string());
    }
}

/// The daemon address this build was made for, from `I_INC_URL` at build time. A saved address and a daemon
/// on this machine come first (apps/desktop/launcher/launcher.js).
#[tauri::command]
fn default_daemon() -> Option<&'static str> {
    option_env!("I_INC_URL").filter(|s| !s.is_empty())
}

/// An address given at launch (`I_INC_URL=… open -a i.inc`, or the binary run by hand): it beats every other,
/// for trying the app against another daemon, such as a scratch one serving a branch's build.
#[tauri::command]
fn daemon_override() -> Option<String> {
    std::env::var("I_INC_URL").ok().filter(|s| !s.is_empty())
}

/// The zoom popup's Reset button (apps/web/src/desktop.ts): back to 100%, like ⌘0.
#[tauri::command]
fn reset_zoom(window: WebviewWindow) {
    change_zoom(window.app_handle(), &window, 0);
}

/// The bundled launcher page. `change` keeps it from connecting straight away.
fn launcher_url(change: bool) -> Url {
    let base = if cfg!(windows) { "http://tauri.localhost/" } else { "tauri://localhost/" };
    let query = if change { "?change=1" } else { "" };
    Url::parse(&format!("{base}{query}")).expect("launcher url")
}

/// A link that asks for a new window (`target="_blank"`: a pull request on GitHub, a source) opens in the
/// default browser; the app itself stays one window.
fn open_in_browser(url: &Url) {
    if !matches!(url.scheme(), "http" | "https") {
        return;
    }
    #[cfg(target_os = "macos")]
    let _ = std::process::Command::new("open").arg(url.as_str()).spawn();
    #[cfg(target_os = "windows")]
    let _ = std::process::Command::new("explorer").arg(url.as_str()).spawn();
    #[cfg(target_os = "linux")]
    let _ = std::process::Command::new("xdg-open").arg(url.as_str()).spawn();
}

fn main() {
    tauri::Builder::default()
        // The window has no system title bar (tauri.conf.json): the web app's header is the title bar. This
        // mark tells the daemon's pages so, on every page load; a browser never sets it, so there the pages keep
        // their plain header (apps/web/src/desktop.ts).
        .plugin(
            tauri::plugin::Builder::<tauri::Wry, ()>::new("titlebar")
                .js_init_script("window.__I_INC_TITLEBAR__ = true;".to_string())
                .build(),
        )
        .invoke_handler(tauri::generate_handler![default_daemon, daemon_override, reset_zoom, use_daemon])
        .on_window_event(|window, event| {
            if let WindowEvent::Resized(_) = event {
                if let Some(w) = window.app_handle().get_webview_window(window.label()) {
                    push_fullscreen(&w);
                }
            }
        })
        .setup(|app| {
            app.manage(Zoom(Mutex::new(saved_zoom(app.handle()))));
            app.manage(Daemon(Mutex::new(None)));
            let handle = app.handle().clone();
            let config = app.config().app.windows.first().expect("window config").clone();
            WebviewWindowBuilder::from_config(app.handle(), &config)?
                .on_new_window(|url, _| {
                    open_in_browser(&url);
                    NewWindowResponse::Deny
                })
                .on_navigation(move |url| {
                    let daemon = handle.state::<Daemon>().0.lock().unwrap().clone();
                    let ok = may_show(url, daemon.as_deref());
                    if !ok {
                        open_in_browser(url);
                    }
                    ok
                })
                .on_page_load(|window, payload| {
                    if payload.event() == PageLoadEvent::Finished {
                        let zoom = *window.app_handle().state::<Zoom>().0.lock().unwrap();
                        push_version(&window);
                        push_fullscreen(&window);
                        apply_zoom(&window, zoom, false);
                    }
                })
                .build()?;

            let menu = Menu::default(app.handle())?;
            let change = MenuItem::with_id(app, "change-daemon", "Change Daemon…", true, None::<&str>)?;
            let reload = MenuItem::with_id(app, "reload", "Reload", true, Some("CmdOrCtrl+R"))?;
            let back = MenuItem::with_id(app, "back", "Back", true, Some("CmdOrCtrl+["))?;
            let forward = MenuItem::with_id(app, "forward", "Forward", true, Some("CmdOrCtrl+]"))?;
            let zoom_in = MenuItem::with_id(app, "zoom-in", "Zoom In", true, Some("CmdOrCtrl+="))?;
            let zoom_out = MenuItem::with_id(app, "zoom-out", "Zoom Out", true, Some("CmdOrCtrl+-"))?;
            let zoom_reset = MenuItem::with_id(app, "zoom-reset", "Actual Size", true, Some("CmdOrCtrl+0"))?;
            let items = menu.items()?;
            if let Some(MenuItemKind::Submenu(first)) = items.first() {
                first.insert(&PredefinedMenuItem::separator(app)?, 1)?;
                first.insert(&change, 2)?;
            }
            // The View menu gets Reload, Back, Forward and the zoom (a window with no browser around it has no
            // buttons or shortcuts for them besides the header's own).
            let view = items.iter().find_map(|item| match item {
                MenuItemKind::Submenu(s) if s.text().ok().as_deref() == Some("View") => Some(s.clone()),
                _ => None,
            });
            let view = match view {
                Some(v) => v,
                None => {
                    let v = Submenu::new(app, "View", true)?;
                    menu.append(&v)?;
                    v
                }
            };
            view.prepend_items(&[
                &reload,
                &back,
                &forward,
                &PredefinedMenuItem::separator(app)?,
                &zoom_reset,
                &zoom_in,
                &zoom_out,
                &PredefinedMenuItem::separator(app)?,
            ])?;
            app.set_menu(menu)?;
            Ok(())
        })
        .on_menu_event(|app, event| {
            let Some(window) = app.get_webview_window("main") else { return };
            match event.id().as_ref() {
                "change-daemon" => {
                    let _ = window.navigate(launcher_url(true));
                }
                "reload" => {
                    let _ = window.eval("location.reload()");
                }
                "back" => {
                    let _ = window.eval("history.back()");
                }
                "forward" => {
                    let _ = window.eval("history.forward()");
                }
                "zoom-in" => change_zoom(app, &window, 1),
                "zoom-out" => change_zoom(app, &window, -1),
                "zoom-reset" => change_zoom(app, &window, 0),
                _ => {}
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running i.inc");
}

#[cfg(test)]
mod tests {
    use super::{may_show, step_zoom};
    use tauri::Url;

    #[test]
    fn the_window_shows_only_the_launcher_and_the_chosen_daemon() {
        let d = Some("https://iinc.example.ts.net");
        let ok = |u: &str| may_show(&Url::parse(u).unwrap(), d);
        assert!(ok("tauri://localhost/?change=1"));
        assert!(ok("http://tauri.localhost/"));
        assert!(ok("https://iinc.example.ts.net/#/work/board"));
        assert!(!ok("https://iinc.example.ts.net:8443/"));
        assert!(!ok("https://other.example.ts.net/"));
        assert!(!ok("https://github.com/firstprateek/i-inc"));
        assert!(!ok("http://127.0.0.1:5173/"));
        assert!(!ok("file:///etc/passwd"));
        // Before the launcher has chosen, no web page at all.
        assert!(!may_show(&Url::parse("https://iinc.example.ts.net/").unwrap(), None));
    }

    #[test]
    fn zoom_steps_up_down_and_back_to_actual_size() {
        assert_eq!(step_zoom(1.0, 1), 1.1);
        assert_eq!(step_zoom(1.0, -1), 0.9);
        assert_eq!(step_zoom(1.1, 1), 1.2);
        assert_eq!(step_zoom(1.2, 1), 1.2);
        assert_eq!(step_zoom(0.9, -1), 0.8);
        assert_eq!(step_zoom(0.8, -1), 0.8);
        assert_eq!(step_zoom(1.2, 0), 1.0);
    }

    #[test]
    fn a_saved_level_off_the_steps_snaps_to_the_nearest() {
        use super::nearest_step;
        assert_eq!(nearest_step(1.5), 1.2);
        assert_eq!(nearest_step(0.75), 0.8);
        assert_eq!(nearest_step(1.04), 1.0);
    }
}
