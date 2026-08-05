//! Supervising the mining engine.
//!
//! The engine is `app-desktop/engine/engine.js` run on a Node runtime: one
//! process, one mining session, one key, speaking JSON lines on stdin and
//! stdout. Everything below is plumbing for that conversation.
//!
//! # Why the loop is not in this file
//!
//! Rust would be the obvious home for a mining loop, and `rust/hearthd` even has
//! a Homefire core. It is the wrong one twice over. `rust/README.md` says the
//! crate's `pow.rs` omits the coinbase public key from the seed, so it computes
//! a different digest from `node/src/pow.js` for the same header — proofs from
//! it would be refused by every node on the network. And even once that is
//! reconciled, a second implementation of the loop drifts from the first: the
//! browser miner signed a 64-byte proof for months while the node required 65,
//! and every block it found was thrown away after the work was done. One loop,
//! in one place, driven by both front-ends.
//!
//! # What this file will not do
//!
//! It never logs a response body. Requests carry passphrases and one reply
//! carries a file path to an exported key; a `println!` for debugging is exactly
//! how those end up in a terminal, a crash report or a support ticket. Only
//! event NAMES and error strings are ever printed, and `app-desktop/test/`
//! scans the engine's own stream for the rest.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};

/// Long enough for scrypt at N=2^18 on a slow machine, short enough that a
/// wedged engine surfaces as an error rather than as a window that never
/// answers. Unlocking is the slow one on purpose — see node/src/mine/keystore.js.
const CALL_TIMEOUT: Duration = Duration::from_secs(60);

/// The name the bundled Node runtime is installed under. **Not `node`.**
///
/// Tauri's Linux bundlers copy every `externalBin` into `/usr/bin` beside the
/// main executable — `tauri-bundler/src/bundle/linux/debian.rs:118,130` and
/// `rpm.rs:150`, both via `settings.rs:1160-1176`, which strips the target
/// triple and keeps the stem. A sidecar called `node` therefore becomes
/// `/usr/bin/node`: the exact path Debian's own `nodejs` package owns. `dpkg`
/// refuses to unpack a file another package owns, so that `.deb` will not
/// install on any machine with Node from apt; where it does install, it
/// silently replaces the system runtime with ours.
///
/// The second half of the same bug is here rather than in the bundler:
/// `find_node` looks for the sidecar *beside the executable*, and on an
/// installed Linux package that directory is `/usr/bin`. Called `node`, it
/// would find whatever Node the machine already had and report it to the window
/// as "bundled with the app" — the one fact that decides whether this
/// application works on a machine that has never had Node installed.
///
/// None of this is visible on macOS, where the sidecar lands inside
/// `Hearth.app/Contents/MacOS/` and can be called anything. It is why the
/// platform that was never compiled is the one that was wrong.
const RUNTIME_STEM: &str = "hearth-node";

/// `productName` in tauri.conf.json. The Linux bundlers put resources in
/// `/usr/lib/<productName>` (`debian.rs:330`, `rpm.rs:183`) and Tauri's own
/// resolver reads them back from `exe_dir/../lib/<productName>`
/// (`tauri-utils/src/platform.rs:310-312`), so this string is load-bearing in
/// two crates and a test below keeps it equal to the config.
const PRODUCT: &str = "Hearth";

pub type EventSink = Arc<dyn Fn(String, Value) + Send + Sync>;

pub struct Engine {
    child: Child,
    stdin: Mutex<ChildStdin>,
    pending: Arc<Mutex<HashMap<u64, Sender<Value>>>>,
    next_id: AtomicU64,
}

/// Where the three moving parts live. Resolved once, at startup, and reported to
/// the window — "it did not start" is a useless message when the reason is a
/// missing file whose path nobody can see.
#[derive(Clone, Debug, serde::Serialize)]
pub struct Layout {
    pub node_bin: PathBuf,
    pub engine_js: PathBuf,
    pub node_src: PathBuf,
    pub data_dir: PathBuf,
    /// True when the Node runtime shipped inside the bundle rather than being
    /// found on the user's PATH. The difference decides whether this app works
    /// on a machine that has never had Node installed.
    pub bundled_runtime: bool,
}

impl Engine {
    pub fn spawn(layout: &Layout, on_event: EventSink) -> Result<Engine, String> {
        if !layout.engine_js.exists() {
            return Err(format!(
                "the mining engine is missing: {}\nThis is a packaging fault — the app cannot mine without it.",
                layout.engine_js.display()
            ));
        }
        if !layout.node_src.join("mine").join("session.js").exists() {
            return Err(format!(
                "the Hearth sources are missing: {}\nThis is a packaging fault — the app cannot mine without them.",
                layout.node_src.display()
            ));
        }
        std::fs::create_dir_all(&layout.data_dir)
            .map_err(|e| format!("could not create {}: {e}", layout.data_dir.display()))?;

        let mut child = Command::new(&layout.node_bin)
            .arg(&layout.engine_js)
            .env("HEARTH_NODE_SRC", &layout.node_src)
            .env("HEARTH_APP_DATA", &layout.data_dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| {
                format!(
                    "could not start the mining engine with {} ({e}).\n\
                     Set HEARTH_NODE_BIN to a Node.js 18+ binary, or reinstall the app — \
                     a complete install ships its own.",
                    layout.node_bin.display()
                )
            })?;

        let stdin = child.stdin.take().ok_or("the engine has no stdin")?;
        let stdout = child.stdout.take().ok_or("the engine has no stdout")?;
        let stderr = child.stderr.take().ok_or("the engine has no stderr")?;

        let pending: Arc<Mutex<HashMap<u64, Sender<Value>>>> = Arc::new(Mutex::new(HashMap::new()));

        // The reader. One line, one message: an `event` goes to the window, and
        // anything with an `id` is somebody's answer.
        {
            let pending = Arc::clone(&pending);
            let sink = Arc::clone(&on_event);
            std::thread::spawn(move || {
                for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                    let Ok(msg) = serde_json::from_str::<Value>(&line) else { continue };
                    if let Some(name) = msg.get("event").and_then(Value::as_str) {
                        sink(name.to_string(), msg.get("data").cloned().unwrap_or(json!({})));
                        continue;
                    }
                    if let Some(id) = msg.get("id").and_then(Value::as_u64) {
                        if let Some(tx) = pending.lock().unwrap().remove(&id) {
                            let _ = tx.send(msg);
                        }
                    }
                }
                // The pipe closed. Wake every caller rather than leaving the
                // window spinning on a process that is already gone.
                for (_, tx) in pending.lock().unwrap().drain() {
                    let _ = tx.send(json!({ "ok": false, "err": "the mining engine stopped" }));
                }
                sink("engine-exit".into(), json!({}));
            });
        }

        // The engine writes nothing to stderr by design, so anything here is a
        // Node-level fault worth surfacing — as a message, not as a body.
        {
            let sink = Arc::clone(&on_event);
            std::thread::spawn(move || {
                for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                    sink("error".into(), json!({ "err": line }));
                }
            });
        }

        Ok(Engine { child, stdin: Mutex::new(stdin), pending, next_id: AtomicU64::new(0) })
    }

    /// Send a command and wait for its answer. Blocking on purpose: Tauri runs
    /// commands on a worker thread, and a request/response protocol with an
    /// explicit timeout is easier to reason about than a second async runtime.
    pub fn call(&self, cmd: &str, args: Value) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst) + 1;
        let (tx, rx) = channel();
        self.pending.lock().unwrap().insert(id, tx);

        let line = serde_json::to_string(&json!({ "id": id, "cmd": cmd, "args": args }))
            .map_err(|e| e.to_string())?;
        {
            let mut stdin = self.stdin.lock().unwrap();
            stdin
                .write_all(line.as_bytes())
                .and_then(|_| stdin.write_all(b"\n"))
                .and_then(|_| stdin.flush())
                .map_err(|e| format!("could not reach the mining engine: {e}"))?;
        }

        let msg = rx.recv_timeout(CALL_TIMEOUT).map_err(|_| {
            self.pending.lock().unwrap().remove(&id);
            format!("the mining engine did not answer `{cmd}` within {}s", CALL_TIMEOUT.as_secs())
        })?;

        if msg.get("ok").and_then(Value::as_bool) == Some(true) {
            Ok(msg.get("result").cloned().unwrap_or(json!({})))
        } else {
            Err(msg
                .get("err")
                .and_then(Value::as_str)
                .unwrap_or("the mining engine refused, without saying why")
                .to_string())
        }
    }

    /// Close the pipe and wait briefly. The engine stops mining when its stdin
    /// closes (see engine.js), so this is the polite path; the kill is for the
    /// case where it does not take the hint, because an orphaned miner is a core
    /// spinning on somebody's laptop with nothing watching it.
    pub fn shutdown(&mut self) {
        let _ = self.call("mine.stop", json!({}));
        if let Ok(mut stdin) = self.stdin.lock() {
            let _ = stdin.flush();
        }
        drop(self.child.stdin.take());
        for _ in 0..40 {
            if matches!(self.child.try_wait(), Ok(Some(_))) {
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Drop for Engine {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Find the Node runtime.
///
/// In order: an explicit override, then the copy bundled beside this executable,
/// then whatever is on PATH. The middle one is what makes the app work on a
/// machine that has never had Node installed — which is every machine an
/// ordinary user is going to run this on — and `scripts/fetch-node.mjs` is what
/// puts it there at build time.
pub fn find_node(exe_dir: &Path) -> (PathBuf, bool) {
    find_node_with(exe_dir, std::env::var("HEARTH_NODE_BIN").ok())
}

/// The same, with the environment passed in rather than read, so the tests can
/// exercise all three branches without mutating a process-global.
pub fn find_node_with(exe_dir: &Path, override_bin: Option<String>) -> (PathBuf, bool) {
    if let Some(explicit) = override_bin {
        if !explicit.is_empty() {
            return (PathBuf::from(explicit), false);
        }
    }
    let exe = if cfg!(windows) { ".exe" } else { "" };
    let bundled = exe_dir.join(format!("{RUNTIME_STEM}{exe}"));
    if bundled.is_file() {
        return (bundled, true);
    }
    /* The PATH fallback is still plain `node`, because that is what a developer
     * has installed. Only the copy we ship carries our name — see RUNTIME_STEM
     * for why the two must not be spelled the same. */
    (PathBuf::from(format!("node{exe}")), false)
}

/// Where a packaged install keeps its resources, relative to the executable.
///
/// Written as a function OF THE OPERATING SYSTEM rather than around `cfg!`, so
/// that `cargo test` on any machine exercises all three layouts. The Linux one
/// was wrong for as long as it existed and nothing here could see it: on a Mac
/// a `cfg!(target_os = "linux")` branch is not compiled, so it is not tested,
/// so it is not wrong until somebody installs a `.deb`.
fn bundle_roots(exe_dir: &Path, os: &str) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    match os {
        /* `Hearth.app/Contents/MacOS/hearth-desktop`, resources one directory up
         * in `Contents/Resources` (tauri-bundler macos/app.rs:75-76). */
        "macos" => roots.push(exe_dir.join("..").join("Resources")),
        /* `/usr/bin/hearth-desktop`, resources in `/usr/lib/Hearth` — NOT beside
         * the executable, which is what the comment this replaces claimed. The
         * path is Tauri's own (`platform.rs:310-312`), so an installed package
         * resolves identically whether the resource directory came from the
         * framework or from here. `--selftest` needs the second one: it runs
         * before there is an `App` to ask and passes `None`, so without this it
         * looked for `/usr/bin/engine/engine.js`, missed, and fell back to a
         * checkout path that on an installed system is `/engine/engine.js`. */
        "linux" => roots.push(exe_dir.join("..").join("lib").join(PRODUCT)),
        /* Windows: NSIS and WiX put the executable, the sidecar and the
         * resources together in the install directory, which the next root
         * covers. */
        _ => {}
    }
    roots.push(exe_dir.to_path_buf());
    roots
}

/// Find `engine.js` and the `node/src` tree it needs.
///
/// Resource directory first, because that is where a real install puts them.
/// The checkout layout is the fallback rather than the default — the previous
/// scaffolding had it the other way round and resolved relative to the CURRENT
/// WORKING DIRECTORY, which for an app launched from Finder or a Start menu is
/// `/` or the user's home. It could only ever have worked from a dev tree.
pub fn find_engine(resource_dir: Option<&Path>, exe_dir: &Path) -> (PathBuf, PathBuf) {
    find_engine_with(
        resource_dir,
        exe_dir,
        std::env::var("HEARTH_ENGINE_JS").ok(),
        std::env::var("HEARTH_NODE_SRC").ok(),
    )
}

pub fn find_engine_with(
    resource_dir: Option<&Path>,
    exe_dir: &Path,
    override_js: Option<String>,
    override_src: Option<String>,
) -> (PathBuf, PathBuf) {
    find_engine_on(std::env::consts::OS, resource_dir, exe_dir, override_js, override_src)
}

/// The same again with the operating system passed in, so every platform's
/// layout is reachable from a test on any machine. See `bundle_roots`.
pub fn find_engine_on(
    os: &str,
    resource_dir: Option<&Path>,
    exe_dir: &Path,
    override_js: Option<String>,
    override_src: Option<String>,
) -> (PathBuf, PathBuf) {
    if let Some(js) = override_js.filter(|s| !s.is_empty()) {
        let js = PathBuf::from(js);
        let src = override_src.map(PathBuf::from).unwrap_or_else(|| {
            js.parent().unwrap_or(Path::new(".")).join("..").join("..").join("node").join("src")
        });
        return (js, src);
    }
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Some(r) = resource_dir {
        roots.push(r.to_path_buf());
    }
    /* The platform's own convention, for the paths that do not go through
     * Tauri's resolver — `--selftest` runs before there is an `App` to ask. */
    roots.extend(bundle_roots(exe_dir, os));
    for root in &roots {
        let js = root.join("engine").join("engine.js");
        if js.is_file() {
            /* `hearth/src`, NOT `node/src`. The Node runtime sidecar is placed
             * beside the executable under the name `node`, so a resource
             * directory of the same name collides with it — as a file where a
             * directory is wanted, which surfaces as a bare `Not a directory`
             * at build time and would have been a mystery at run time. */
            return (js, root.join("hearth").join("src"));
        }
    }
    // A development checkout: app-desktop/src-tauri/target/{debug,release}/.
    let checkout = exe_dir.join("..").join("..").join("..");
    (
        checkout.join("engine").join("engine.js"),
        checkout.join("..").join("node").join("src"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A throwaway tree that looks like a real install: an executable, the Node
    /// sidecar beside it, and the resources.
    fn fixture(tag: &str, with_engine: bool, with_node: bool) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("hearth-layout-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("engine")).unwrap();
        if with_engine {
            std::fs::write(dir.join("engine").join("engine.js"), "// engine").unwrap();
        }
        if with_node {
            let exe = if cfg!(windows) { ".exe" } else { "" };
            std::fs::write(dir.join(format!("{RUNTIME_STEM}{exe}")), "#!/bin/sh\n").unwrap();
        }
        dir
    }

    /// THE DEFECT THIS REPLACES. The scaffolding defaulted to
    /// `../../node/bin/hearthd.js` — relative to the CURRENT WORKING DIRECTORY,
    /// which for an app launched from Finder or a Start menu is `/` or the
    /// user's home. It resolved only when run by `tauri dev` from a checkout,
    /// which is exactly why it never looked wrong.
    #[test]
    fn resolves_from_the_bundle_and_never_from_the_working_directory() {
        /* BOTH trees hold an engine.js. If only one did, the order the two are
         * tried in would be unobservable and this test could not fail — which
         * it could not, until this line. An installed app that picked up a
         * stale engine from beside the binary would be a version skew nobody
         * could see. */
        let res = fixture("res", true, false);
        let exe = fixture("exe", true, false);
        let (js, src) = find_engine_with(Some(&res), &exe, None, None);

        assert_eq!(js, res.join("engine").join("engine.js"), "the resource directory wins");
        assert_ne!(js, exe.join("engine").join("engine.js"), "not the copy beside the executable");
        assert!(js.is_absolute(), "and the path is absolute, so the working directory cannot change it");
        assert!(src.is_absolute());
        assert!(src.starts_with(&res), "the sources come from the same place as the engine");
    }

    /// `--selftest` has no Tauri `App` to ask for the resource directory, so it
    /// passes `None` — and inside a `.app` the resources are NOT beside the
    /// binary. Without this the selftest would pass from a checkout, where
    /// everything is flat, and fail from the bundle it is meant to be proving.
    #[cfg(target_os = "macos")]
    #[test]
    fn finds_the_resources_of_a_macos_app_bundle_with_no_resource_dir_given() {
        let app = std::env::temp_dir().join(format!("hearth-appbundle-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&app);
        let macos = app.join("Contents").join("MacOS");
        let resources = app.join("Contents").join("Resources");
        std::fs::create_dir_all(&macos).unwrap();
        std::fs::create_dir_all(resources.join("engine")).unwrap();
        std::fs::create_dir_all(resources.join("hearth").join("src").join("mine")).unwrap();
        std::fs::write(resources.join("engine").join("engine.js"), "// engine").unwrap();
        std::fs::write(resources.join("hearth").join("src").join("mine").join("session.js"), "// loop").unwrap();

        let (js, src) = find_engine_with(None, &macos, None, None);
        assert!(js.is_file(), "the engine inside Contents/Resources is found: {js:?}");
        assert!(
            src.canonicalize().expect("the sources resolve").starts_with(resources.canonicalize().unwrap()),
            "and so are the sources: {src:?}"
        );
        assert!(src.join("mine").join("session.js").is_file(), "including the mining loop itself");
    }

    #[test]
    fn falls_back_to_the_executables_own_directory() {
        let exe = fixture("exe2", true, false);
        let empty = fixture("empty", false, false);
        let (js, _) = find_engine_with(Some(&empty), &exe, None, None);
        assert_eq!(js, exe.join("engine").join("engine.js"));
    }

    /// The sidecar and the resource tree must not both be called `node`, or the
    /// bundler writes a file where a directory has to go.
    #[test]
    fn the_sources_do_not_collide_with_the_node_sidecar() {
        let res = fixture("collide", true, true);
        let (_, src) = find_engine_with(Some(&res), &res, None, None);
        let (bin, bundled) = find_node_with(&res, None);
        assert!(bundled, "the bundled runtime is found");
        assert!(!src.starts_with(&bin), "and the sources are not inside it: {src:?} vs {bin:?}");
        assert_ne!(src.parent().unwrap(), bin.as_path());
    }

    #[test]
    fn prefers_the_bundled_runtime_over_whatever_is_on_path() {
        let with = fixture("node-yes", false, true);
        let without = fixture("node-no", false, false);

        let (bin, bundled) = find_node_with(&with, None);
        assert!(bundled, "a runtime beside the executable is used");
        assert!(bin.is_absolute(), "by absolute path, not by name");

        let (bin, bundled) = find_node_with(&without, None);
        assert!(!bundled, "with none bundled it falls back to PATH");
        assert_eq!(bin.components().count(), 1, "which means a bare name: {bin:?}");
    }

    #[test]
    fn an_explicit_override_beats_both() {
        let with = fixture("node-override", false, true);
        let (bin, bundled) = find_node_with(&with, Some("/opt/node/bin/node".into()));
        assert_eq!(bin, PathBuf::from("/opt/node/bin/node"));
        assert!(!bundled, "an override is not the bundled runtime, and must not claim to be");

        // An empty variable means "unset", not "run the empty string".
        let (bin, bundled) = find_node_with(&with, Some(String::new()));
        let want = format!("{RUNTIME_STEM}{}", if cfg!(windows) { ".exe" } else { "" });
        assert!(bundled && bin.ends_with(&want), "{bin:?} should end with {want}");
    }

    // -----------------------------------------------------------------------
    // The two platforms that had never been compiled, let alone installed.
    // Both of these went red on the code they replace.
    // -----------------------------------------------------------------------

    /// A `.deb`/`.rpm` install: `/usr/bin/hearth-desktop`, resources in
    /// `/usr/lib/Hearth`. NOT beside the executable, which is what this
    /// resolver assumed for as long as no Linux machine had run it.
    #[test]
    fn resolves_an_installed_linux_package() {
        let root = std::env::temp_dir().join(format!("hearth-deb-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let bin = root.join("usr").join("bin");
        let lib = root.join("usr").join("lib").join(PRODUCT);
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::create_dir_all(lib.join("engine")).unwrap();
        std::fs::create_dir_all(lib.join("hearth").join("src").join("mine")).unwrap();
        std::fs::write(lib.join("engine").join("engine.js"), "// engine").unwrap();
        std::fs::write(lib.join("hearth").join("src").join("mine").join("session.js"), "// loop")
            .unwrap();
        std::fs::write(bin.join("hearth-desktop"), "elf").unwrap();

        // `None` is what --selftest passes: there is no App to ask yet.
        let (js, src) = find_engine_on("linux", None, &bin, None, None);
        assert!(js.is_file(), "the engine under /usr/lib/{PRODUCT} is found: {js:?}");
        assert!(
            src.join("mine").join("session.js").is_file(),
            "and the mining loop with it: {src:?}"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// `/usr/bin` is where the Linux bundlers put `externalBin`, and it is also
    /// where the machine's own Node lives. If the sidecar were called `node`
    /// this app would adopt a stranger's runtime and tell the window it had
    /// shipped one — while its `.deb` refused to install over Debian's
    /// `nodejs`. See RUNTIME_STEM.
    #[test]
    fn a_system_node_beside_the_executable_is_not_ours() {
        let dir = std::env::temp_dir().join(format!("hearth-usrbin-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let exe = if cfg!(windows) { ".exe" } else { "" };
        std::fs::write(dir.join(format!("node{exe}")), "the machine's own").unwrap();

        let (bin, bundled) = find_node_with(&dir, None);
        assert!(!bundled, "a plain `node` next door is the SYSTEM runtime, not the bundle's");
        assert_eq!(bin.components().count(), 1, "so it falls back to PATH: {bin:?}");
        assert_ne!(RUNTIME_STEM, "node", "which only holds while the names differ");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The resolver and the bundler have to agree on two names, and nothing
    /// else checks that they do: get either wrong and the app builds, installs,
    /// opens, and cannot find its own runtime or its own engine.
    #[test]
    fn the_config_and_the_resolver_agree_on_both_names() {
        let conf: Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(
            conf["bundle"]["externalBin"][0].as_str(),
            Some(format!("binaries/{RUNTIME_STEM}").as_str()),
            "tauri.conf.json's externalBin must name the runtime find_node looks for"
        );
        assert_eq!(
            conf["productName"].as_str(),
            Some(PRODUCT),
            "and productName is the /usr/lib directory the Linux root above is built from"
        );
    }
}
