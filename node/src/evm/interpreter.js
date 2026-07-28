'use strict';
/* Ember EVM — the execution loop and the call frames around it.
 *
 * Everything the other evm/ modules describe, this file finally does: it walks the
 * bytecode, prices each instruction out of gas.js, enforces the structural facts in
 * opcodes.js, and nests frames for CALL and CREATE down to 1024 deep.
 *
 * THE ERROR CONTRACT, which is the rule this file is built around. An EVM failure is
 * a value that is RETURNED — `{ exception: '…' }` — and never a JavaScript throw. A
 * thrown TypeError from an interpreter is indistinguishable, to any test harness, from
 * a correctly rejected transaction, which makes the vectors that assert *failure* the
 * easiest ones in the corpus to fake. So every exit from every frame goes through the
 * same result shape, and the top of each frame catches anything unforeseen, reverts
 * that frame's state and reports it as `internalError` alongside the exception, so a
 * genuine bug in here can still be told apart from a genuine EVM rejection.
 *
 * THE GAS CONTRACT, restated from opcodes.js and gas.js:
 *
 *     total = gas.baseGas(op) + <the gas.js function opcodes.js names> + <memory>
 *
 * and all of it is BigInt, because every input arrives as a 256-bit stack word and
 * Number has a precision cliff exactly where an attacker would aim. Pricing is a
 * separate pass from execution (`_price` then the execute switch) for two reasons:
 * gas must be affordable before a single byte of memory is allocated, and the tracer
 * needs the cost of an instruction *before* it runs.
 *
 * ORDER OF OPERATIONS INSIDE ONE STEP, all of it load-bearing:
 *   1. undefined byte            -> exceptional halt, all gas
 *   2. stack min/max             -> exceptional halt, all gas
 *   3. static-call write check   -> exceptional halt, all gas   (EIP-214)
 *   4. price                     -> may itself fail (EIP-3860 cap, RETURNDATACOPY bounds)
 *   5. onStep hook
 *   6. charge; short -> out of gas
 *   7. grow memory (paid for at 6, so the size is now known to be bounded)
 *   8. execute
 *
 * Fork: Shanghai. SELFDESTRUCT is pre-EIP-6780 and StateDB already implements it.
 * PREVRANDAO returns the parent block's Homefire PoW digest (spec §5); BASEFEE
 * pushes zero because v1 has no EIP-1559 market.
 */

const { keccak256 } = require('../crypto/keccak');
const RLP = require('../crypto/rlp');
const { EMPTY_CODE_HASH } = require('../state/statedb');

const U = require('./uint256');
const gas = require('./gas');
const { OPCODES } = require('./opcodes');
const { precompileAt, getData } = require('./precompiles');
const { Stack } = require('./stack');
const { Memory } = require('./memory');

const EMPTY = Buffer.alloc(0);
const MAX_DEPTH = 1024;
const MAX_NONCE = (1n << 64n) - 1n;

/** Every exceptional halt consumes all remaining gas. REVERT alone does not. */
const ERR = Object.freeze({
  OUT_OF_GAS: 'out of gas',
  STACK_UNDERFLOW: 'stack underflow',
  STACK_OVERFLOW: 'stack overflow',
  INVALID_OPCODE: 'invalid opcode',
  INVALID_JUMP: 'invalid jump destination',
  WRITE_PROTECTION: 'state change inside a static call',
  DEPTH: 'call depth limit reached',
  INSUFFICIENT_BALANCE: 'insufficient balance for transfer',
  REVERT: 'execution reverted',
  RETURNDATA_OUT_OF_BOUNDS: 'return data out of bounds',
  CODE_TOO_LARGE: 'max code size exceeded',
  INITCODE_TOO_LARGE: 'max initcode size exceeded',
  INVALID_CODE: 'invalid deployed code: 0xef prefix',
  COLLISION: 'contract address collision',
  NONCE_OVERFLOW: 'nonce overflow',
  UNSUPPORTED_PRECOMPILE: 'precompile not implemented on this chain',
  PRECOMPILE_FAILED: 'precompile rejected its input',
});

// ---------------------------------------------------------------------------
// coercions — callers hand us hex strings, Buffers and BigInts interchangeably
// ---------------------------------------------------------------------------

function toBuf(v, len) {
  let b;
  if (v === null || v === undefined) b = EMPTY;
  else if (Buffer.isBuffer(v)) b = v;
  else if (v instanceof Uint8Array) b = Buffer.from(v);
  else if (typeof v === 'bigint' || typeof v === 'number') b = U.toBuffer(BigInt(v));
  else if (typeof v === 'string') {
    const h = v.replace(/^0x/i, '');
    b = Buffer.from(h.length % 2 ? '0' + h : h, 'hex');
  } else throw new TypeError('interpreter: cannot read bytes from ' + typeof v);
  if (len === undefined) return b;
  if (b.length === len) return b;
  if (b.length > len) return Buffer.from(b.subarray(b.length - len));
  return Buffer.concat([Buffer.alloc(len - b.length), b]);
}

const toAddr = (v) => toBuf(v, 20);
function toBig(v) {
  if (typeof v === 'bigint') return v;
  if (v === null || v === undefined) return 0n;
  if (typeof v === 'number') return BigInt(v);
  if (typeof v === 'string') return v === '' ? 0n : BigInt(v.startsWith('0x') || v.startsWith('0X') ? v : '0x' + v);
  return U.fromBuffer(toBuf(v));
}

/** A 256-bit word as a 20-byte address: the LOW 20 bytes, upper 12 discarded. */
const wordToAddress = (w) => toBuf(w & ((1n << 160n) - 1n), 20);
/** An address as a right-aligned 256-bit word. */
const addressToWord = (a) => U.fromBuffer(toAddr(a));

// ---------------------------------------------------------------------------
// contract addresses
// ---------------------------------------------------------------------------

/** CREATE: keccak256(rlp([sender, nonce]))[12:]. */
function createAddress(sender, nonce) {
  return Buffer.from(keccak256(RLP.encode([toAddr(sender), toBig(nonce)])).subarray(12));
}

/** CREATE2 (EIP-1014): keccak256(0xff ++ sender ++ salt ++ keccak256(initcode))[12:]. */
function create2Address(sender, salt, initcode) {
  const pre = Buffer.concat([Buffer.from([0xff]), toAddr(sender), toBuf(salt, 32), keccak256(initcode)]);
  return Buffer.from(keccak256(pre).subarray(12));
}

// ---------------------------------------------------------------------------
// jump destination analysis
// ---------------------------------------------------------------------------

/* A 0x5b byte is only a JUMPDEST when it is an instruction, not when it is one of
 * the immediate bytes of a PUSH — `PUSH1 0x5b` must not be jumpable. Scanning per
 * jump would be O(code) per JUMP, so the bitmap is computed once and cached against
 * the code Buffer itself; StateDB hands out the same Buffer for the same codeHash,
 * so a contract called a thousand times is analysed once. */
const JUMPDEST_CACHE = new WeakMap();

function analyseJumpdests(code) {
  const cached = JUMPDEST_CACHE.get(code);
  if (cached) return cached;
  const map = new Uint8Array(code.length);
  for (let i = 0; i < code.length; i++) {
    const op = code[i];
    if (op === 0x5b) map[i] = 1;
    else if (op >= 0x60 && op <= 0x7f) i += op - 0x5f;
  }
  JUMPDEST_CACHE.set(code, map);
  return map;
}

// ---------------------------------------------------------------------------
// logs
// ---------------------------------------------------------------------------

/** The VMTests / receipts form: keccak256(rlp([[address, topics, data], …])). */
function logsHash(logs) {
  return keccak256(RLP.encode(logs.map((l) => [l.address, l.topics, l.data])));
}

// ---------------------------------------------------------------------------
// the frame
// ---------------------------------------------------------------------------

class Frame {
  constructor(msg, code) {
    this.msg = msg;
    this.code = code;
    this.pc = 0;
    this.gas = msg.gas;
    this.stack = new Stack();
    this.memory = new Memory();
    this.returnData = EMPTY;    // output of the LAST child call, for RETURNDATA*
    this.output = EMPTY;
    this.isStatic = !!msg.isStatic;
  }
}

/** The shape every frame, call and create returns. `exception` null means success. */
function result(exception, gasLeft, output, extra) {
  return Object.assign({ exception, gasLeft, returnData: output || EMPTY }, extra || {});
}

// ---------------------------------------------------------------------------
// the machine
// ---------------------------------------------------------------------------

/**
 * One EVM per transaction. It owns the frame stack, the log buffer and the block
 * and transaction context every frame reads; the StateDB owns everything undoable.
 *
 * @param {object}   o
 * @param {StateDB}  o.state        world state; frames snapshot and revert through it
 * @param {object}   o.block        { number, timestamp, coinbase, gasLimit, prevRandao,
 *                                    baseFee, chainId } — quantities as BigInt or hex
 * @param {object}   o.tx           { origin, gasPrice }
 * @param {function} [o.onStep]     tracer; see `_trace`. Absent costs nothing.
 * @param {function} [o.blockHash]  (number: bigint) -> 32-byte Buffer | null, for BLOCKHASH
 */
class EVM {
  constructor({ state, block = {}, tx = {}, onStep = null, blockHash = null } = {}) {
    this.state = state;
    this.onStep = onStep || null;
    this.blockHashFn = blockHash || (() => null);
    this.logs = [];

    this.block = {
      number: toBig(block.number),
      timestamp: toBig(block.timestamp),
      coinbase: toAddr(block.coinbase || EMPTY),
      gasLimit: toBig(block.gasLimit),
      // Spec §5: no beacon chain here, so PREVRANDAO is the parent block's Homefire
      // PoW digest — a real 256-bit hash rather than our near-constant difficulty
      // target. Miner-influenceable, and the developer docs must say so.
      prevRandao: toBig(block.prevRandao !== undefined ? block.prevRandao : block.difficulty),
      // EIP-3198 exists in Shanghai; v1 has no fee market, so it reads zero.
      baseFee: toBig(block.baseFee),
      chainId: toBig(block.chainId === undefined ? 7411 : block.chainId),
    };
    this.tx = { origin: toAddr(tx.origin || EMPTY), gasPrice: toBig(tx.gasPrice) };
  }

  /** Total gas refunded by SSTORE so far; StateDB journals it, so reverts undo it. */
  getRefund() { return this.state.getRefund(); }

  // -- message calls ---------------------------------------------------------

  /**
   * CALL / CALLCODE / DELEGATECALL / STATICCALL, and the transaction-level call.
   *
   * @param {object}  m
   * @param {string}  [m.kind='CALL']
   * @param {Buffer}  m.caller       msg.sender as the callee sees it
   * @param {Buffer}  m.to           the account whose storage and balance are in scope
   * @param {Buffer}  [m.codeAddress] where the code comes from (differs for CALLCODE)
   * @param {bigint}  [m.value=0n]   value to move
   * @param {bigint}  [m.callValue]  what CALLVALUE reports; defaults to `value`
   * @param {Buffer}  [m.data]       calldata
   * @param {bigint}  m.gas
   * @param {number}  [m.depth=0]
   * @param {boolean} [m.isStatic=false]
   * @param {boolean} [m.transfer=true]  false when the caller already moved the value
   */
  call(m) {
    const state = this.state;
    const kind = m.kind || 'CALL';
    const gasIn = toBig(m.gas);
    const depth = m.depth || 0;
    const value = toBig(m.value);

    if (depth > MAX_DEPTH) return result(ERR.DEPTH, gasIn, EMPTY);

    const from = toAddr(m.caller);
    const to = toAddr(m.to);
    const codeAddress = toAddr(m.codeAddress === undefined ? m.to : m.codeAddress);
    const transfers = kind === 'CALL' && m.transfer !== false;

    // The balance check precedes the snapshot and returns the child's gas UNSPENT,
    // which is why a failed value transfer is cheap and a failed execution is not.
    if ((kind === 'CALL' || kind === 'CALLCODE') && value > 0n && state.getBalance(from) < value) {
      return result(ERR.INSUFFICIENT_BALANCE, gasIn, EMPTY);
    }

    const snapshot = state.snapshot();
    const logMark = this.logs.length;

    try {
      const pre = precompileAt(codeAddress);
      const unsupported = !pre && isReservedPrecompile(codeAddress);

      /* EIP-158: a zero-value call to an account that does not exist and is not a
       * precompile touches nothing at all — it must not bring the account into
       * being, or the state root gains an account no other client has. */
      if (transfers && value === 0n && !pre && !unsupported && !state.exists(to)) {
        return result(null, gasIn, EMPTY);
      }
      if (transfers) {
        state.subBalance(from, value);
        state.addBalance(to, value);
      }

      /* Reserved for a fork that warms an address it does not implement. Nothing is
       * in that state today — all nine of Shanghai's precompiles exist — but an
       * address with no code succeeds trivially in the EVM, so anything warmed and
       * unimplemented has to fail LOUDLY rather than look like an empty success. */
      if (unsupported) return this._fail(snapshot, logMark, ERR.UNSUPPORTED_PRECOMPILE, 0n);

      if (pre) {
        const input = toBuf(m.data || EMPTY);
        const need = pre.gas(input);
        if (need > gasIn) return this._fail(snapshot, logMark, ERR.OUT_OF_GAS, 0n);
        const out = pre.run(input);
        /* The two failure conventions, which are opposites — see the top of
         * precompiles.js. 0x01-0x05 report a malformed input as an EMPTY buffer and
         * a SUCCESSFUL call (Solidity's `ecrecover() == address(0)` depends on it).
         * 0x06-0x09 report it as null, and that FAILS the call and burns everything
         * forwarded, because a zk verifier reading "success, no output" as a zero
         * would accept a forged proof. */
        if (out === null) return this._fail(snapshot, logMark, ERR.PRECOMPILE_FAILED, 0n);
        return result(null, gasIn - need, out);
      }

      // `m.code` overrides what the account holds. Used by `eth_call` state
      // overrides, and by VMTests, whose `exec.code` is authoritative.
      const code = m.code === undefined ? state.getCode(codeAddress) : toBuf(m.code);
      if (code.length === 0) return result(null, gasIn, EMPTY);

      const frame = new Frame({
        address: to,
        codeAddress,
        caller: from,
        value: m.callValue === undefined ? value : toBig(m.callValue),
        data: toBuf(m.data || EMPTY),
        gas: gasIn,
        depth,
        isStatic: !!m.isStatic,
      }, code);

      const r = this._interpret(frame);
      if (r.exception) return this._fail(snapshot, logMark, r.exception, r.gasLeft, r.returnData);
      return r;
    } catch (err) {
      return this._crash(snapshot, logMark, err);
    }
  }

  // -- contract creation -----------------------------------------------------

  /**
   * CREATE and CREATE2, and the transaction-level creation.
   *
   * @param {object} m
   * @param {Buffer} m.caller
   * @param {Buffer} m.initcode
   * @param {bigint} m.gas
   * @param {bigint} [m.value=0n]
   * @param {bigint|Buffer} [m.salt]  present iff this is CREATE2
   * @param {number} [m.depth=0]
   */
  create(m) {
    const state = this.state;
    const gasIn = toBig(m.gas);
    const depth = m.depth || 0;
    const value = toBig(m.value);
    const from = toAddr(m.caller);
    const initcode = toBuf(m.initcode || EMPTY);

    if (depth > MAX_DEPTH) return result(ERR.DEPTH, gasIn, EMPTY);
    if (state.getBalance(from) < value) return result(ERR.INSUFFICIENT_BALANCE, gasIn, EMPTY);

    const nonce = state.getNonce(from);
    if (nonce >= MAX_NONCE) return result(ERR.NONCE_OVERFLOW, gasIn, EMPTY);

    let snapshot = state.snapshot();
    const logMark = this.logs.length;

    try {
      // The creator's nonce is bumped BEFORE the address is used and survives a
      // failed creation, which is what makes two CREATEs in one frame differ.
      state.setNonce(from, nonce + 1n);
      const address = m.salt === undefined || m.salt === null
        ? createAddress(from, nonce)
        : create2Address(from, m.salt, initcode);
      state.warmAddress(address);

      /* An occupied address is not a revert-and-carry-on: it consumes every last
       * unit of the child's gas, because the alternative is a cheap probe for
       * whether an address is taken. */
      if (state.getNonce(address) !== 0n || !state.getCodeHash(address).equals(EMPTY_CODE_HASH)) {
        return result(ERR.COLLISION, 0n, EMPTY);
      }

      snapshot = state.snapshot();
      state.createAccount(address);
      state.setNonce(address, 1n);          // EIP-161
      if (value > 0n) { state.subBalance(from, value); state.addBalance(address, value); }

      let r;
      if (initcode.length === 0) {
        r = result(null, gasIn, EMPTY);
      } else {
        r = this._interpret(new Frame({
          address,
          codeAddress: address,
          caller: from,
          value,
          data: EMPTY,
          gas: gasIn,
          depth,
          isStatic: false,
        }, initcode));
      }

      let err = r.exception;
      const out = r.returnData;
      let gasLeft = r.gasLeft;

      if (!err) {
        if (BigInt(out.length) > gas.G.MAX_CODE_SIZE) err = ERR.CODE_TOO_LARGE;            // EIP-170
        else if (out.length >= 1 && out[0] === 0xef) err = ERR.INVALID_CODE;               // EIP-3541
      }
      if (!err) {
        const deposit = gas.codeDepositCost(out.length);
        if (deposit > gasLeft) err = ERR.OUT_OF_GAS;   // EIP-2: a failed deposit fails the creation
        else { gasLeft -= deposit; state.setCode(address, out); }
      }

      if (err) {
        state.revertTo(snapshot);
        this.logs.length = logMark;
        return result(err, err === ERR.REVERT ? gasLeft : 0n, err === ERR.REVERT ? out : EMPTY);
      }
      return result(null, gasLeft, EMPTY, { createdAddress: address });
    } catch (err) {
      return this._crash(snapshot, logMark, err);
    }
  }

  // -- the loop --------------------------------------------------------------

  /**
   * Run one frame to completion. Owns no state snapshot: `call` and `create` took
   * one before they got here and undo it if this returns an exception.
   * @returns {{exception: ?string, gasLeft: bigint, returnData: Buffer}}
   */
  _interpret(f) {
    const st = f.stack;
    const mem = f.memory;
    const state = this.state;
    const code = f.code;
    const jd = analyseJumpdests(code);
    const self = f.msg.address;
    /* Resolved once, outside the loop: an absent tracer costs one truthiness test
     * per step and never allocates an event object. */
    const trace = this.onStep;
    const depth = f.msg.depth;

    for (;;) {
      if (f.pc >= code.length) return result(null, f.gas, EMPTY);   // running off the end is STOP

      const op = code[f.pc];
      const info = OPCODES[op];

      if (!info.defined || info.invalid) {
        if (trace) this._trace(f, op, info, 0n, ERR.INVALID_OPCODE, null);
        return result(ERR.INVALID_OPCODE, f.gas, EMPTY);
      }
      const serr = st.require(info.minStack, info.maxStack);
      if (serr) {
        if (trace) this._trace(f, op, info, 0n, serr, null);
        return result(serr, f.gas, EMPTY);
      }
      // EIP-214. CALL is not blanket-forbidden — only a CALL that moves value is.
      if (f.isStatic && (info.staticForbidden || (info.staticIfValue && st.peek(2) !== 0n))) {
        if (trace) this._trace(f, op, info, 0n, ERR.WRITE_PROTECTION, null);
        return result(ERR.WRITE_PROTECTION, f.gas, EMPTY);
      }

      const px = this._price(f, op, info);
      if (trace) this._trace(f, op, info, px.cost, px.err, px);
      if (px.err) return result(px.err, f.gas, EMPTY);
      if (px.cost > f.gas) return result(ERR.OUT_OF_GAS, f.gas, EMPTY);
      f.gas -= px.cost;
      if (px.mem) mem.expand(px.mem[0], px.mem[1]);
      if (px.mem2) mem.expand(px.mem2[0], px.mem2[1]);

      let next = f.pc + 1 + info.immediate;

      if (op >= 0x60 && op <= 0x7f) {                        // PUSH1..PUSH32
        const n = op - 0x5f;
        let v = 0n;
        for (let i = f.pc + 1, end = f.pc + 1 + n; i < end; i++) v = (v << 8n) | BigInt(i < code.length ? code[i] : 0);
        st.push(v);
      } else if (op >= 0x80 && op <= 0x8f) {                 // DUP1..DUP16
        st.dup(op - 0x7f);
      } else if (op >= 0x90 && op <= 0x9f) {                 // SWAP1..SWAP16
        st.swap(op - 0x8f);
      } else {
        switch (op) {
          case 0x00: return result(null, f.gas, EMPTY);                                   // STOP

          // ---- arithmetic ----------------------------------------------------
          case 0x01: { const a = st.pop(), b = st.pop(); st.push(U.add(a, b)); break; }
          case 0x02: { const a = st.pop(), b = st.pop(); st.push(U.mul(a, b)); break; }
          case 0x03: { const a = st.pop(), b = st.pop(); st.push(U.sub(a, b)); break; }
          case 0x04: { const a = st.pop(), b = st.pop(); st.push(U.div(a, b)); break; }
          case 0x05: { const a = st.pop(), b = st.pop(); st.push(U.sdiv(a, b)); break; }
          case 0x06: { const a = st.pop(), b = st.pop(); st.push(U.mod(a, b)); break; }
          case 0x07: { const a = st.pop(), b = st.pop(); st.push(U.smod(a, b)); break; }
          case 0x08: { const a = st.pop(), b = st.pop(), n = st.pop(); st.push(U.addmod(a, b, n)); break; }
          case 0x09: { const a = st.pop(), b = st.pop(), n = st.pop(); st.push(U.mulmod(a, b, n)); break; }
          case 0x0a: { const a = st.pop(), b = st.pop(); st.push(U.exp(a, b)); break; }
          case 0x0b: { const k = st.pop(), x = st.pop(); st.push(U.signextend(k, x)); break; }

          // ---- comparison and bitwise ----------------------------------------
          case 0x10: { const a = st.pop(), b = st.pop(); st.push(U.lt(a, b)); break; }
          case 0x11: { const a = st.pop(), b = st.pop(); st.push(U.gt(a, b)); break; }
          case 0x12: { const a = st.pop(), b = st.pop(); st.push(U.slt(a, b)); break; }
          case 0x13: { const a = st.pop(), b = st.pop(); st.push(U.sgt(a, b)); break; }
          case 0x14: { const a = st.pop(), b = st.pop(); st.push(U.eq(a, b)); break; }
          case 0x15: st.push(U.iszero(st.pop())); break;
          case 0x16: { const a = st.pop(), b = st.pop(); st.push(U.and(a, b)); break; }
          case 0x17: { const a = st.pop(), b = st.pop(); st.push(U.or(a, b)); break; }
          case 0x18: { const a = st.pop(), b = st.pop(); st.push(U.xor(a, b)); break; }
          case 0x19: st.push(U.not(st.pop())); break;
          case 0x1a: { const i = st.pop(), x = st.pop(); st.push(U.byte(i, x)); break; }
          case 0x1b: { const s = st.pop(), v = st.pop(); st.push(U.shl(s, v)); break; }
          case 0x1c: { const s = st.pop(), v = st.pop(); st.push(U.shr(s, v)); break; }
          case 0x1d: { const s = st.pop(), v = st.pop(); st.push(U.sar(s, v)); break; }

          case 0x20: {                                                                    // KECCAK256
            const off = st.pop(), len = st.pop();
            st.push(U.fromBuffer(keccak256(mem.read(off, len))));
            break;
          }

          // ---- environment ---------------------------------------------------
          case 0x30: st.push(addressToWord(self)); break;
          case 0x31: st.push(state.getBalance(wordToAddress(st.pop()))); break;
          case 0x32: st.push(addressToWord(this.tx.origin)); break;
          case 0x33: st.push(addressToWord(f.msg.caller)); break;
          case 0x34: st.push(f.msg.value); break;
          case 0x35: st.push(U.fromBuffer(getData(f.msg.data, st.pop(), 32n))); break;
          case 0x36: st.push(BigInt(f.msg.data.length)); break;
          case 0x37: {                                                                    // CALLDATACOPY
            const dst = st.pop(), src = st.pop(), len = st.pop();
            mem.write(dst, getData(f.msg.data, src, len));
            break;
          }
          case 0x38: st.push(BigInt(code.length)); break;
          case 0x39: {                                                                    // CODECOPY
            const dst = st.pop(), src = st.pop(), len = st.pop();
            mem.write(dst, getData(code, src, len));
            break;
          }
          case 0x3a: st.push(this.tx.gasPrice); break;
          case 0x3b: st.push(BigInt(state.getCode(wordToAddress(st.pop())).length)); break;
          case 0x3c: {                                                                    // EXTCODECOPY
            const addr = wordToAddress(st.pop()), dst = st.pop(), src = st.pop(), len = st.pop();
            mem.write(dst, getData(state.getCode(addr), src, len));
            break;
          }
          case 0x3d: st.push(BigInt(f.returnData.length)); break;
          case 0x3e: {                                                                    // RETURNDATACOPY
            const dst = st.pop(), src = st.pop(), len = st.pop();
            if (len > 0n) mem.write(dst, f.returnData.subarray(Number(src), Number(src + len)));
            break;
          }
          case 0x3f: {                                                                    // EXTCODEHASH
            // EIP-1052: an account that does not exist, or is EIP-161-empty, hashes
            // to zero rather than to keccak256("").
            const addr = wordToAddress(st.pop());
            st.push(state.empty(addr) ? 0n : U.fromBuffer(state.getCodeHash(addr)));
            break;
          }

          // ---- block context -------------------------------------------------
          case 0x40: {                                                                    // BLOCKHASH
            const n = st.pop();
            const cur = this.block.number;
            let h = null;
            if (n < cur && n + 256n >= cur) h = this.blockHashFn(n);
            st.push(h ? U.fromBuffer(toBuf(h, 32)) : 0n);
            break;
          }
          case 0x41: st.push(addressToWord(this.block.coinbase)); break;
          case 0x42: st.push(this.block.timestamp); break;
          case 0x43: st.push(this.block.number); break;
          case 0x44: st.push(this.block.prevRandao); break;
          case 0x45: st.push(this.block.gasLimit); break;
          case 0x46: st.push(this.block.chainId); break;
          case 0x47: st.push(state.getBalance(self)); break;
          case 0x48: st.push(this.block.baseFee); break;

          // ---- stack, memory, storage, flow ----------------------------------
          case 0x50: st.pop(); break;
          case 0x51: st.push(U.fromBuffer(mem.readWord(st.pop()))); break;
          case 0x52: { const off = st.pop(), v = st.pop(); mem.write(off, U.toBuffer(v)); break; }
          case 0x53: { const off = st.pop(), v = st.pop(); mem.writeByte(off, v & 0xffn); break; }
          case 0x54: st.pop(); st.push(U.fromBuffer(state.getStorage(self, px.slot))); break;
          case 0x55: {                                                                    // SSTORE
            st.pop(); const v = st.pop();
            state.setStorage(self, px.slot, U.toBuffer(v));
            if (px.refund > 0n) state.addRefund(px.refund);
            else if (px.refund < 0n) state.subRefund(-px.refund);
            break;
          }
          case 0x56: {                                                                    // JUMP
            const d = st.pop();
            if (d >= BigInt(code.length) || jd[Number(d)] !== 1) return result(ERR.INVALID_JUMP, f.gas, EMPTY);
            next = Number(d);
            break;
          }
          case 0x57: {                                                                    // JUMPI
            const d = st.pop(), cond = st.pop();
            if (cond !== 0n) {
              if (d >= BigInt(code.length) || jd[Number(d)] !== 1) return result(ERR.INVALID_JUMP, f.gas, EMPTY);
              next = Number(d);
            }
            break;
          }
          case 0x58: st.push(BigInt(f.pc)); break;
          case 0x59: st.push(BigInt(mem.size)); break;
          case 0x5a: st.push(f.gas); break;
          case 0x5b: break;                                                               // JUMPDEST
          case 0x5f: st.push(0n); break;                                                  // PUSH0

          // ---- logs ------------------------------------------------------------
          case 0xa0: case 0xa1: case 0xa2: case 0xa3: case 0xa4: {
            const off = st.pop(), len = st.pop();
            const topics = [];
            for (let k = 0, n = op - 0xa0; k < n; k++) topics.push(U.toBuffer(st.pop()));
            this.logs.push({ address: Buffer.from(self), topics, data: mem.read(off, len) });
            break;
          }

          // ---- system ----------------------------------------------------------
          case 0xf0: case 0xf5: {                                                         // CREATE, CREATE2
            const value = st.pop(), off = st.pop(), len = st.pop();
            const salt = op === 0xf5 ? st.pop() : undefined;
            const initcode = mem.read(off, len);
            // EIP-150 again: the child gets all but one 64th of what is left after
            // the base, initcode-word and memory charges above.
            const childGas = gas.allButOne64th(f.gas);
            f.gas -= childGas;
            const r = this.create({
              caller: self, initcode, gas: childGas, value, salt, depth: depth + 1,
            });
            if (r.internalError) throw r.internalError;
            f.gas += r.gasLeft;
            f.returnData = r.exception === ERR.REVERT ? r.returnData : EMPTY;
            st.push(r.exception ? 0n : addressToWord(r.createdAddress));
            break;
          }

          case 0xf1: case 0xf2: case 0xf4: case 0xfa: {                                   // the CALL family
            const c = px.call;
            for (let k = 0; k < info.pops; k++) st.pop();
            const input = mem.read(c.inOff, c.inLen);
            const common = { data: input, gas: c.childGas, depth: depth + 1 };
            let r;
            if (c.kind === 'CALL') {
              r = this.call({ ...common, kind: 'CALL', caller: self, to: c.to, value: c.value, isStatic: f.isStatic });
            } else if (c.kind === 'CALLCODE') {
              // Executes `to`'s code against OUR storage and balance, so the value
              // moves from this account to itself: checked, never transferred.
              r = this.call({ ...common, kind: 'CALLCODE', caller: self, to: self, codeAddress: c.to, value: c.value, isStatic: f.isStatic });
            } else if (c.kind === 'DELEGATECALL') {
              // Keeps BOTH the original sender and the original value: a delegate
              // frame is indistinguishable from its parent to the code it runs.
              r = this.call({
                ...common, kind: 'DELEGATECALL', caller: f.msg.caller, to: self, codeAddress: c.to,
                value: 0n, callValue: f.msg.value, isStatic: f.isStatic,
              });
            } else {
              r = this.call({ ...common, kind: 'STATICCALL', caller: self, to: c.to, value: 0n, isStatic: true });
            }
            if (r.internalError) throw r.internalError;

            f.gas += r.gasLeft;
            if (!r.exception || r.exception === ERR.REVERT) {
              f.returnData = r.returnData;
              // The return area is written up to the SHORTER of the two lengths and
              // the rest is left alone — it is not zero-filled.
              const n = c.outLen < BigInt(r.returnData.length) ? Number(c.outLen) : r.returnData.length;
              if (n > 0) mem.write(c.outOff, r.returnData.subarray(0, n));
            } else {
              f.returnData = EMPTY;
            }
            st.push(r.exception ? 0n : 1n);
            break;
          }

          case 0xf3: { const off = st.pop(), len = st.pop(); return result(null, f.gas, mem.read(off, len)); }
          case 0xfd: { const off = st.pop(), len = st.pop(); return result(ERR.REVERT, f.gas, mem.read(off, len)); }

          case 0xff: {                                                                    // SELFDESTRUCT
            // Shanghai, pre-EIP-6780: the balance moves now, the account disappears
            // at the end of the transaction. StateDB owns both halves.
            const benef = wordToAddress(st.pop());
            if (!state.selfDestruct(self, benef)) state.addBalance(benef, 0n);
            return result(null, f.gas, EMPTY);
          }

          default:
            // Unreachable: `info.defined` covers every byte the table does not assign.
            return result(ERR.INVALID_OPCODE, f.gas, EMPTY);
        }
      }

      /* The min/max check above proves every access in the instruction was in range,
       * so a fault here means this file and opcodes.js disagree — a bug, not an EVM
       * outcome, and it must not be quietly reported as a rejected transaction. */
      if (st.fault) throw new Error('interpreter: ' + st.fault + ' at ' + info.name + ' — stack bounds are out of step with opcodes.js');

      f.pc = next;
    }
  }

  /** The debugger's feed. `hearth trace <txhash>` is built directly on this. */
  _trace(f, op, info, cost, error, px) {
    const ev = {
      pc: f.pc,
      op,
      opcode: op,
      mnemonic: info.name,
      gasLeft: f.gas,
      gasCost: cost,
      depth: f.msg.depth,
      stack: f.stack.snapshot(),
      memorySize: f.memory.size,
      address: f.msg.address,
      static: f.isStatic,
      error: error || null,
    };
    if (px && px.slot) {
      ev.slot = px.slot;
      // SSTORE reports what is being written, SLOAD what is about to be read.
      ev.value = op === 0x55 ? U.toBuffer(f.stack.peek(1)) : this.state.getStorage(f.msg.address, px.slot);
      ev.refund = px.refund;
    }
    this.onStep(ev);
  }

  // -- pricing ---------------------------------------------------------------

  /**
   * The whole cost of one instruction, plus whatever the execute switch would
   * otherwise have to recompute. Nothing here mutates the frame; the two things it
   * does mutate are the EIP-2929 warm sets, which are journaled and so are undone
   * with the rest of the frame if it goes on to fail.
   *
   * @returns {{cost: bigint, err: ?string, mem: ?Array, mem2: ?Array, call: ?object,
   *            refund: bigint, slot: ?Buffer}}
   */
  _price(f, op, info) {
    const st = f.stack;
    const state = this.state;
    const px = { cost: gas.baseGas(op), err: null, mem: null, mem2: null, call: null, refund: 0n, slot: null };

    switch (op) {
      case 0x0a:                                            // EXP
        px.cost += gas.expCost(st.peek(1));
        break;

      case 0x20: {                                          // KECCAK256
        const off = st.peek(0), len = st.peek(1);
        px.cost += gas.keccak256WordsCost(len) + f.memory.charge(off, len);
        px.mem = [off, len];
        break;
      }

      case 0x31: case 0x3b: case 0x3f:                      // BALANCE, EXTCODESIZE, EXTCODEHASH
        px.cost += gas.accountAccessCost(state.warmAddress(wordToAddress(st.peek(0))));
        break;

      case 0x37: case 0x39: case 0x3e: {                    // CALLDATACOPY, CODECOPY, RETURNDATACOPY
        const dst = st.peek(0), src = st.peek(1), len = st.peek(2);
        if (op === 0x3e) {
          // EIP-211: RETURNDATACOPY reads are exact, never zero-padded, so an
          // out-of-range read is an exceptional halt and not a buffer of zeros.
          if (src + len > BigInt(f.returnData.length)) { px.err = ERR.RETURNDATA_OUT_OF_BOUNDS; break; }
        }
        px.cost += gas.copyWordsCost(len) + f.memory.charge(dst, len);
        px.mem = [dst, len];
        break;
      }

      case 0x3c: {                                          // EXTCODECOPY
        const cold = state.warmAddress(wordToAddress(st.peek(0)));
        const dst = st.peek(1), len = st.peek(3);
        px.cost += gas.extcodecopyCost(cold, len) + f.memory.charge(dst, len);
        px.mem = [dst, len];
        break;
      }

      case 0x51: case 0x52:                                 // MLOAD, MSTORE
        px.cost += f.memory.charge(st.peek(0), 32n);
        px.mem = [st.peek(0), 32n];
        break;

      case 0x53:                                            // MSTORE8
        px.cost += f.memory.charge(st.peek(0), 1n);
        px.mem = [st.peek(0), 1n];
        break;

      case 0x54: {                                          // SLOAD
        px.slot = toBuf(st.peek(0), 32);
        px.cost += gas.sloadCost(state.warmSlot(f.msg.address, px.slot));
        break;
      }

      case 0x55: {                                          // SSTORE
        px.slot = toBuf(st.peek(0), 32);
        const value = st.peek(1);
        /* The EIP-2200 sentry is checked against the gas left BEFORE this
         * instruction, and tripping it is an ordinary out-of-gas halt — reading
         * `cost: 0` as "free, carry on" would let a 2300-gas transfer() callback
         * reach storage, which is the whole attack the guard exists to stop. */
        const cold = state.warmSlot(f.msg.address, px.slot);
        const r = gas.sstoreCost({
          cold,
          original: U.fromBuffer(state.originalStorage(f.msg.address, px.slot)),
          current: U.fromBuffer(state.getStorage(f.msg.address, px.slot)),
          value,
          gasRemaining: f.gas,
        });
        if (r.sentry) { px.err = ERR.OUT_OF_GAS; break; }
        px.cost += r.cost;
        px.refund = r.refund;
        break;
      }

      case 0xa0: case 0xa1: case 0xa2: case 0xa3: case 0xa4: {   // LOG0..LOG4
        const off = st.peek(0), len = st.peek(1);
        px.cost += gas.logCost(op - 0xa0, len) + f.memory.charge(off, len);
        px.mem = [off, len];
        break;
      }

      case 0xf0: case 0xf5: {                               // CREATE, CREATE2
        const off = st.peek(1), len = st.peek(2);
        // EIP-3860's cap is enforced at pricing time, so exceeding it is an
        // exceptional halt that consumes all gas rather than a failed CREATE.
        if (gas.initcodeTooLarge(len)) { px.err = ERR.INITCODE_TOO_LARGE; break; }
        px.cost += (op === 0xf0 ? gas.createCost(len) : gas.create2Cost(len)) + f.memory.charge(off, len);
        px.mem = [off, len];
        break;
      }

      case 0xf1: case 0xf2: case 0xf4: case 0xfa: {         // the CALL family
        const kind = op === 0xf1 ? 'CALL' : op === 0xf2 ? 'CALLCODE' : op === 0xf4 ? 'DELEGATECALL' : 'STATICCALL';
        const hasValue = op === 0xf1 || op === 0xf2;
        const requestedGas = st.peek(0);
        const to = wordToAddress(st.peek(1));
        const value = hasValue ? st.peek(2) : 0n;
        const i = hasValue ? 3 : 2;
        const inOff = st.peek(i), inLen = st.peek(i + 1), outOff = st.peek(i + 2), outLen = st.peek(i + 3);

        const memoryCost = f.memory.charge2(inOff, inLen, outOff, outLen);
        const cold = state.warmAddress(to);
        /* callCost takes the memory cost because the order matters: EIP-150's
         * all-but-one-64th cap is computed on what remains AFTER access, value,
         * new-account and memory charges. Cap first and every deep call tree
         * diverges. */
        const c = gas.callCost({
          kind, cold, value,
          targetEmpty: state.empty(to),
          memoryCost,
          gasRemaining: f.gas,
          requestedGas,
        });
        px.cost += c.cost;
        px.mem = [inOff, inLen];
        px.mem2 = [outOff, outLen];
        px.call = { kind, to, value, inOff, inLen, outOff, outLen, childGas: c.childGas, outOfGas: c.outOfGas };
        break;
      }

      case 0xf3: case 0xfd: {                               // RETURN, REVERT
        const off = st.peek(0), len = st.peek(1);
        px.cost += f.memory.charge(off, len);
        px.mem = [off, len];
        break;
      }

      case 0xff: {                                          // SELFDESTRUCT
        const benef = wordToAddress(st.peek(0));
        const beneficiaryEmpty = state.empty(benef);
        px.cost += gas.selfdestructCost({
          cold: state.warmAddress(benef),
          beneficiaryEmpty,
          balance: state.getBalance(f.msg.address),
        });
        break;
      }

      default:
        break;                                              // fixed-tier only
    }
    return px;
  }

  // -- shared frame teardown -------------------------------------------------

  /** Roll a failed frame back. Everything but REVERT also forfeits its gas. */
  _fail(snapshot, logMark, exception, gasLeft, output) {
    this.state.revertTo(snapshot);
    this.logs.length = logMark;
    const revert = exception === ERR.REVERT;
    return result(exception, revert ? gasLeft : 0n, revert ? output : EMPTY);
  }

  /* A JavaScript error escaping a frame is a bug in this file, not an EVM outcome.
   * It is still returned rather than thrown — the harness contract is absolute — but
   * `internalError` is attached so a test runner can report it as an ERROR instead of
   * crediting it as a correctly-rejected transaction. */
  _crash(snapshot, logMark, err) {
    this.state.revertTo(snapshot);
    this.logs.length = logMark;
    return result('internal error: ' + err.message, 0n, EMPTY, { internalError: err });
  }
}

/* Addresses EIP-2929 warms that this chain does not implement. EMPTY today: 0x01-0x09
 * are all real now that bn128 and blake2f have landed, and 0x0a upwards are ordinary
 * accounts under Shanghai. The mechanism stays because "warmed" and "implemented" are
 * separate facts a fork can pull apart again — and when one does, the gap must fail
 * LOUDLY, since an address with no code succeeds trivially in the EVM. */
const RESERVED_PRECOMPILES = new Set();

function isReservedPrecompile(addr) {
  for (let i = 0; i < 19; i++) if (addr[i] !== 0) return false;
  return RESERVED_PRECOMPILES.has(addr[19]);
}

module.exports = {
  EVM,
  ERR,
  MAX_DEPTH,
  MAX_NONCE,
  Frame,
  Stack,
  Memory,
  createAddress,
  create2Address,
  analyseJumpdests,
  logsHash,
  wordToAddress,
  addressToWord,
};
