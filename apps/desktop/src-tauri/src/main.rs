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
use tauri::{AppHandle, Manager, Url, WebviewWindow, WebviewWindowBuilder};

/// The page zoom (⌘+ / ⌘− / ⌘0): WebKit has no zoom shortcuts of its own in an app window. It is kept in a
/// file in the app's config folder and applied on every page load.
struct Zoom(Mutex<f64>);

const ZOOM_STEPS: [f64; 9] = [0.75, 0.85, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0];

fn zoom_file(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("zoom"))
}

fn saved_zoom(app: &AppHandle) -> f64 {
    zoom_file(app)
        .and_then(|f| std::fs::read_to_string(f).ok())
        .and_then(|t| t.trim().parse::<f64>().ok())
        .filter(|z| (0.5..=3.0).contains(z))
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
/// window buttons, which do not zoom (apps/web/src/desktop.ts).
fn apply_zoom(window: &WebviewWindow, zoom: f64) {
    let _ = window.set_zoom(zoom);
    let _ = window.eval(format!(
        "window.__I_INC_ZOOM__ = {zoom}; window.dispatchEvent(new Event('i-inc:zoom'));"
    ));
}

fn change_zoom(app: &AppHandle, window: &WebviewWindow, dir: i8) {
    let state = app.state::<Zoom>();
    let mut zoom = state.0.lock().unwrap();
    *zoom = step_zoom(*zoom, dir);
    apply_zoom(window, *zoom);
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
        .invoke_handler(tauri::generate_handler![default_daemon, daemon_override])
        .setup(|app| {
            app.manage(Zoom(Mutex::new(saved_zoom(app.handle()))));
            let config = app.config().app.windows.first().expect("window config").clone();
            WebviewWindowBuilder::from_config(app.handle(), &config)?
                .on_new_window(|url, _| {
                    open_in_browser(&url);
                    NewWindowResponse::Deny
                })
                .on_page_load(|window, payload| {
                    if payload.event() == PageLoadEvent::Finished {
                        let zoom = *window.app_handle().state::<Zoom>().0.lock().unwrap();
                        apply_zoom(&window, zoom);
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
    use super::step_zoom;

    #[test]
    fn zoom_steps_up_down_and_back_to_actual_size() {
        assert_eq!(step_zoom(1.0, 1), 1.1);
        assert_eq!(step_zoom(1.0, -1), 0.9);
        assert_eq!(step_zoom(2.0, 1), 2.0);
        assert_eq!(step_zoom(0.75, -1), 0.75);
        assert_eq!(step_zoom(1.3, 1), 1.5);
        assert_eq!(step_zoom(1.75, 0), 1.0);
    }
}
