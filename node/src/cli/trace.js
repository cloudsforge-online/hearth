'use strict';
/* `hearth trace` — the opcode-level debugger.
 *
 * This is the reason the CLI exists (docs/evm-spec.md §8, "The tracer is not a
 * phase-8 nicety"). When a GeneralStateTests vector fails, the difference
 * between an afternoon and a lost week is seeing the exact opcode where our
 * stack diverged from the reference — so this is built against the interpreter's
 * `onStep` hook during phase 3, and its first real user is a conformance vector,
 * not a chain transaction.
 *
 * THREE SOURCES, ONE PIPELINE. A vector, a chain transaction and a bare hunk of
 * bytecode all end up calling `EVM.call`/`EVM.create` with a `Tracer` attached,
 * and every renderer sees the same event list. That is deliberate: the thing you
 * do to a failing vector — filter to SSTORE, cut the depth, diff the JSON — has
 * to be the same thing you do to a failing transaction, or nobody learns the
 * tool well enough to reach for it under pressure.
 *
 * WHY THE HOOK IS NOT ENOUGH ON ITS OWN, and what this file does about it. The
 * `onStep` event carries pc, opcode, gas, depth, stack, memory size and the
 * SSTORE/SLOAD slot — everything about an INSTRUCTION. It carries nothing about
 * a FRAME: there is no enter/exit event, no calldata, no return data, and no
 * code. Three things a debugger cannot do without those:
 *
 *   - print a PUSH's immediate (the operand bytes are in the code, and the hook
 *     does not say what code is executing — `ev.address` is the storage context,
 *     which for DELEGATECALL is not where the code came from);
 *   - decode a NESTED revert reason (the payload is in the child frame's memory,
 *     and REVERT's step event shows only the memory *size*);
 *   - show a call tree at all.
 *
 * So the tracer also wraps `evm.call` and `evm.create` — the public API, from
 * outside, changing nothing in `src/evm/` — and gets frame boundaries, arguments,
 * results and the exact code buffer per depth that way. See the report attached
 * to this work: the cheapest fix upstream is for `onStep` to carry `codeAddress`
 * and the executing code, and for the hook to be called once more on frame exit.
 */

const fs = require('fs');
const path = require('path');

const { StateDB, MemoryDB } = require('../state/statedb');
const { EVM } = require('../evm/interpreter');
const { OPCODES } = require('../evm/opcodes');
const gasSchedule = require('../evm/gas');
const TX = require('../chain/transaction');
const abi = require('./abi');
const { Client } = require('./client');
const args = require('./args');
const ui = require('./ui');

const { c, hex, toBuf } = ui;
const EMPTY = Buffer.alloc(0);
const left = (v, n) => { const b = toBuf(v); return b.length === n ? b : Buffer.concat([Buffer.alloc(Math.max(0, n - b.length)), b]).subarray(-n); };
const addr20 = (v) => left(v, 20);
const slot32 = (v) => left(v, 32);

// ===========================================================================
// the tracer
// ===========================================================================

/**
 * Records an execution as a flat event list: `enter`, `step`, `exit`.
 *
 * Flat rather than a tree because every consumer wants time order — a trace is
 * read forwards, and diffing two of them against each other only works if both
 * are sequences. The frame nesting is still recoverable: `depth` is on every
 * event, and `enter`/`exit` bracket their steps exactly.
 */
class Tracer {
  constructor({ maxSteps = 0 } = {}) {
    this.events = [];
    this.steps = 0;
    this.truncated = false;
    this.maxSteps = maxSteps;
    this._codeByDepth = [];
    this._frameId = 0;
    this._open = [];
  }

  /** Install on an EVM instance. Nothing in src/evm/ is modified. */
  attach(evm) {
    this.evm = evm;
    evm.onStep = (ev) => this._step(ev);
    const call = evm.call.bind(evm);
    const create = evm.create.bind(evm);
    evm.call = (m) => this._frame(this._describeCall(m), this._codeFor(m), () => call(m));
    evm.create = (m) => this._frame(this._describeCreate(m), toBuf(m.initcode || EMPTY), () => create(m));
    return evm;
  }

  _codeFor(m) {
    if (m.code !== undefined) return toBuf(m.code);
    try { return this.evm.state.getCode(addr20(m.codeAddress === undefined ? m.to : m.codeAddress)); } catch { return EMPTY; }
  }

  _describeCall(m) {
    return {
      kind: m.kind || 'CALL',
      depth: m.depth || 0,
      from: hex(addr20(m.caller)),
      to: hex(addr20(m.to)),
      codeAddress: hex(addr20(m.codeAddress === undefined ? m.to : m.codeAddress)),
      value: BigInt(m.value === undefined ? 0 : m.value),
      gas: BigInt(m.gas),
      input: hex(toBuf(m.data || EMPTY)),
      static: Boolean(m.isStatic),
    };
  }

  _describeCreate(m) {
    const initcode = toBuf(m.initcode || EMPTY);
    return {
      kind: m.salt === undefined || m.salt === null ? 'CREATE' : 'CREATE2',
      depth: m.depth || 0,
      from: hex(addr20(m.caller)),
      to: null,
      codeAddress: null,
      value: BigInt(m.value === undefined ? 0 : m.value),
      gas: BigInt(m.gas),
      input: hex(initcode),
      static: false,
    };
  }

  _frame(info, code, run) {
    const frame = { ...info, id: ++this._frameId, steps: 0 };
    const prevCode = this._codeByDepth[frame.depth];
    this._codeByDepth[frame.depth] = code;
    this._open.push(frame);
    this.events.push({ type: 'enter', depth: frame.depth, frame });

    let r;
    try {
      r = run();
    } finally {
      this._codeByDepth[frame.depth] = prevCode;
      this._open.pop();
    }

    const returnData = toBuf(r.returnData || EMPTY);
    const exit = {
      type: 'exit',
      depth: frame.depth,
      frame,
      exception: r.exception || null,
      gasLeft: r.gasLeft,
      gasUsed: frame.gas - r.gasLeft,
      returnData: hex(returnData),
      createdAddress: r.createdAddress ? hex(r.createdAddress) : null,
      internalError: r.internalError ? String(r.internalError.message || r.internalError) : null,
      /* Only a REVERT carries a payload worth decoding — every other exception
       * returns empty, and "no reason" and "reason we failed to decode" must not
       * look the same to whoever is reading this at 2am. */
      revert: r.exception === 'execution reverted' ? abi.decodeRevert(returnData, this.abi || null) : null,
    };
    this.events.push(exit);
    return r;
  }

  _step(ev) {
    if (this.maxSteps && this.steps >= this.maxSteps) { this.truncated = true; return; }
    this.steps++;
    const open = this._open[this._open.length - 1];
    if (open) open.steps++;

    const info = OPCODES[ev.op];
    let immediate = null;
    if (info.immediate > 0) {
      const code = this._codeByDepth[ev.depth];
      if (code) {
        // A PUSH whose immediate runs off the end of the code is zero-padded, and
        // the interpreter does exactly that — so the disassembly must too, or the
        // trace disagrees with the value that lands on the stack.
        const raw = code.subarray(ev.pc + 1, ev.pc + 1 + info.immediate);
        immediate = hex(Buffer.concat([raw, Buffer.alloc(info.immediate - raw.length)]));
      }
    }

    this.events.push({
      type: 'step',
      pc: ev.pc,
      op: ev.op,
      mnemonic: ev.mnemonic,
      immediate,
      gasLeft: ev.gasLeft,
      gasCost: ev.gasCost,
      depth: ev.depth,
      // The hook hands out the stack bottom-first; every debugger prints it the
      // other way round, and so does this.
      stack: ev.stack.slice().reverse(),
      memorySize: ev.memorySize,
      address: hex(ev.address),
      static: ev.static,
      slot: ev.slot ? hex(ev.slot) : null,
      value: ev.value === undefined ? null : hex(ev.value),
      refund: ev.refund === undefined ? null : ev.refund,
      error: ev.error || null,
    });
  }
}

// ===========================================================================
// filtering
// ===========================================================================

/**
 * `--op=SSTORE,LOG` selects by mnemonic, and a bare family name selects the
 * whole family: `PUSH` matches PUSH0..PUSH32, `LOG` matches LOG0..LOG4. That is
 * not a convenience — the alternative is `--op=LOG0,LOG1,LOG2,LOG3,LOG4`, which
 * is exactly the sort of thing people get wrong by one entry.
 */
function makeOpFilter(spec) {
  if (!spec) return null;
  const wanted = String(spec).split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  const known = new Set(OPCODES.filter((o) => o.defined).map((o) => o.name));
  for (const w of wanted) {
    if (known.has(w)) continue;
    if ([...known].some((n) => n.startsWith(w) && /^\d+$/.test(n.slice(w.length)))) continue;
    throw new args.UsageError(`--op: no opcode or family called ${JSON.stringify(w)}`);
  }
  return (mnemonic) => wanted.some((w) => mnemonic === w || (mnemonic.startsWith(w) && /^\d+$/.test(mnemonic.slice(w.length))));
}

/**
 * Apply `--depth` and `--op`.
 *
 * `--depth=N` COLLAPSES deeper frames rather than erasing them: the
 * instructions inside go, but the frame's own enter and exit lines stay, one
 * level further down than the deepest instructions shown. That is the "step
 * over" a debugger gives you, and it is the difference between
 *
 *     CALL                       and    → CALL 0x…bb gas 65535
 *                                       ← execution reverted Error("nope")
 *
 * — which is the single most useful line in the trace and the one you would
 * otherwise have to turn the filter off to see.
 *
 * `enter`/`exit` also survive an `--op` filter, because a list of SSTOREs with
 * no indication of which contract ran them is not worth reading.
 */
function filterEvents(events, { maxDepth = null, opFilter = null } = {}) {
  return events.filter((e) => {
    if (maxDepth !== null) {
      const limit = e.type === 'step' ? maxDepth : maxDepth + 1;
      if (e.depth > limit) return false;
    }
    if (opFilter && e.type === 'step' && !opFilter(e.mnemonic)) return false;
    return true;
  });
}

// ===========================================================================
// rendering
// ===========================================================================

const KIND_COLOUR = { CALL: c.cyan, STATICCALL: c.cyan, DELEGATECALL: c.magenta, CALLCODE: c.magenta, CREATE: c.green, CREATE2: c.green };

function renderText(result, o = {}) {
  const stackDepth = o.stack === undefined ? 4 : o.stack;
  const lines = [];
  const events = result.events;

  lines.push(c.dim(`source   ${result.source}`));
  if (result.note) for (const n of [].concat(result.note)) lines.push(c.dim(`note     ${n}`));
  lines.push('');
  /* The numeric columns come BEFORE the opcode on purpose. A PUSH32 immediate is
   * 66 characters and would push everything after it out of alignment — and gas,
   * cost and depth are precisely the columns you scan down when hunting the step
   * where this implementation and a reference one part company. */
  lines.push(c.bold(
    ui.padStart('depth', 5) + ui.padStart('pc', 7) + ui.padStart('gas', 12) + ui.padStart('cost', 9) +
    ui.padStart('mem', 8) + '  ' + ui.padEnd('opcode', 20) + '  stack (top first)',
  ));

  for (const e of events) {
    if (e.type === 'enter') {
      const colour = KIND_COLOUR[e.frame.kind] || c.cyan;
      const bits = [colour(e.frame.kind)];
      if (e.frame.to) bits.push(ui.shortHex(e.frame.to, 6));
      if (e.frame.codeAddress && e.frame.codeAddress !== e.frame.to) bits.push(c.dim('code ' + ui.shortHex(e.frame.codeAddress, 6)));
      bits.push(c.dim('gas ' + e.frame.gas));
      if (e.frame.value > 0n) bits.push(c.dim('value ' + e.frame.value));
      bits.push(c.dim(((toBuf(e.frame.input).length)) + 'B in'));
      if (e.frame.static) bits.push(c.dim('static'));
      lines.push('  '.repeat(e.depth) + c.dim('→ ') + bits.join(' '));
      continue;
    }
    if (e.type === 'exit') {
      const bits = [];
      if (e.exception) {
        bits.push(c.red(e.exception));
        if (e.revert) bits.push(c.yellow(e.revert.text));
        else if (e.exception === 'execution reverted') bits.push(c.dim('(no reason given)'));
      } else {
        bits.push(c.green('ok'));
        if (e.createdAddress) bits.push('deployed ' + ui.shortHex(e.createdAddress, 6));
      }
      bits.push(c.dim(`gas used ${e.gasUsed}`), c.dim(`${toBuf(e.returnData).length}B out`));
      if (e.internalError) bits.push(c.red('INTERNAL: ' + e.internalError));
      lines.push('  '.repeat(e.depth) + c.dim('← ') + bits.join(' '));
      continue;
    }

    const op = e.mnemonic + (e.immediate ? ' ' + e.immediate : '');
    const stack = e.stack.slice(0, stackDepth).map((w) => '0x' + w.toString(16));
    let row =
      ui.padStart(String(e.depth), 5) +
      ui.padStart(e.pc.toString(16).padStart(4, '0'), 7) +
      ui.padStart(String(e.gasLeft), 12) +
      ui.padStart(String(e.gasCost), 9) +
      ui.padStart(String(e.memorySize), 8) + '  ' +
      ui.padEnd(op, 20) + '  ' +
      (stack.length ? stack.join(' ') : c.dim('·')) +
      (e.stack.length > stackDepth ? c.dim(` +${e.stack.length - stackDepth}`) : '');

    if (e.slot) {
      const arrow = e.mnemonic === 'SSTORE' ? '<-' : '->';
      row += '   ' + c.yellow(`${e.mnemonic} ${ui.word(e.slot)} ${arrow} ${ui.word(e.value)}`);
      if (e.refund) row += c.dim(` refund ${e.refund}`);
    }
    if (e.error) row += '   ' + c.red(e.error);
    lines.push(row);
  }

  if (result.truncated) lines.push(c.yellow(`… truncated at --max-steps=${result.maxSteps}`));

  lines.push('');
  const r = result.result;
  lines.push(
    (r.exception ? c.red('FAILED  ' + r.exception) : c.green('OK')) +
    `  gas used ${r.gasUsed}` +
    (r.gasRefunded ? `  refunded ${r.gasRefunded}` : '') +
    `  steps ${result.steps}` +
    (r.createdAddress ? `  deployed ${r.createdAddress}` : ''),
  );
  if (r.revert) lines.push('revert   ' + c.yellow(r.revert.text));
  if (r.returnData && r.returnData !== '0x') lines.push('return   ' + r.returnData);
  if (r.internalError) lines.push(c.red('internal error: ' + r.internalError) + c.dim('  — this is a bug in the interpreter, not an EVM outcome'));
  return lines.join('\n');
}

function renderJson(result) {
  return ui.jsonStringify({
    source: result.source,
    note: result.note || null,
    steps: result.steps,
    truncated: result.truncated,
    events: result.events,
    result: result.result,
  });
}

// ===========================================================================
// running
// ===========================================================================

/** The shape every source returns, so the renderers never branch on source. */
function summarise(tracer, top, gasIn, extra = {}) {
  return {
    source: extra.source || 'unknown',
    note: extra.note || null,
    steps: tracer.steps,
    truncated: tracer.truncated,
    maxSteps: tracer.maxSteps,
    events: tracer.events,
    result: {
      exception: top.exception || null,
      gasLeft: top.gasLeft,
      gasUsed: gasIn - top.gasLeft,
      gasRefunded: extra.gasRefunded === undefined ? null : extra.gasRefunded,
      returnData: hex(top.returnData || EMPTY),
      createdAddress: top.createdAddress ? ui.checksumAddress(top.createdAddress) : null,
      revert: top.exception === 'execution reverted' ? abi.decodeRevert(top.returnData || EMPTY, tracer.abi || null) : null,
      internalError: top.internalError ? String(top.internalError.message || top.internalError) : null,
      ...(extra.result || {}),
    },
  };
}

/** Seed a StateDB from `{ '0x…': { nonce, balance, code, storage } }`. */
function seedState(pre) {
  const db = new StateDB(new MemoryDB());
  for (const [a, acc] of Object.entries(pre || {})) {
    const A = addr20(a);
    db.setAccount(A, { nonce: BigInt(acc.nonce || 0), balance: BigInt(acc.balance || 0) });
    const code = toBuf(acc.code || EMPTY);
    if (code.length) db.setCode(A, code);
    for (const [k, v] of Object.entries(acc.storage || {})) db.setStorage(A, toBuf(k), toBuf(v));
  }
  db.commit();
  return db;
}

// ---- source 1: bare bytecode ----------------------------------------------

/**
 * Run a hunk of bytecode with nothing around it. This is the source the unit
 * tests drive, and the one to reach for when a vector has been narrowed to a
 * single contract.
 */
function traceCode(o = {}) {
  const code = toBuf(args.need(o, 'code', 'the bytecode to run'));
  const address = addr20(o.address || '0x00000000000000000000000000000000000000aa');
  const caller = addr20(o.caller || '0x00000000000000000000000000000000000000ca');
  const gas = o.gas === undefined ? 1000000n : BigInt(o.gas);
  const value = o.value === undefined ? 0n : BigInt(o.value);

  const pre = {
    [hex(address)]: { nonce: 0n, balance: o.balance === undefined ? 0n : BigInt(o.balance), code, storage: o.storage || {} },
    [hex(caller)]: { nonce: 0n, balance: o.callerBalance === undefined ? 10n ** 20n : BigInt(o.callerBalance), code: EMPTY, storage: {} },
    ...(o.accounts || {}),
  };
  const db = seedState(pre);
  db.beginTransaction();
  db.prepareAccessList({ origin: caller, to: address, coinbase: addr20(o.coinbase || Buffer.alloc(20)) });

  const evm = new EVM({
    state: db,
    block: {
      number: o.blockNumber === undefined ? 1n : BigInt(o.blockNumber),
      timestamp: o.timestamp === undefined ? 1n : BigInt(o.timestamp),
      coinbase: addr20(o.coinbase || Buffer.alloc(20)),
      gasLimit: o.blockGasLimit === undefined ? 30000000n : BigInt(o.blockGasLimit),
      prevRandao: o.prevRandao === undefined ? 0n : BigInt(o.prevRandao),
      chainId: TX.CHAIN_ID,
    },
    tx: { origin: caller, gasPrice: o.gasPrice === undefined ? 1n : BigInt(o.gasPrice) },
  });

  const tracer = new Tracer({ maxSteps: o.maxSteps || 0 });
  tracer.abi = o.abi || null;
  tracer.attach(evm);

  const top = evm.call({ caller, to: address, data: toBuf(o.calldata || EMPTY), gas, value });
  return summarise(tracer, top, gas, {
    source: o.source || `code (${code.length} bytes)`,
    result: { logs: evm.logs.map((l) => ({ address: hex(l.address), topics: l.topics.map(hex), data: hex(l.data) })) },
  });
}

// ---- source 2: a conformance vector ---------------------------------------

/**
 * The conformance loader is in `test/`, not `src/`, because it is a test asset.
 * Requiring it lazily keeps `src/cli` importable from a published package that
 * ships `src` and `bin` only — and the alternative, a second copy of the fixture
 * parser, would be a second place for the four corpus gotchas that
 * docs/evm-spec.md §0 lists to be got wrong.
 */
function loadLoader() {
  try {
    return require(path.join(__dirname, '..', '..', 'test', 'conformance', 'loader.js'));
  } catch (e) {
    throw new Error('vector tracing needs test/conformance/loader.js, which is not in this install: ' + e.message);
  }
}

function pickVector(file, caseName) {
  const loader = loadLoader();
  const { vectors, suite } = loader.loadFile(file);
  if (vectors.length === 0) throw new Error(`${file} parsed as ${suite} but contains no executable vectors`);
  if (!caseName) {
    if (vectors.length === 1) return { vector: vectors[0], suite, count: 1 };
    const names = vectors.slice(0, 8).map((v) => '  ' + v.name);
    throw new Error(`${file} holds ${vectors.length} vectors; name one with --case\n${names.join('\n')}${vectors.length > 8 ? '\n  …' : ''}`);
  }
  const hit = vectors.filter((v) => v.name === caseName || v.case === caseName || v.name.endsWith(caseName));
  if (hit.length === 0) throw new Error(`no vector matching ${JSON.stringify(caseName)} in ${file}`);
  return { vector: hit[0], suite, count: vectors.length };
}

/* testeth filled the VM fixtures with a fake environment whose BLOCKHASH is the
 * keccak of the block number in decimal. A harness convention, not a chain rule
 * — the same one test/interpreter.js applies, and the trace has to match the
 * conformance run exactly or it is describing a different execution. */
function fixtureBlockHash(n) {
  const { keccak256 } = require('../crypto/keccak');
  return keccak256(Buffer.from(n.toString(10), 'utf8'));
}

function traceVmVector(v, o = {}) {
  const db = seedState(v.pre);
  db.beginTransaction();
  db.prepareAccessList({ origin: addr20(v.exec.origin), to: addr20(v.exec.address), coinbase: addr20(v.env.coinbase) });

  const evm = new EVM({
    state: db,
    block: {
      number: v.env.number,
      timestamp: v.env.timestamp,
      coinbase: v.env.coinbase,
      gasLimit: v.env.gasLimit,
      prevRandao: v.env.random !== null ? v.env.random : v.env.difficulty,
      baseFee: v.env.baseFee || 0n,
      chainId: TX.CHAIN_ID,
    },
    tx: { origin: v.exec.origin, gasPrice: v.exec.gasPrice },
    blockHash: fixtureBlockHash,
  });

  const tracer = new Tracer({ maxSteps: o.maxSteps || 0 });
  tracer.abi = o.abi || null;
  tracer.attach(evm);

  /* VMTests are single-frame and their pre-state ALREADY reflects the value
   * having moved, so the transfer must not run again — `transfer: false` with the
   * apparent CALLVALUE supplied separately. Getting this wrong double-credits the
   * callee and every balance in the trace is off by `value`. */
  const top = evm.call({
    caller: v.exec.caller,
    to: v.exec.address,
    code: v.exec.code,
    callValue: v.exec.value,
    value: 0n,
    transfer: false,
    data: v.exec.data,
    gas: v.exec.gas,
  });

  const note = [
    `VMTests are Constantinople semantics at Frontier prices — their post states hold under Shanghai, their gas does not.`,
  ];
  if (v.expectException) note.push('this vector asserts that execution FAILS and consumes all gas.');
  else if (v.gasRemaining !== null) note.push(`the vector expects ${v.gasRemaining} gas remaining (VMTests \`gas\` is gas REMAINING, not gas used).`);

  const self = addr20(v.exec.address);
  const post = v.post && v.post[hex(self)];
  return summarise(tracer, top, v.exec.gas, {
    source: `vector ${v.name}`,
    note,
    result: {
      expect: v.expectException
        ? { exception: true }
        : { gasRemaining: v.gasRemaining, out: v.out, balance: post ? post.balance : null },
      /* The executing account's balance, because the commonest way to get a VM
       * vector wrong is to move `value` a second time — the fixture's pre-state
       * has already moved it — and the only place that shows up is here. */
      balance: db.getBalance(self),
      logs: evm.logs.map((l) => ({ address: hex(l.address), topics: l.topics.map(hex), data: hex(l.data) })),
    },
  });
}

/**
 * A GeneralStateTests vector: intrinsic gas, then one top-level call or create.
 *
 * Phase 4's `chain/statetransition.js` does not exist yet, so the transition
 * around the call is open-coded here — deliberately, and it is NOT a second
 * implementation of consensus: it stops at the interpreter's edge, does not
 * compute a state root, and does not pay the coinbase. What it gives you is the
 * one thing phase 4 will need on the morning a vector goes red, which is the
 * opcode stream with the right gas at the top of it.
 */
function traceStateVector(v, o = {}) {
  const tx = v.tx;
  let sender = tx.sender;
  if (!sender && tx.secretKey) {
    const secp = require('../crypto/secp256k1');
    sender = hex(TX.addressFromPublicKey(secp.publicKeyFromPrivate(tx.secretKey, false)));
  }
  if (!sender) throw new Error(`${v.name}: the fixture names neither a sender nor a secretKey`);
  const from = addr20(sender);

  const db = seedState(v.pre);
  db.beginTransaction();
  db.prepareAccessList({
    origin: from,
    to: tx.to ? addr20(tx.to) : null,
    coinbase: addr20(v.env.coinbase),
    accessList: tx.accessList || [],
  });

  const isCreation = tx.to === null;
  const intrinsic = gasSchedule.intrinsicGas({ data: tx.data, isCreation, accessList: tx.accessList || [] });
  const gasPrice = tx.gasPrice === null ? (tx.maxFeePerGas || 0n) : tx.gasPrice;

  const note = [];
  if (tx.type !== 0) note.push(`this is a type-${tx.type} transaction; Hearth v1 is legacy-only (spec §3), so its fee fields are read as a flat gasPrice.`);
  if (v.expectException) note.push(`the vector expects the transaction to be REJECTED: ${v.expectException}`);
  note.push('no state root is computed here — that is phase 4. This shows execution, not the transition.');

  if (tx.gasLimit < intrinsic) {
    return {
      source: `vector ${v.name}`,
      note: [...note, `gasLimit ${tx.gasLimit} is below the intrinsic cost ${intrinsic}; nothing executes.`],
      steps: 0, truncated: false, maxSteps: 0, events: [],
      result: { exception: 'intrinsic gas too low', gasLeft: 0n, gasUsed: tx.gasLimit, returnData: '0x', createdAddress: null, revert: null, internalError: null, intrinsicGas: intrinsic },
    };
  }

  // Charge the up-front cost exactly as a transition would: the fee is taken
  // before execution and the nonce bump survives whatever happens next. A
  // fixture whose whole point is that the sender cannot afford it says so here.
  try {
    db.subBalance(from, tx.gasLimit * gasPrice);
  } catch {
    return {
      source: `vector ${v.name}`,
      note: [...note, `sender ${ui.checksumAddress(from)} cannot cover gasLimit * gasPrice (${tx.gasLimit * gasPrice}); nothing executes.`],
      steps: 0, truncated: false, maxSteps: 0, events: [],
      result: { exception: 'insufficient funds for gas * price', gasLeft: 0n, gasUsed: 0n, returnData: '0x', createdAddress: null, revert: null, internalError: null, intrinsicGas: intrinsic },
    };
  }
  /* The nonce bump belongs to the CALL path only. `EVM.create` does its own,
   * and the address it derives is `keccak(rlp([sender, nonce_BEFORE_the_bump]))`
   * — so bumping here too traces a creation at the wrong address entirely, with
   * the wrong pre-existing account under it. `chain/statetransition.js`
   * makes the same distinction, for the same reason. This is silent when it is
   * wrong: the trace still runs, still says OK, and simply describes a
   * transaction that never happened. */
  if (!isCreation) db.setNonce(from, db.getNonce(from) + 1n);

  const evm = new EVM({
    state: db,
    block: {
      number: v.env.number,
      timestamp: v.env.timestamp,
      coinbase: v.env.coinbase,
      gasLimit: v.env.gasLimit,
      prevRandao: v.env.random !== null ? v.env.random : v.env.difficulty,
      baseFee: v.env.baseFee || 0n,
      chainId: TX.CHAIN_ID,
    },
    tx: { origin: from, gasPrice },
  });

  const tracer = new Tracer({ maxSteps: o.maxSteps || 0 });
  tracer.abi = o.abi || null;
  tracer.attach(evm);

  const gasIn = tx.gasLimit - intrinsic;
  const top = isCreation
    ? evm.create({ caller: from, initcode: tx.data, gas: gasIn, value: tx.value })
    : evm.call({ caller: from, to: addr20(tx.to), data: tx.data, gas: gasIn, value: tx.value });

  const used = tx.gasLimit - top.gasLeft;
  const refund = top.exception ? 0n : gasSchedule.refundAllowance(used, db.getRefund());

  return summarise(tracer, top, gasIn, {
    source: `vector ${v.name}`,
    note,
    gasRefunded: refund,
    result: {
      intrinsicGas: intrinsic,
      gasUsedTotal: used - refund,
      expectRoot: v.expectRoot,
      logs: evm.logs.map((l) => ({ address: hex(l.address), topics: l.topics.map(hex), data: hex(l.data) })),
    },
  });
}

function traceVector(file, caseName, o = {}) {
  const { vector, suite } = pickVector(file, caseName);
  if (vector.kind === 'vm') return traceVmVector(vector, o);
  if (vector.kind === 'state') return traceStateVector(vector, o);
  throw new Error(`${file} is a ${suite} fixture (${vector.kind}); only VMTests and GeneralStateTests are executable`);
}

// ---- source 3: a chain transaction ----------------------------------------

/* Read methods whose miss means "we have not fetched this account yet", and the
 * ones that additionally name a storage slot. */
const ACCOUNT_READS = new Set(['getBalance', 'getNonce', 'getCode', 'getCodeHash', 'exists', 'empty', 'isEmpty', 'warmAddress']);
const SLOT_READS = new Set(['getStorage', 'originalStorage', 'warmSlot']);

/**
 * A StateDB that notes every account and slot the run touches.
 *
 * The node we are asking has the state; we just do not know in advance which
 * parts. Rather than a synchronous state oracle (impossible over HTTP without
 * blocking the loop) this runs the trace, collects what it reached for, fetches
 * that, and runs again — repeating until a round asks for nothing new. Execution
 * is deterministic, so the fixed point is the true execution; the only cost is a
 * handful of extra rounds, one per level of "the address I call is stored in the
 * slot I just read".
 */
function watchState(db, seen) {
  return new Proxy(db, {
    get(target, prop, recv) {
      const v = Reflect.get(target, prop, recv);
      if (typeof v !== 'function') return v;
      if (ACCOUNT_READS.has(prop)) {
        return (a, ...rest) => { seen.account(a); return v.call(target, a, ...rest); };
      }
      if (SLOT_READS.has(prop)) {
        return (a, slot, ...rest) => { seen.account(a); seen.slot(a, slot); return v.call(target, a, slot, ...rest); };
      }
      return v.bind(target);
    },
  });
}

async function traceChainTx(txHash, o = {}) {
  const client = o.client || new Client(o.rpc);
  const tx = await client.getTransactionByHash(txHash);
  if (!tx) throw new Error(`no transaction ${txHash} on ${client.url}`);
  if (tx.blockNumber === null || tx.blockNumber === undefined) throw new Error(`${txHash} is still pending; there is no block state to replay it against`);

  const blockNumber = BigInt(tx.blockNumber);
  const block = await client.getBlockByNumber(blockNumber, false);
  if (!block) throw new Error(`the node has transaction ${txHash} but not its block ${blockNumber}`);
  // State is read at the PARENT block, which is exact only for the first
  // transaction in a block — see the note this attaches to the output.
  const at = '0x' + (blockNumber - 1n).toString(16);

  const from = addr20(tx.from);
  const to = tx.to ? addr20(tx.to) : null;
  const data = toBuf(tx.input === undefined ? tx.data : tx.input);
  const value = BigInt(tx.value || 0);
  const gasLimit = BigInt(tx.gas);
  const gasPrice = BigInt(tx.gasPrice || 0);

  const accounts = new Map();     // addrHex -> { nonce, balance, code }
  const slots = new Map();        // addrHex -> Map(slotHex -> Buffer)
  const wantAccounts = new Set();
  const wantSlots = new Set();

  const seen = {
    account(a) { try { wantAccounts.add(hex(addr20(a))); } catch { /* not an address */ } },
    slot(a, s) { try { wantSlots.add(hex(addr20(a)) + '|' + hex(slot32(s))); } catch { /* not a slot */ } },
  };
  seen.account(from);
  if (to) seen.account(to);

  const MAX_ROUNDS = 12;
  let rounds = 0;
  let result = null;

  for (;;) {
    // Fetch everything asked for that we do not have; stop when nothing is new.
    const newAccounts = [...wantAccounts].filter((a) => !accounts.has(a));
    const newSlots = [...wantSlots].filter((k) => {
      const [a, s] = k.split('|');
      return !(slots.get(a) && slots.get(a).has(s));
    });
    if (rounds > 0 && newAccounts.length === 0 && newSlots.length === 0) break;
    if (rounds >= MAX_ROUNDS) throw new Error(`state prefetch did not settle after ${MAX_ROUNDS} rounds — this transaction reaches more state than this replay can chase`);
    rounds++;

    await Promise.all(newAccounts.map(async (a) => {
      const [nonce, balance, code] = await Promise.all([client.getNonce(a, at), client.getBalance(a, at), client.getCode(a, at)]);
      accounts.set(a, { nonce, balance, code });
    }));
    await Promise.all(newSlots.map(async (k) => {
      const [a, s] = k.split('|');
      const v = await client.getStorageAt(a, s, at);
      if (!slots.has(a)) slots.set(a, new Map());
      slots.get(a).set(s, v);
    }));

    const pre = {};
    for (const [a, acc] of accounts) {
      pre[a] = { nonce: acc.nonce, balance: acc.balance, code: acc.code, storage: {} };
      for (const [s, v] of slots.get(a) || []) pre[a].storage[s] = v;
    }
    // The sender must be able to afford the fee at replay time even if the node
    // reported the parent balance before an earlier tx in the block topped it up.
    const db = seedState(pre);
    db.beginTransaction();
    db.prepareAccessList({ origin: from, to, coinbase: addr20(block.miner || Buffer.alloc(20)) });

    const watched = watchState(db, seen);
    const evm = new EVM({
      state: watched,
      block: {
        number: blockNumber,
        timestamp: BigInt(block.timestamp),
        coinbase: addr20(block.miner || Buffer.alloc(20)),
        gasLimit: BigInt(block.gasLimit),
        prevRandao: BigInt(block.mixHash || block.difficulty || 0),
        baseFee: block.baseFeePerGas === undefined ? 0n : BigInt(block.baseFeePerGas),
        chainId: await client.chainId().catch(() => TX.CHAIN_ID),
      },
      tx: { origin: from, gasPrice },
      blockHash: () => null,
    });

    const tracer = new Tracer({ maxSteps: o.maxSteps || 0 });
    tracer.abi = o.abi || null;
    tracer.attach(evm);

    const intrinsic = gasSchedule.intrinsicGas({ data, isCreation: to === null });
    const gasIn = gasLimit - intrinsic;
    if (gasIn < 0n) throw new Error(`${txHash} declares gas ${gasLimit}, below its intrinsic cost ${intrinsic} — the node served a transaction it should never have accepted`);

    const top = to === null
      ? evm.create({ caller: from, initcode: data, gas: gasIn, value })
      : evm.call({ caller: from, to, data, gas: gasIn, value });

    const note = [`state read at block ${blockNumber - 1n}; ${rounds} prefetch round${rounds === 1 ? '' : 's'}.`];
    const index = tx.transactionIndex === undefined || tx.transactionIndex === null ? null : Number(tx.transactionIndex);
    if (index !== null && index > 0) {
      note.push(`this is transaction #${index} in its block: the ${index} before it are NOT applied, so any state they changed is stale here.`);
    }
    note.push('BLOCKHASH returns zero: the replay does not fetch the 256 ancestor hashes.');

    result = summarise(tracer, top, gasIn, {
      source: `tx ${txHash} @ block ${blockNumber}`,
      note,
      result: { intrinsicGas: intrinsic, from: ui.checksumAddress(from), to: to ? ui.checksumAddress(to) : null },
    });
  }

  return result;
}

// ===========================================================================
// the command
// ===========================================================================

const USAGE = `hearth trace — replay an execution opcode by opcode

  hearth trace <txhash>              replay a transaction from a node
  hearth trace --vector <file.json>  replay a conformance vector
  hearth trace --code 0x60016002...  replay bare bytecode

options
  --rpc <url>          node to ask for the transaction and its state
  --case <name>        which vector, when the file holds more than one
  --calldata 0x…       input for --code
  --gas <n>            gas for --code                     (default 1000000)
  --value <n>          wei sent with --code               (default 0)
  --storage k=v,…      pre-set storage slots for --code
  --abi <file.json>    decode custom errors with this ABI
  --depth <n>          hide frames deeper than n
  --op <NAMES>         only these opcodes; PUSH and LOG match whole families
  --stack <n>          stack items per line               (default 4)
  --max-steps <n>      stop recording after n steps       (default unlimited)
  --json               machine-readable output
  --no-color           plain text even on a terminal`;

async function main(argv) {
  const { flags, positional } = args.parse(argv, {
    booleans: ['json', 'no-color'],
    strings: ['rpc', 'vector', 'case', 'code', 'calldata', 'gas', 'value', 'storage', 'abi', 'depth', 'op', 'stack', 'max-steps'],
  });
  if (flags.help) { console.log(USAGE); return 0; }
  if (flags['no-color']) ui.setColour(false);

  const contractAbi = flags.abi ? JSON.parse(fs.readFileSync(flags.abi, 'utf8')) : null;
  const abiList = Array.isArray(contractAbi) ? contractAbi : (contractAbi && contractAbi.abi) || null;
  const common = { maxSteps: args.intFlag(flags, 'max-steps', 0), abi: abiList };

  let result;
  if (flags.vector) {
    result = traceVector(flags.vector, flags.case || positional[0] || null, common);
  } else if (flags.code) {
    const storage = {};
    for (const pair of String(flags.storage || '').split(',').filter(Boolean)) {
      const [k, v] = pair.split('=');
      if (v === undefined) throw new args.UsageError(`--storage wants slot=value pairs, got ${JSON.stringify(pair)}`);
      storage[k.trim()] = v.trim();
    }
    result = traceCode({
      ...common,
      code: flags.code,
      calldata: flags.calldata,
      gas: args.bigFlag(flags, 'gas', 1000000n),
      value: args.bigFlag(flags, 'value', 0n),
      storage,
    });
  } else if (positional[0]) {
    result = await traceChainTx(positional[0], { ...common, rpc: flags.rpc });
  } else {
    console.error(USAGE);
    return 2;
  }

  const view = {
    ...result,
    events: filterEvents(result.events, {
      maxDepth: args.intFlag(flags, 'depth', null),
      opFilter: makeOpFilter(flags.op),
    }),
  };

  console.log(flags.json ? renderJson(view) : renderText(view, { stack: args.intFlag(flags, 'stack', 4) }));
  return view.result.exception ? 1 : 0;
}

module.exports = {
  main, USAGE,
  Tracer, traceCode, traceVector, traceVmVector, traceStateVector, traceChainTx,
  filterEvents, makeOpFilter, renderText, renderJson, seedState, summarise,
};
