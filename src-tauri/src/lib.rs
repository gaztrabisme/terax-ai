pub mod modules;

use modules::{fs, git, net, pi, pty, shell, workspace};
use std::sync::Mutex;
use tauri::{Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};
#[cfg(target_os = "macos")]
use tauri::{PhysicalPosition, WindowEvent};
use tauri_plugin_window_state::StateFlags;

/// Drained on first read so HMR / re-mounts can't replay the launch dir.
#[derive(Default)]
struct LaunchDir(Mutex<Option<String>>);

#[tauri::command]
fn get_launch_dir(state: State<'_, LaunchDir>) -> Option<String> {
    state.0.lock().expect("LaunchDir mutex poisoned").take()
}

/// Drained on first read so HMR / re-mounts can't replay the launch flag.
#[derive(Default)]
struct LaunchPi(Mutex<bool>);

#[tauri::command]
fn get_launch_pi(state: State<'_, LaunchPi>) -> bool {
    let mut flag = state.0.lock().expect("LaunchPi mutex poisoned");
    std::mem::take(&mut *flag)
}

/// Drained on first read so HMR / re-mounts can't replay the launch path.
#[derive(Default)]
struct LaunchLauncherDir(Mutex<Option<String>>);

#[tauri::command]
fn get_launch_launcher_dir(state: State<'_, LaunchLauncherDir>) -> Option<String> {
    state
        .0
        .lock()
        .expect("LaunchLauncherDir mutex poisoned")
        .take()
}

fn parse_launch_pi() -> bool {
    launch_pi_from_args(std::env::args().skip(1))
}

fn launch_pi_from_args<I, S>(args: I) -> bool
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    args.into_iter().any(|arg| arg.as_ref() == "--pi")
}

/// Value of `--launcher-dir <path>` from the CLI args, or None. The launcher
/// passes it next to `--pi` so the app can adopt the checkout as the
/// launcherDir preference on first run.
fn parse_launch_launcher_dir() -> Option<String> {
    launch_launcher_dir_from_args(std::env::args().skip(1)).map(|dir| {
        std::fs::canonicalize(&dir)
            .map(|canon| crate::modules::fs::to_canon(&canon))
            .unwrap_or(dir)
    })
}

fn launch_launcher_dir_from_args<I, S>(args: I) -> Option<String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut iter = args.into_iter().map(|arg| arg.as_ref().to_string());
    while let Some(arg) = iter.next() {
        if arg == "--launcher-dir" {
            match iter.next() {
                // `--launcher-dir` followed by another flag or nothing is a
                // malformed pair; treat it as absent rather than guessing.
                Some(path) if !path.starts_with('-') && !path.trim().is_empty() => {
                    return Some(path)
                }
                _ => return None,
            }
        }
    }
    None
}

fn parse_launch_dir() -> Option<String> {
    for arg in std::env::args().skip(1) {
        if arg.starts_with('-') {
            continue;
        }
        let Ok(canon) = std::fs::canonicalize(&arg) else {
            continue;
        };
        if !canon.is_dir() {
            continue;
        }
        return Some(crate::modules::fs::to_canon(&canon));
    }
    None
}

#[tauri::command]
async fn open_settings_window(app: tauri::AppHandle, tab: Option<String>) -> Result<(), String> {
    let url_path = match tab.as_deref() {
        Some(t) if !t.is_empty() => format!("settings.html?tab={}", t),
        _ => "settings.html".to_string(),
    };

    if let Some(window) = app.get_webview_window("settings") {
        let _ = window.set_always_on_top(true);
        let _ = window.show();
        let _ = window.set_focus();
        if let Some(t) = tab.as_deref().filter(|s| !s.is_empty()) {
            // emit() serializes via JSON — no string-escape footgun, unlike
            // eval() with format!(). Frontend listens via Tauri event API.
            let _ = window.emit("terax:settings-tab", t);
        }
        return Ok(());
    }

    let builder = WebviewWindowBuilder::new(&app, "settings", WebviewUrl::App(url_path.into()))
        .title("Settings")
        .inner_size(900.0, 700.0)
        .min_inner_size(820.0, 620.0)
        .resizable(true)
        .visible(false)
        // Keep settings above the main app window so it doesn't get hidden
        // when the user clicks back into the editor or terminal (#33).
        .always_on_top(true);

    // Tie lifecycle to the main window so settings minimizes/closes with it.
    // macOS: skip parent() — child + always_on_top leaves the settings webview
    // behind the main window except while the parent is being dragged (#33).
    #[cfg(not(target_os = "macos"))]
    let builder = if let Some(main) = app.get_webview_window("main") {
        builder.parent(&main).map_err(|e| e.to_string())?
    } else {
        builder
    };

    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true);

    // On Linux/Windows we render our own titlebar, so drop native chrome
    // and make the window transparent.
    #[cfg(any(target_os = "linux", target_os = "windows"))]
    let builder = builder.decorations(false).transparent(true);

    let window = builder.build().map_err(|e| e.to_string())?;

    // Some Linux compositors (GNOME/Mutter with CSD-by-default) ignore the
    // builder-time decorations flag — re-assert it after realize.
    #[cfg(target_os = "linux")]
    {
        let _ = window.set_decorations(false);
    }

    #[cfg(target_os = "macos")]
    if let Some(main) = app.get_webview_window("main") {
        if let (Ok(main_pos), Ok(main_size), Ok(settings_size)) = (
            main.outer_position(),
            main.outer_size(),
            window.outer_size(),
        ) {
            let x = main_pos.x
                + ((main_size.width as i32).saturating_sub(settings_size.width as i32)) / 2;
            let y = main_pos.y
                + ((main_size.height as i32).saturating_sub(settings_size.height as i32)) / 2;
            let _ = window.set_position(PhysicalPosition::new(x, y));
        } else {
            let _ = window.center();
        }
    }

    Ok(())
}

/// Clamp a restored window to the current monitor's work area. Called once in
/// setup for `--pi` launches, after the window-state plugin has restored the
/// saved geometry: a window saved on a bigger (or since-disconnected) monitor
/// would otherwise open oversized or off-screen.
fn clamp_window_to_work_area(window: &tauri::WebviewWindow) {
    let Ok(Some(monitor)) = window.current_monitor() else {
        return;
    };
    let area = monitor.work_area();
    let (area_x, area_y) = (area.position.x, area.position.y);
    let (area_w, area_h) = (area.size.width as i32, area.size.height as i32);
    if area_w <= 0 || area_h <= 0 {
        return;
    }

    let Ok(size) = window.outer_size() else {
        return;
    };
    let Ok(pos) = window.outer_position() else {
        return;
    };

    let width = (size.width as i32).min(area_w).max(1) as u32;
    let height = (size.height as i32).min(area_h).max(1) as u32;
    if width != size.width || height != size.height {
        let _ = window.set_size(tauri::PhysicalSize::new(width, height));
    }

    let out_of_bounds = pos.x < area_x
        || pos.y < area_y
        || pos.x + size.width as i32 > area_x + area_w
        || pos.y + size.height as i32 > area_y + area_h;
    if !out_of_bounds {
        return;
    }
    // Fits: re-center in the work area. Otherwise: pin inside it.
    let (x, y) = if width < area_w as u32 && height < area_h as u32 {
        (
            area_x + (area_w - width as i32) / 2,
            area_y + (area_h - height as i32) / 2,
        )
    } else {
        (
            pos.x.max(area_x).min(area_x + area_w - width as i32),
            pos.y.max(area_y).min(area_y + area_h - height as i32),
        )
    };
    let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let cli_dir = parse_launch_dir();
    let cli_pi = parse_launch_pi();
    let cli_launcher_dir = parse_launch_launcher_dir();
    workspace::init_launch_cwd(cli_dir.as_deref());

    tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        // Skip restoring VISIBLE — frontend calls window.show() after first
        // paint so the user never sees a transparent window-shadow flash on
        // Windows/Linux.
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(StateFlags::all() & !StateFlags::VISIBLE)
                .build(),
        )
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_os::init())
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(tauri_plugin_log::log::LevelFilter::Info)
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(move |app| {
            // Config windows (incl. "main") are created just above, so the
            // window-state plugin has already restored the saved geometry.
            // --pi launches then clamp it to the visible work area.
            if cli_pi {
                if let Some(window) = app.get_webview_window("main") {
                    clamp_window_to_work_area(&window);
                }
            }
            // macOS skips parent() for the settings window, so tie its lifecycle
            // to the main window here instead. Other platforms keep parent().
            #[cfg(target_os = "macos")]
            if let Some(main) = app.get_webview_window("main") {
                let handle = app.handle().clone();
                main.on_window_event(move |event| {
                    if matches!(
                        event,
                        WindowEvent::CloseRequested { .. } | WindowEvent::Destroyed
                    ) {
                        if let Some(settings) = handle.get_webview_window("settings") {
                            let _ = settings.close();
                        }
                    }
                });
            }
            Ok(())
        })
        .manage(pty::PtyState::default())
        .manage(pi::PiState::default())
        .manage(pi::PiTranscriptState::default())
        .manage(shell::ShellState::default())
        .manage(fs::watch::FsWatchState::default())
        .manage({
            let registry = workspace::WorkspaceRegistry::default();
            workspace::bootstrap_registry(&registry);
            if let Some(ref launch_dir) = cli_dir {
                let _ = registry.authorize(launch_dir);
            }
            registry
        })
        .manage(LaunchDir(Mutex::new(cli_dir)))
        .manage(LaunchPi(Mutex::new(cli_pi)))
        .manage(LaunchLauncherDir(Mutex::new(cli_launcher_dir)))
        .invoke_handler(tauri::generate_handler![
            pty::pty_open,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_close,
            pty::pty_close_all,
            pty::pty_has_foreground_process,
            pi::pi_open,
            pi::pi_home_dir,
            pi::pi_paths,
            pi::health::pi_health,
            pi::pi_prepare,
            pi::pi_send,
            pi::pi_kill,
            pi::pi_watch_transcripts,
            pi::pi_unwatch,
            fs::tree::list_subdirs,
            fs::tree::fs_read_dir,
            fs::file::fs_read_file,
            fs::file::fs_write_file,
            fs::file::fs_stat,
            fs::file::fs_canonicalize,
            fs::mutate::fs_create_file,
            fs::mutate::fs_create_dir,
            fs::mutate::fs_rename,
            fs::mutate::fs_delete,
            fs::watch::fs_watch_add,
            fs::watch::fs_watch_remove,
            fs::search::fs_search,
            fs::search::fs_list_files,
            fs::grep::fs_grep,
            fs::grep::fs_glob,
            git::commands::git_resolve_repo,
            git::commands::git_panel_snapshot,
            git::commands::git_status,
            git::commands::git_diff,
            git::commands::git_diff_content,
            git::commands::git_stage,
            git::commands::git_unstage,
            git::commands::git_discard,
            git::commands::git_commit,
            git::commands::git_fetch,
            git::commands::git_pull_ff_only,
            git::commands::git_push,
            git::commands::git_log,
            git::commands::git_show_commit,
            git::commands::git_commit_files,
            git::commands::git_commit_file_diff,
            git::commands::git_remote_url,
            shell::shell_run_command,
            shell::shell_session_open,
            shell::shell_session_run,
            shell::shell_session_close,
            shell::shell_bg_spawn,
            shell::shell_bg_logs,
            shell::shell_bg_kill,
            shell::shell_bg_list,
            workspace::wsl_list_distros,
            workspace::wsl_default_distro,
            workspace::wsl_home,
            workspace::workspace_authorize,
            workspace::workspace_current_dir,
            get_launch_dir,
            get_launch_pi,
            get_launch_launcher_dir,
            open_settings_window,
            net::lm_ping,
            net::ai_http_request,
            net::ai_http_stream,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod launch_args_tests {
    use super::{launch_launcher_dir_from_args, launch_pi_from_args};

    #[test]
    fn bare_flag_is_detected() {
        assert!(launch_pi_from_args(["--pi"]));
    }

    #[test]
    fn flag_is_detected_among_positional_and_flags() {
        assert!(launch_pi_from_args(["/tmp", "--pi"]));
        assert!(launch_pi_from_args(["--pi", "/tmp"]));
        assert!(launch_pi_from_args(["--some-flag", "/tmp", "--pi"]));
    }

    #[test]
    fn similar_but_distinct_args_are_not_detected() {
        assert!(!launch_pi_from_args(["--pia", "--pi=1", "pi", "-p"]));
    }

    #[test]
    fn empty_argv_is_false() {
        assert!(!launch_pi_from_args(Vec::<&str>::new()));
    }

    #[test]
    fn launcher_dir_flag_yields_its_value() {
        assert_eq!(
            launch_launcher_dir_from_args([
                "--args",
                "/work/proj",
                "--pi",
                "--launcher-dir",
                "/home/me/lab/efficient-pi",
            ]),
            Some("/home/me/lab/efficient-pi".to_string())
        );
    }

    #[test]
    fn launcher_dir_is_found_before_and_after_pi() {
        assert_eq!(
            launch_launcher_dir_from_args([
                "--launcher-dir",
                "/first/checkout",
                "--pi",
            ]),
            Some("/first/checkout".to_string())
        );
        assert_eq!(
            launch_launcher_dir_from_args([
                "--pi",
                "--launcher-dir",
                "/second/checkout",
            ]),
            Some("/second/checkout".to_string())
        );
    }

    #[test]
    fn launcher_dir_without_a_value_is_absent() {
        assert_eq!(launch_launcher_dir_from_args(["--pi", "--launcher-dir"]), None);
        // A following flag is not a path; the pair is malformed, not guessed.
        assert_eq!(
            launch_launcher_dir_from_args(["--launcher-dir", "--pi"]),
            None
        );
    }

    #[test]
    fn launcher_dir_absent_or_repeated_takes_the_first_value() {
        assert_eq!(
            launch_launcher_dir_from_args(["--pi", "/tmp"]),
            None::<String>
        );
        assert_eq!(
            launch_launcher_dir_from_args(Vec::<&str>::new()),
            None::<String>
        );
        assert_eq!(
            launch_launcher_dir_from_args([
                "--launcher-dir",
                "/one",
                "--launcher-dir",
                "/two",
            ]),
            Some("/one".to_string())
        );
    }

    #[test]
    fn launcher_dir_ignores_the_equals_form_and_blank_values() {
        // The launcher passes a separated pair; "--launcher-dir=path" is an
        // unknown flag and never matches.
        assert_eq!(
            launch_launcher_dir_from_args(["--launcher-dir=/x"]),
            None::<String>
        );
        assert_eq!(
            launch_launcher_dir_from_args(["--launcher-dir", "   "]),
            None::<String>
        );
    }
}
