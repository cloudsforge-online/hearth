'use strict';
/* The three files have to agree, and nothing else checks that they do.
 * Run: node app-desktop/test/wiring.js
 *
 * WHY THIS EXISTS. The scaffolding this application replaces failed in exactly
 * this seam and said so in its own README: "the three native commands have zero
 * callers". `start_node`, `stop_node` and `node_running` were registered,
 * compiled, reviewed and shipped, and nothing on the page ever called them. That
 * is not a bug a compiler can see — Rust is happy, the JavaScript is happy, the
 * app builds and opens — and it is not a bug a unit test finds either, because
 * each half works.
 *
 * The same seam has three more ways to break, all silent:
 *
 *   A MISTYPED COMMAND NAME is a button that does nothing. `invoke('unlok')`
 *   raises inside a promise nobody awaited.
 *   A MISTYPED ARGUMENT NAME is a command that runs with a missing argument.
 *   Tauri converts `privateKey` to `private_key` for you, which is convenient
 *   and means the two spellings have to be checked against each other rather
 *   than compared.
 *   AN EVENT NOBODY LISTENS FOR is a window that goes quiet. The engine emits
 *   `badwork` when it refuses to mine; if the page does not listen, mining stops
 *   and the user sees a hashrate of zero with no reason given.
 *
 * So this file reads the three sources as text and requires them to line up in
 * both directions: no caller without a command, and NO COMMAND WITHOUT A CALLER.
 */

const fs = require('fs');
const path = require('path');

const HERE = path.join(__dirname, '..');
const ui = fs.readFileSync(path.join(HERE, 'ui', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(HERE, 'ui', 'index.html'), 'utf8');
const rust = fs.readFileSync(path.join(HERE, 'src-tauri', 'src', 'main.rs'), 'utf8');
const engineJs = fs.readFileSync(path.join(HERE, 'engine', 'engine.js'), 'utf8');
const sessionJs = fs.readFileSync(
  path.join(HERE, '..', 'node', 'src', 'mine', 'session.js'), 'utf8');

let checks = 0, failed = 0;
function assert(cond, msg) {
  checks++;
  if (cond) console.log('  ✓ ' + msg);
  else { failed++; console.log('  ✗ ' + msg); }
}
const group = name => console.log('\n• ' + name);
const all = (text, re) => [...text.matchAll(re)].map(m => m[1]);
/* Comments are stripped before any "this must not appear" scan. The first
 * version of this file failed on app.js's own `// textContent, never innerHTML`
 * — a rule that its own explanation violates is a rule nobody can satisfy. */
const code = t => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const uniq = a => [...new Set(a)];
const missing = (from, inThere) => from.filter(x => !inThere.includes(x));

console.log('\nHearth desktop — do the window, the shell and the engine agree?\n');

// ---------------------------------------------------------------------------
group('every command the window calls exists, and every command that exists is called');
// ---------------------------------------------------------------------------
const called = uniq(all(ui, /invoke\('([a-z_]+)'/g));
const handler = (rust.match(/generate_handler!\[([\s\S]*?)\]/) || [, ''])[1]
  .split(',').map(s => s.trim()).filter(Boolean);
const defined = uniq(all(rust, /#\[tauri::command\]\s*\n\s*fn ([a-z_]+)/g));

assert(called.length >= 10, `the window calls ${called.length} commands`);
assert(handler.length >= 10, `and ${handler.length} are registered with Tauri`);
assert(missing(defined, handler).length === 0,
  `every #[tauri::command] is registered${fmt(missing(defined, handler))}`);
assert(missing(called, handler).length === 0,
  `every command the window calls is registered${fmt(missing(called, handler))}`);
/* THE DEFECT THIS FILE IS NAMED AFTER. A registered command with no caller is
 * dead code that looks like a feature, and it is what the previous version of
 * this application shipped three of. */
assert(missing(handler, called).length === 0,
  `AND NO REGISTERED COMMAND HAS ZERO CALLERS${fmt(missing(handler, called))}`);

function fmt(list) { return list.length ? ` — missing: ${list.join(', ')}` : ''; }

// ---------------------------------------------------------------------------
group('the arguments line up, across the camelCase/snake_case boundary');
// Tauri converts `privateKey` to `private_key`, so the two spellings cannot be
// compared directly — which is precisely why nobody notices when they diverge.
// ---------------------------------------------------------------------------
{
  const snake = s => s.replace(/[A-Z]/g, c => '_' + c.toLowerCase());
  let compared = 0, wrong = [];
  for (const cmd of called) {
    // What the window passes: invoke('cmd', { a, b: x, c: 1 })
    const call = new RegExp(`invoke\\('${cmd}',\\s*\\{([^}]*)\\}`).exec(ui);
    const passed = call
      ? uniq(call[1].split(',').map(s => s.split(':')[0].trim()).filter(k => /^[A-Za-z_]+$/.test(k)))
      : [];
    // What the command takes, minus the state handle Tauri injects.
    const sig = new RegExp(`fn ${cmd}\\(([\\s\\S]*?)\\)\\s*->`).exec(rust)
      || new RegExp(`fn ${cmd}\\(([\\s\\S]*?)\\)\\s*\\{`).exec(rust);
    if (!sig) continue;
    const takes = sig[1].split(',')
      .map(s => s.trim().split(':')[0].trim())
      .filter(n => n && n !== 'app' && !n.startsWith('_'));
    compared++;
    for (const p of passed) if (!takes.includes(snake(p))) wrong.push(`${cmd}(${p} → ${snake(p)})`);
    for (const t of takes) {
      if (!passed.map(snake).includes(t)) wrong.push(`${cmd} wants ${t}, which the window never sends`);
    }
  }
  assert(compared >= 6, `${compared} commands were checked argument by argument`);
  assert(wrong.length === 0, `and every argument matches${wrong.length ? ' — ' + wrong.join('; ') : ''}`);
}

// ---------------------------------------------------------------------------
group('every event the engine can emit is one the window is listening for');
// ---------------------------------------------------------------------------
{
  // What the session emits, at source, plus what the engine and the Rust shell
  // add on their own account.
  const fromSession = uniq(all(sessionJs, /_emit\('([a-z-]+)'/g));
  const forwarded = (engineJs.match(/for \(const e of \[([\s\S]*?)\]\)/) || [, ''])[1]
    .split(',').map(s => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
  const fromEngine = uniq(all(engineJs, /emit\('([a-z-]+)'/g));
  const fromRust = uniq(all(rust, /emit\("hearth:\/\/([a-z-]+)"/g));
  const listened = uniq(all(ui, /listen\('hearth:\/\/([a-z-]+)'/g));

  const emitted = uniq([...forwarded, ...fromEngine, ...fromRust, 'engine-exit'])
    .filter(e => e !== 'ready');    // `ready` is for a supervisor, not for a window

  assert(fromSession.length >= 10, `the mining loop emits ${fromSession.length} kinds of event`);
  const reaches = uniq([...forwarded, ...fromEngine]);
  assert(missing(fromSession, reaches).length === 0,
    `the engine passes every one of them on${fmt(missing(fromSession, reaches))}`);
  assert(missing(emitted, listened).length === 0,
    `AND THE WINDOW LISTENS FOR EVERY EVENT IT CAN RECEIVE${fmt(missing(emitted, listened))}`);
  assert(missing(listened, emitted).length === 0,
    `with no listener waiting for something that is never sent${fmt(missing(listened, emitted))}`);

  /* The two that matter most if they are ever dropped: one says the work is not
   * ours and mining has stopped, the other says the node went away. Both are
   * silent failures — a hashrate of zero with no explanation. */
  for (const critical of ['badwork', 'unreachable', 'accepted', 'stopped']) {
    assert(listened.includes(critical), `  including \`${critical}\``);
  }
}

// ---------------------------------------------------------------------------
group('every element the window reaches for is on the page');
// A typo here is a TypeError inside an event handler: the button is simply dead,
// and nothing in a build or a lint says so.
// ---------------------------------------------------------------------------
{
  const wanted = uniq([
    ...all(ui, /\$\('([a-z0-9-]+)'\)/g),
    ...all(ui, /show\('([a-z0-9-]+)'/g),
    ...all(ui, /text\('([a-z0-9-]+)'/g),
  ]);
  const present = uniq(all(html, /\bid="([a-z0-9-]+)"/g));
  assert(wanted.length >= 25, `the window addresses ${wanted.length} elements by id`);
  assert(missing(wanted, present).length === 0,
    `and every one of them is in index.html${fmt(missing(wanted, present))}`);
}

// ---------------------------------------------------------------------------
group('the window cannot leak what it is never given');
// ---------------------------------------------------------------------------
{
  assert(!/privateKey|private_key/.test(code(ui).replace(/privateKey: priv \|\| null/, '')),
    'app.js never touches a private key except to hand an imported one straight to the engine');
  assert(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(code(ui)),
    'and never builds DOM from a string — textContent only, so an address cannot become markup');
  const csp = JSON.parse(fs.readFileSync(path.join(HERE, 'src-tauri', 'tauri.conf.json'), 'utf8'))
    .app.security.csp;
  assert(!/unsafe-inline/.test(csp.split(';').find(d => d.includes('script-src')) || ''),
    'the CSP allows no inline script at all — the scaffolding needed `unsafe-inline` and this does not');
  assert(/default-src 'none'/.test(csp), "and denies everything by default");
  assert(!/connect-src[^;]*https?:\/\/(?!ipc)/.test(csp),
    'the page may not reach the network directly: every request goes through the engine');
}

console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} — ${checks - failed}/${checks} checks\n`);
process.exit(failed === 0 ? 0 : 1);
