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
//!
//! # `--smoke`
//!
//! And `--selftest` is not evidence that anything DRAWS. It deliberately opens
//! no window, so a green build said the runtime, the paths, the engine and the
//! mining loop were right and said nothing at all about the interface — nobody
//! had ever seen this application's window on Windows or on Linux. `--smoke`
//! opens the REAL window on the REAL page and makes the page measure itself.
//! See the section above `run_smoke` for what it does and does not prove.

mod engine;
mod keychain;

use std::path::PathBuf;
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

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
    /* The first thing ui/app.js does on boot (its closing IIFE) is await this
     * command. That makes this line the one place that can say "the page's OWN
     * script ran and completed a round trip over IPC", as distinct from "a
     * script the host injected ran" — which is all an `eval` can prove. It is a
     * no-op unless --smoke created the channel. */
    smoke_send(Smoke::Ipc);
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
// --smoke: the proof that the WINDOW comes up
// ---------------------------------------------------------------------------

/* WHAT THIS EXISTS FOR.
 *
 * `--selftest` and scripts/verify-bundle.mjs between them prove a great deal —
 * the runtime executes on this platform, the installer puts the engine where the
 * resolver looks, the mining loop runs and the chain credits the address. All of
 * it happens with no window, and verify-bundle.mjs says so in its own header:
 * "NOT CHECKED HERE: that the window renders."
 *
 * That gap is not academic. The webview is the one component that is a DIFFERENT
 * PIECE OF SOFTWARE on each platform — WKWebView, WebView2, WebKitGTK — and the
 * only one the build cannot vouch for, because linking against webkit2gtk proves
 * the symbols resolve, not that a surface is ever created. Every failure mode
 * left after a green build lives here: a webview that will not instantiate, a
 * CSP that blocks the app's own script, a `window.__TAURI__` that is missing
 * because `withGlobalTauri` regressed, a page that loads and paints nothing.
 *
 * WHAT IT PROVES, in the order it establishes it:
 *
 *   1. the native window and its webview were created at all;
 *   2. the webview navigated to the bundled index.html and finished loading it;
 *   3. `ui/app.js` — the application's own script, subject to the real CSP —
 *      executed and completed an IPC round trip (`get_settings`);
 *   4. the page has non-zero geometry and a VISIBLE section. This is the load
 *      bearing one: every <section> in index.html ships `hidden`, and only
 *      app.js's render() ever unhides one. A section with real width and height
 *      cannot happen unless the script ran AND the webview laid the document
 *      out. It is as close to "the interface drew" as anything short of a
 *      screenshot gets.
 *
 * WHAT IT STILL DOES NOT PROVE. Nothing here looks at pixels. Layout ran, but
 * whether the result is legible — fonts, contrast, a control off the edge of the
 * window — is not established, and a person still has to look at it once per
 * platform. It is the difference between "the interface draws" and "the
 * interface is right", and only the first is claimed.
 *
 * ON HEADLESS RUNNERS. Linux needs an X server for a window to exist at all;
 * CI runs this under `xvfb-run`. macOS and Windows runners have a window server
 * in the session already. Xvfb is a real X server with a real framebuffer, so
 * layout is genuine — it is not a stub.
 */

/// The stages of a smoke run, as they are observed.
#[derive(Debug)]
enum Smoke {
    /// The webview finished loading a document.
    PageLoad(String),
    /// `ui/app.js` called into the backend.
    Ipc,
    /// The page measured itself and sent the numbers back.
    Dom(Value),
}

/// `None` unless `--smoke` is on, which is what makes every `smoke_send` in the
/// normal command path free.
static SMOKE_TX: OnceLock<Mutex<Sender<Smoke>>> = OnceLock::new();

fn smoke_send(ev: Smoke) {
    if let Some(tx) = SMOKE_TX.get() {
        // A closed channel means the watcher already reported; dropping is right.
        let _ = tx.lock().map(|t| t.send(ev));
    }
}

/// Ask the page how big it is and which section is showing.
///
/// Injected with `eval` rather than shipped in `ui/`, so that not one line of
/// test scaffolding is inside the application a user installs. `connect-src
/// ipc: http://ipc.localhost` in the CSP is what lets the result come back.
/* It POLLS rather than measuring once. app.js's boot is asynchronous — it awaits
 * get_settings, then awaits refresh(), and only render() unhides a section. The
 * first version of this measured the instant get_settings returned and reported
 * "every section is still hidden" about a window that drew correctly a few
 * hundred milliseconds later. Waiting for the state to arrive, rather than
 * sampling once and hoping, is the difference between a smoke test and a flake. */
const SMOKE_JS: &str = r#"
(function () {
  function report(m) {
    try { window.__TAURI__.core.invoke('smoke_report', { metrics: m }); } catch (e) {}
  }
  var started = Date.now();
  function visible(s) {
    var r = s.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }
  function measure() {
    try {
      var all = [].slice.call(document.querySelectorAll('section'));
      var shown = all.filter(visible);
      // Give the async boot time to land before calling it a blank window.
      if (!shown.length && Date.now() - started < 30000) { setTimeout(measure, 200); return; }
      var box = document.body.getBoundingClientRect();
      var sec = shown[0] || null;
      var h1 = sec ? sec.querySelector('h1') : null;
      report({
        title: document.title,
        nodes: document.querySelectorAll('*').length,
        sections: all.length,
        visible: sec ? sec.id : null,
        heading: h1 ? h1.textContent.trim() : null,
        waitedMs: Date.now() - started,
        bodyWidth: Math.round(box.width),
        bodyHeight: Math.round(box.height),
        hasTauri: !!(window.__TAURI__ && window.__TAURI__.core),
        engine: navigator.userAgent
      });
    } catch (e) {
      report({ error: String(e) });
    }
  }
  measure();
})()
"#;

/// Receives the page's self-measurement. Inert unless `--smoke` set the channel.
#[tauri::command]
fn smoke_report(metrics: Value) {
    smoke_send(Smoke::Dom(metrics));
}

/// Watch the stages go by, then report and exit the process.
///
/// This never returns: a smoke run's whole purpose is its exit code, and there
/// is nothing sensible to do with the window afterwards.
fn run_smoke(handle: tauri::AppHandle, rx: Receiver<Smoke>, budget: Duration) -> ! {
    let deadline = Instant::now() + budget;
    let mut page: Option<String> = None;
    let mut ipc = false;
    let mut dom: Option<Value> = None;
    let mut asked = false;

    while dom.is_none() {
        /* Only measure once the page has loaded AND app.js has spoken. Evaluating
         * earlier races the render: every section is still `hidden`, so it would
         * report "nothing visible" about a window that was about to be fine. */
        if page.is_some() && ipc && !asked {
            asked = true;
            match handle.get_webview_window("main") {
                Some(w) => {
                    if let Err(e) = w.eval(SMOKE_JS) {
                        smoke_end(&handle, Err(format!("the page would not evaluate: {e}")));
                    }
                }
                None => smoke_end(&handle, Err("there is no window labelled `main`".into())),
            }
        }

        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            let missing = if page.is_none() {
                "the webview never finished loading a page — no window, or index.html was not \
                 bundled where the webview looks"
            } else if !ipc {
                "the page loaded, but ui/app.js never called get_settings — its script did not \
                 run (check the CSP) or window.__TAURI__ was absent"
            } else {
                "the page never answered the measurement — eval reached it but the reply did not \
                 come back over IPC"
            };
            smoke_end(&handle, Err(format!("timed out after {}s: {missing}", budget.as_secs())));
        }

        match rx.recv_timeout(left.min(Duration::from_millis(250))) {
            Ok(Smoke::PageLoad(url)) => {
                println!("  window        the webview loaded {url}");
                page = Some(url);
            }
            Ok(Smoke::Ipc) => {
                if !ipc {
                    println!("  script        ui/app.js ran and called get_settings over IPC");
                }
                ipc = true;
            }
            Ok(Smoke::Dom(v)) => dom = Some(v),
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => {
                smoke_end(&handle, Err("the smoke channel closed early".into()));
            }
        }
    }

    let m = dom.unwrap_or_else(|| json!({}));
    if let Some(err) = m["error"].as_str() {
        smoke_end(&handle, Err(format!("the page reported: {err}")));
    }

    let w = m["bodyWidth"].as_i64().unwrap_or(0);
    let h = m["bodyHeight"].as_i64().unwrap_or(0);
    let nodes = m["nodes"].as_i64().unwrap_or(0);
    let visible = m["visible"].as_str().unwrap_or("");

    println!("  engine        {}", m["engine"].as_str().unwrap_or("?"));
    println!("  document      {:?}, {nodes} elements in {} sections",
        m["title"].as_str().unwrap_or("?"), m["sections"].as_i64().unwrap_or(0));
    println!("  laid out      body is {w}×{h} css px, {}ms after the page was asked",
        m["waitedMs"].as_i64().unwrap_or(0));
    println!("  showing       <section id=\"{visible}\"> — {:?}", m["heading"].as_str().unwrap_or(""));

    /* Every section in index.html is `hidden` in the markup. One being visible
     * with real dimensions is the whole proof: the script ran and the engine
     * laid the document out. */
    if !m["hasTauri"].as_bool().unwrap_or(false) {
        smoke_end(&handle, Err("window.__TAURI__.core is missing in the page".into()));
    }
    if w <= 0 || h <= 0 {
        smoke_end(&handle, Err(format!("the document has no area ({w}×{h})")));
    }
    if visible.is_empty() {
        smoke_end(&handle, Err(
            "every <section> is still hidden — the page loaded but nothing was rendered into it".into()));
    }
    if nodes < 20 {
        smoke_end(&handle, Err(format!("only {nodes} elements — that is not this page")));
    }

    smoke_end(&handle, Ok(format!(
        "the window opened, ui/app.js ran, and <section id=\"{visible}\"> is drawn at {w}×{h}")))
}

/// Print the verdict, stop the engine, and leave with the right exit code.
fn smoke_end(handle: &tauri::AppHandle, verdict: Result<String, String>) -> ! {
    // An orphaned Node process outliving a CI step wedges the runner's cleanup.
    if let Some(state) = handle.try_state::<Arc<App>>() {
        if let Ok(mut g) = state.engine.lock() {
            if let Some(mut e) = g.take() {
                e.shutdown();
            }
        }
    }
    match verdict {
        Ok(msg) => {
            println!("\nPASS — {msg}");
            println!("NOT CHECKED HERE: that what was drawn is legible. No pixels were read.\n");
            std::process::exit(0)
        }
        Err(msg) => {
            eprintln!("\nFAIL — {msg}\n");
            std::process::exit(1)
        }
    }
}

// ---------------------------------------------------------------------------

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--selftest") {
        std::process::exit(selftest(&args));
    }

    /* --smoke runs the ordinary application: the same builder, the same window,
     * the same page, the same CSP. Nothing below is branched on it except that a
     * watcher is started and the data directory can be pointed somewhere
     * disposable — a smoke run must not touch a real user's keystore, and a
     * fresh directory is also what makes the setup screen the one that renders. */
    let smoking = args.iter().any(|a| a == "--smoke");
    let mut smoke_rx: Option<Receiver<Smoke>> = None;
    let mut smoke_budget = Duration::from_secs(120);
    if smoking {
        attach_parent_console();
        let arg = |name: &str| -> Option<String> {
            args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned()
        };
        if let Some(d) = arg("--data") {
            std::env::set_var("HEARTH_APP_DATA", d);
        }
        if let Some(secs) = arg("--timeout").and_then(|s| s.parse::<u64>().ok()) {
            smoke_budget = Duration::from_secs(secs);
        }
        let (tx, rx) = channel();
        let _ = SMOKE_TX.set(Mutex::new(tx));
        smoke_rx = Some(rx);
        println!("hearth-desktop --smoke");
    }

    tauri::Builder::default()
        /* Fires when the webview has finished loading a document — the first
         * thing in a smoke run that cannot be faked by the process merely
         * starting. `smoke_send` is a no-op in a normal launch. */
        .on_page_load(|webview, payload| {
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                smoke_send(Smoke::PageLoad(payload.url().to_string()));
            }
            let _ = webview;
        })
        .setup(move |app| {
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

            if let Some(rx) = smoke_rx.take() {
                let handle = app.handle().clone();
                std::thread::spawn(move || run_smoke(handle, rx, smoke_budget));
            }
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
            smoke_report,
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
