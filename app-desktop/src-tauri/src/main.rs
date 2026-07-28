// Prevent an extra console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Hearth desktop app (Tauri v2) — UNSHIPPED SCAFFOLDING.
//!
//! A native shell around the Hearth web wallet + explorer (bundled from `web/`).
//! The intent is one click: *node + wallet + miner* in a single window.
//!
//! # None of the commands below are reachable
//!
//! `start_node`, `stop_node` and `node_running` are registered and have **zero
//! callers**. `frontendDist` is `../../web`: plain static pages that know
//! nothing about Tauri and never call `invoke`. Opening this app gives you the
//! web wallet in a native window and no way to start a node from it.
//!
//! `node_entry()` also cannot resolve in a bundle — see its own note. Do not
//! read this file as a working feature; see `app-desktop/README.md` for exactly
//! what would have to be built.

use std::process::{Child, Command};
use std::sync::Mutex;
use tauri::State;

#[derive(Default)]
struct NodeProc(Mutex<Option<Child>>);

/// Path to the reference node entrypoint. Override with HEARTH_NODE_JS.
///
/// BROKEN IN A BUNDLE: this default is relative to the process's *current
/// working directory*, which for an app launched from Finder or a Start menu is
/// `/` or the user's home — never a checkout. It resolves only when the binary
/// is run by `tauri dev` from `app-desktop/`, which is why it has never looked
/// wrong. A real fix resolves from the app's resource directory
/// (`tauri::path::BaseDirectory::Resource`) and bundles `node/` alongside it,
/// which also means shipping or locating a Node.js runtime. Left as-is
/// deliberately: a half-fix here would hide the fact that nothing calls it.
fn node_entry() -> String {
    std::env::var("HEARTH_NODE_JS").unwrap_or_else(|_| "../../node/bin/hearthd.js".to_string())
}

#[tauri::command]
fn start_node(state: State<NodeProc>, mine: bool) -> Result<String, String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    if guard.is_some() {
        return Ok("already running".into());
    }
    let mut cmd = Command::new("node");
    cmd.arg(node_entry());
    if mine {
        cmd.arg("--mine");
    }
    let child = cmd.spawn().map_err(|e| {
        format!("could not start node ({e}). Is Node.js installed and on PATH?")
    })?;
    *guard = Some(child);
    Ok("started".into())
}

#[tauri::command]
fn stop_node(state: State<NodeProc>) -> Result<String, String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(mut child) = guard.take() {
        let _ = child.kill();
    }
    Ok("stopped".into())
}

#[tauri::command]
fn node_running(state: State<NodeProc>) -> bool {
    let mut guard = match state.0.lock() {
        Ok(g) => g,
        Err(_) => return false,
    };
    if let Some(child) = guard.as_mut() {
        match child.try_wait() {
            Ok(Some(_)) => {
                *guard = None;
                false
            }
            Ok(None) => true,
            Err(_) => false,
        }
    } else {
        false
    }
}

fn main() {
    tauri::Builder::default()
        .manage(NodeProc::default())
        .invoke_handler(tauri::generate_handler![start_node, stop_node, node_running])
        .run(tauri::generate_context!())
        .expect("error while running the Hearth desktop app");
}
