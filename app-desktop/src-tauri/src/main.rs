// Prevent an extra console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Hearth desktop miner.
//!
//! One window that answers the five questions a person mining at home actually
//! has — am I connected, am I hashing, how fast, what have I earned, and WHICH
//! ADDRESS is being paid — and a key it is safe to leave on a laptop.
//!
//! # What changed from the scaffolding this replaces
//!
//! The previous version of this file said so itself: three native commands with
//! zero callers, a `frontendDist` pointing at static web pages that never call
//! `invoke`, and a `node_entry()` that resolved relative to the CURRENT WORKING
//! DIRECTORY and so could only work from a developer's checkout. It was honest
//! about being unshipped. This is the shipped thing:
//!
//! * the frontend is `app-desktop/ui`, written for this window, and it calls
//!   every command below;
//! * paths resolve from the app's RESOURCE directory (`engine::find_engine`),
//!   with the checkout as a fallback rather than as the default;
//! * the Node runtime ships inside the bundle (`scripts/fetch-node.mjs`), so the
//!   app works on a machine that has never had Node installed;
//! * and it does not run a full node. It is a LIGHT miner over the HTTP mining
//!   API — no chain on the laptop, no inbound port, and it works through the
//!   Cloudflare Tunnel the estate is published behind. `hearthd` is still there
//!   for anyone who wants to validate the chain themselves, and the window says
//!   so rather than pretending otherwise.
//!
//! # `--selftest`
//!
//! A GUI is not evidence that anything was mined. `--selftest` drives exactly
//! the code below — the same path resolution, the same spawn, the same
//! protocol — with no window, mines until the node accepts a block, and prints
//! the address that was paid. See `app-desktop/README.md` for the run.

mod engine;
mod keychain;

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use engine::{Engine, Layout};
use serde_json::{json, Value};
use tauri::{Emitter, Manager};

/// A local node, because it is the only endpoint that is certainly right without
/// asking. The window's field takes `https://rpc.<apex>` for the estate's node
/// and explains the trade — a light miner cannot validate the chain it mines on,
/// so the endpoint is a thing you trust rather than a thing you find.
const DEFAULT_URL: &str = "http://127.0.0.1:8645";

struct App {
    layout: Layout,
    engine: Mutex<Option<Engine>>,
}

// ---------------------------------------------------------------------------
// settings — the node URL and the throttle, remembered between runs
// ---------------------------------------------------------------------------

fn settings_path(data_dir: &std::path::Path) -> PathBuf {
    data_dir.join("settings.json")
}

fn read_settings(data_dir: &std::path::Path) -> Value {
    let fallback = json!({ "url": DEFAULT_URL, "throttle": 1.0 });
    let Ok(text) = std::fs::read_to_string(settings_path(data_dir)) else { return fallback };
    serde_json::from_str(&text).unwrap_or(fallback)
}

#[tauri::command]
fn get_settings(app: tauri::State<Arc<App>>) -> Value {
    let mut s = read_settings(&app.layout.data_dir);
    // Never persisted, always observed: whether the passphrase is remembered is
    // a fact about the OS keychain, and a stale copy of it in a file would show
    // the tick box in the wrong state after the entry was revoked elsewhere.
    s["remembered"] = json!(keychain::is_remembered(&app.layout.data_dir));
    s["layout"] = serde_json::to_value(&app.layout).unwrap_or(json!({}));
    s
}

#[tauri::command]
fn set_settings(app: tauri::State<Arc<App>>, url: String, throttle: f64) -> Result<Value, String> {
    let body = json!({ "url": url, "throttle": throttle.clamp(0.01, 1.0) });
    std::fs::write(
        settings_path(&app.layout.data_dir),
        serde_json::to_string_pretty(&body).unwrap_or_default(),
    )
    .map_err(|e| format!("could not save settings: {e}"))?;
    Ok(body)
}

// ---------------------------------------------------------------------------
// the engine
// ---------------------------------------------------------------------------

fn with_engine<F: FnOnce(&Engine) -> Result<Value, String>>(
    app: &App,
    f: F,
) -> Result<Value, String> {
    let guard = app.engine.lock().map_err(|e| e.to_string())?;
    let e = guard.as_ref().ok_or("the mining engine is not running")?;
    f(e)
}

#[tauri::command]
fn status(app: tauri::State<Arc<App>>) -> Result<Value, String> {
    with_engine(&app, |e| e.call("status", json!({})))
}

#[tauri::command]
fn create_keystore(
    app: tauri::State<Arc<App>>,
    passphrase: String,
    private_key: Option<String>,
    remember: bool,
) -> Result<Value, String> {
    let out = with_engine(&app, |e| {
        e.call("keystore.create", json!({ "passphrase": passphrase, "privateKey": private_key }))
    })?;
    remember_or_forget(&app.layout.data_dir, remember, &passphrase);
    Ok(out)
}

#[tauri::command]
fn unlock(
    app: tauri::State<Arc<App>>,
    passphrase: String,
    remember: bool,
) -> Result<Value, String> {
    let out = with_engine(&app, |e| e.call("keystore.unlock", json!({ "passphrase": passphrase })))?;
    remember_or_forget(&app.layout.data_dir, remember, &passphrase);
    Ok(out)
}

/// Unlock from the keychain, if there is anything in it. Called once at startup.
///
/// A remembered passphrase that no longer works is DELETED rather than reported:
/// it means the keystore was replaced or its passphrase changed elsewhere, and
/// leaving the stale entry there turns every future launch into the same failed
/// unlock with no way for the user to clear it from inside the app.
#[tauri::command]
fn auto_unlock(app: tauri::State<Arc<App>>) -> Result<Value, String> {
    let Some(passphrase) = keychain::recall(&app.layout.data_dir) else {
        return Err("nothing is remembered on this device".into());
    };
    match with_engine(&app, |e| e.call("keystore.unlock", json!({ "passphrase": passphrase }))) {
        Ok(v) => Ok(v),
        Err(e) => {
            let _ = keychain::forget(&app.layout.data_dir);
            Err(format!(
                "{e} — the remembered passphrase no longer opens this keystore, so it has been forgotten"
            ))
        }
    }
}

#[tauri::command]
fn lock(app: tauri::State<Arc<App>>) -> Result<Value, String> {
    with_engine(&app, |e| e.call("keystore.lock", json!({})))
}

#[tauri::command]
fn forget_passphrase(app: tauri::State<Arc<App>>) -> Result<(), String> {
    keychain::forget(&app.layout.data_dir)
}

#[tauri::command]
fn change_passphrase(
    app: tauri::State<Arc<App>>,
    passphrase: String,
    new_passphrase: String,
    remember: bool,
) -> Result<Value, String> {
    let out = with_engine(&app, |e| {
        e.call(
            "keystore.changePassphrase",
            json!({ "passphrase": passphrase, "newPassphrase": new_passphrase }),
        )
    })?;
    // The old one is now wrong, so it must not survive whatever the tick box says.
    let _ = keychain::forget(&app.layout.data_dir);
    remember_or_forget(&app.layout.data_dir, remember, &new_passphrase);
    Ok(out)
}

#[tauri::command]
fn import_plaintext(
    app: tauri::State<Arc<App>>,
    file: String,
    passphrase: String,
    remember: bool,
) -> Result<Value, String> {
    let out = with_engine(&app, |e| {
        e.call("keystore.importPlaintext", json!({ "file": file, "passphrase": passphrase }))
    })?;
    remember_or_forget(&app.layout.data_dir, remember, &passphrase);
    Ok(out)
}

#[tauri::command]
fn backup_keystore(app: tauri::State<Arc<App>>, file: String) -> Result<Value, String> {
    with_engine(&app, |e| e.call("keystore.backup", json!({ "file": file })))
}

/// Export the raw private key TO A FILE. The key does not come back through
/// this call — see `engine.js`. What returns is the path it was written to.
#[tauri::command]
fn export_key(
    app: tauri::State<Arc<App>>,
    file: String,
    passphrase: String,
) -> Result<Value, String> {
    with_engine(&app, |e| e.call("key.export", json!({ "file": file, "passphrase": passphrase })))
}

#[tauri::command]
fn start_mining(app: tauri::State<Arc<App>>, url: String, throttle: f64) -> Result<Value, String> {
    with_engine(&app, |e| {
        e.call("mine.start", json!({ "url": url, "throttle": throttle.clamp(0.01, 1.0) }))
    })
}

#[tauri::command]
fn stop_mining(app: tauri::State<Arc<App>>) -> Result<Value, String> {
    with_engine(&app, |e| e.call("mine.stop", json!({})))
}

/// Remembering is best-effort by design (see keychain.rs): a machine with no
/// keychain means "type it every time", not "you cannot mine".
fn remember_or_forget(data_dir: &std::path::Path, remember: bool, passphrase: &str) {
    if remember {
        let _ = keychain::remember(data_dir, passphrase);
    } else {
        let _ = keychain::forget(data_dir);
    }
}

// ---------------------------------------------------------------------------
// --selftest: the proof that does not involve a screenshot
// ---------------------------------------------------------------------------

/// Give `--selftest` somewhere to print, on Windows.
///
/// The release binary is built `windows_subsystem = "windows"` (line 2), which is
/// right for a window — otherwise every launch flashes a console — and wrong for
/// a command whose entire job is to print evidence. Such a process starts with
/// **no console at all**: `println!` writes to an invalid handle, and the run
/// reports neither its PASS nor its FAIL. The proof that the Windows build mines
/// would have been a silent exit code.
///
/// `AttachConsole(ATTACH_PARENT_PROCESS)` borrows the terminal that launched it.
/// It is attempted ONLY when there is no standard output handle already, because
/// a caller who redirected our output to a file has given us a perfectly good
/// one and attaching would take it away.
#[cfg(windows)]
fn attach_parent_console() {
    const ATTACH_PARENT_PROCESS: u32 = 0xFFFF_FFFF;
    const STD_OUTPUT_HANDLE: u32 = -11i32 as u32;
    extern "system" {
        fn AttachConsole(dw_process_id: u32) -> i32;
        fn GetStdHandle(n_std_handle: u32) -> isize;
    }
    // SAFETY: two argument-free-ish kernel32 calls with no pointers involved.
    unsafe {
        if GetStdHandle(STD_OUTPUT_HANDLE) == 0 {
            AttachConsole(ATTACH_PARENT_PROCESS);
        }
    }
}

#[cfg(not(windows))]
fn attach_parent_console() {}

fn selftest(args: &[String]) -> i32 {
    attach_parent_console();

    let arg = |name: &str, default: &str| -> String {
        args.iter()
            .position(|a| a == name)
            .and_then(|i| args.get(i + 1))
            .cloned()
            .unwrap_or_else(|| default.to_string())
    };
    let url = arg("--url", DEFAULT_URL);
    let data_dir = PathBuf::from(arg("--data", "./hearth-selftest-data"));
    let passphrase = std::env::var("HEARTH_SELFTEST_PASSPHRASE")
        .unwrap_or_else(|_| "selftest passphrase".to_string());
    let want: usize = arg("--blocks", "1").parse().unwrap_or(1);

    let exe = std::env::current_exe().unwrap_or_default();
    let exe_dir = exe.parent().unwrap_or(std::path::Path::new(".")).to_path_buf();
    let (node_bin, bundled_runtime) = engine::find_node(&exe_dir);
    let (engine_js, node_src) = engine::find_engine(None, &exe_dir);
    let layout = Layout { node_bin, engine_js, node_src, data_dir, bundled_runtime };

    println!("hearth-desktop --selftest");
    println!(
        "  node runtime  {} ({})",
        layout.node_bin.display(),
        if layout.bundled_runtime { "bundled with the app" } else { "found on this machine" }
    );
    println!("  engine        {}", layout.engine_js.display());
    println!("  sources       {}", layout.node_src.display());
    println!("  data          {}", layout.data_dir.display());
    println!("  work from     {url}");

    let accepted = Arc::new(Mutex::new(Vec::<Value>::new()));
    let hashrate = Arc::new(Mutex::new(0i64));
    let sink: engine::EventSink = {
        let accepted = Arc::clone(&accepted);
        let hashrate = Arc::clone(&hashrate);
        Arc::new(move |name: String, data: Value| match name.as_str() {
            "accepted" => {
                println!(
                    "  mined  block #{} · paid {} wei",
                    data["height"],
                    data["paidWei"].as_str().unwrap_or("?")
                );
                accepted.lock().unwrap().push(data);
            }
            "rate" => *hashrate.lock().unwrap() = data["hashrate"].as_i64().unwrap_or(0),
            "work" => println!("  work   for height {}", data["height"]),
            "unreachable" | "badwork" | "refused" | "error" => {
                println!("  !      {}", data["err"].as_str().unwrap_or("?"));
            }
            _ => {}
        })
    };

    let mut eng = match Engine::spawn(&layout, sink) {
        Ok(e) => e,
        Err(e) => {
            eprintln!("\nFAIL — {e}");
            return 1;
        }
    };

    let existed = eng.call("status", json!({})).map(|s| !s["keystore"].is_null()).unwrap_or(false);
    let cmd = if existed { "keystore.unlock" } else { "keystore.create" };
    let opened = match eng.call(cmd, json!({ "passphrase": passphrase })) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("\nFAIL — {e}");
            eng.shutdown();
            return 1;
        }
    };
    let address = opened["address"].as_str().unwrap_or("?").to_string();
    println!("  paid to       {address}");

    if let Err(e) = eng.call("mine.start", json!({ "url": url, "throttle": 1.0 })) {
        eprintln!("\nFAIL — {e}");
        eng.shutdown();
        return 1;
    }

    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(600);
    while accepted.lock().unwrap().len() < want && std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
    let found = accepted.lock().unwrap().len();
    let rate = *hashrate.lock().unwrap();
    eng.shutdown();

    if found < want {
        eprintln!("\nFAIL — {found} of {want} blocks accepted within ten minutes (hashrate {rate} H/s)");
        return 1;
    }
    println!("\nPASS — {found} block(s) accepted at {rate} H/s, paid to {address}");
    0
}

// ---------------------------------------------------------------------------

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--selftest") {
        std::process::exit(selftest(&args));
    }

    tauri::Builder::default()
        .setup(|app| {
            let exe = std::env::current_exe()?;
            let exe_dir = exe.parent().unwrap_or(std::path::Path::new(".")).to_path_buf();
            let resource_dir = app.path().resource_dir().ok();
            let (node_bin, bundled_runtime) = engine::find_node(&exe_dir);
            let (engine_js, node_src) = engine::find_engine(resource_dir.as_deref(), &exe_dir);

            /* The key belongs with the user's data, not beside the binary: an
             * app directory is not backed up on any platform, and this is the
             * file that holds the money. */
            let data_dir = std::env::var("HEARTH_APP_DATA")
                .map(PathBuf::from)
                .or_else(|_| app.path().app_data_dir())
                .unwrap_or_else(|_| exe_dir.join("hearth-data"));

            let layout = Layout { node_bin, engine_js, node_src, data_dir, bundled_runtime };
            let state = Arc::new(App { layout: layout.clone(), engine: Mutex::new(None) });

            let handle = app.handle().clone();
            let sink: engine::EventSink = Arc::new(move |name, data| {
                // The name and the payload go to the window. Nothing is printed:
                // a `println!` here is how a support ticket ends up holding
                // somebody's mining history, and worse if a payload ever changes.
                let _ = handle.emit(&format!("hearth://{name}"), data);
            });

            match Engine::spawn(&layout, sink) {
                Ok(e) => *state.engine.lock().unwrap() = Some(e),
                Err(err) => {
                    // The window still opens, and shows this. A blank window
                    // with a spinner is the worst possible answer to a
                    // packaging fault.
                    let handle = app.handle().clone();
                    let msg = err.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_millis(400));
                        let _ = handle.emit("hearth://fatal", json!({ "err": msg }));
                    });
                }
            }

            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_settings,
            set_settings,
            status,
            create_keystore,
            unlock,
            auto_unlock,
            lock,
            forget_passphrase,
            change_passphrase,
            import_plaintext,
            backup_keystore,
            export_key,
            start_mining,
            stop_mining,
        ])
        .build(tauri::generate_context!())
        .expect("error while building the Hearth desktop app")
        .run(|app, event| {
            // Closing the window must stop the miner. An orphaned engine is a
            // core spinning on somebody's laptop with nothing watching it.
            if let tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit = event {
                if let Some(state) = app.try_state::<Arc<App>>() {
                    if let Ok(mut guard) = state.engine.lock() {
                        if let Some(mut e) = guard.take() {
                            e.shutdown();
                        }
                    }
                }
            }
        });
}
