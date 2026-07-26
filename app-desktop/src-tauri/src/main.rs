// Prevent an extra console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Hearth desktop app (Tauri v2).
//!
//! A native shell around the Hearth web wallet + explorer (bundled from `web/`)
//! that can launch a local `hearthd` node so the whole thing is one click:
//! *node + wallet + miner* in a single window.
//!
//! Until the Rust node reaches parity, "Start your hearth" launches the JS
//! reference node (`node/bin/hearthd.js`) as a child process; the migration to
//! an embedded Rust node is tracked in docs/roadmap.md.

use std::process::{Child, Command};
use std::sync::Mutex;
use tauri::State;

#[derive(Default)]
struct NodeProc(Mutex<Option<Child>>);

/// Path to the reference node entrypoint. Override with HEARTH_NODE_JS.
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
