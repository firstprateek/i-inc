// i.inc desktop: a window onto the daemon. The bundled launcher page picks the daemon's address, then the
// window loads the daemon's own pages, so the desktop app is the web app (same login cookie, same build) and a
// web change needs no new app. The window has no system title bar: the web app's header is the title bar.
// Build with I_INC_URL set to the tailnet address (https://iinc.<tailnet>.ts.net) to open straight onto it;
// on the Mac mini itself the launcher finds the daemon on loopback first.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::menu::{Menu, MenuItem, MenuItemKind, PredefinedMenuItem, Submenu};
use tauri::webview::NewWindowResponse;
use tauri::{Manager, Url, WebviewWindowBuilder};

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
            let config = app.config().app.windows.first().expect("window config").clone();
            WebviewWindowBuilder::from_config(app.handle(), &config)?
                .on_new_window(|url, _| {
                    open_in_browser(&url);
                    NewWindowResponse::Deny
                })
                .build()?;

            let menu = Menu::default(app.handle())?;
            let change = MenuItem::with_id(app, "change-daemon", "Change Daemon…", true, None::<&str>)?;
            let reload = MenuItem::with_id(app, "reload", "Reload", true, Some("CmdOrCtrl+R"))?;
            let back = MenuItem::with_id(app, "back", "Back", true, Some("CmdOrCtrl+["))?;
            let forward = MenuItem::with_id(app, "forward", "Forward", true, Some("CmdOrCtrl+]"))?;
            let items = menu.items()?;
            if let Some(MenuItemKind::Submenu(first)) = items.first() {
                first.insert(&PredefinedMenuItem::separator(app)?, 1)?;
                first.insert(&change, 2)?;
            }
            // The View menu gets Reload, Back and Forward (a window with no browser around it has no buttons for
            // them besides the header's own).
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
            view.prepend_items(&[&reload, &back, &forward, &PredefinedMenuItem::separator(app)?])?;
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
                _ => {}
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running i.inc");
}
