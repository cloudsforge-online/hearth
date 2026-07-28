/* An EVM disassembler for the contract view.
 *
 * The mnemonic table is a transcription of node/src/evm/opcodes.js — same fork
 * (Shanghai), same names, same PUSH immediate widths, and the same treatment of
 * unassigned bytes as invalid rather than as no-ops. That file is the authority
 * and is not modified by anything here; selftest.js cross-checks the two so the
 * copy cannot drift silently.
 *
 * Shanghai, restated because it is the part that dates: PUSH0 exists at 0x5f
 * (EIP-3855), and the Cancun additions — TLOAD 0x5c, TSTORE 0x5d, MCOPY 0x5e,
 * BLOBHASH 0x49, BLOBBASEFEE 0x4a — are deliberately absent.
 */

import { toBytes, toHex } from './format.js';
import { selectorOf } from './abi.js';

const NAMES = new Array(256).fill(null);
const def = (op, name) => { NAMES[op] = name; };

def(0x00, 'STOP'); def(0x01, 'ADD'); def(0x02, 'MUL'); def(0x03, 'SUB'); def(0x04, 'DIV');
def(0x05, 'SDIV'); def(0x06, 'MOD'); def(0x07, 'SMOD'); def(0x08, 'ADDMOD'); def(0x09, 'MULMOD');
def(0x0a, 'EXP'); def(0x0b, 'SIGNEXTEND');
def(0x10, 'LT'); def(0x11, 'GT'); def(0x12, 'SLT'); def(0x13, 'SGT'); def(0x14, 'EQ');
def(0x15, 'ISZERO'); def(0x16, 'AND'); def(0x17, 'OR'); def(0x18, 'XOR'); def(0x19, 'NOT');
def(0x1a, 'BYTE'); def(0x1b, 'SHL'); def(0x1c, 'SHR'); def(0x1d, 'SAR');
def(0x20, 'KECCAK256');
def(0x30, 'ADDRESS'); def(0x31, 'BALANCE'); def(0x32, 'ORIGIN'); def(0x33, 'CALLER');
def(0x34, 'CALLVALUE'); def(0x35, 'CALLDATALOAD'); def(0x36, 'CALLDATASIZE'); def(0x37, 'CALLDATACOPY');
def(0x38, 'CODESIZE'); def(0x39, 'CODECOPY'); def(0x3a, 'GASPRICE'); def(0x3b, 'EXTCODESIZE');
def(0x3c, 'EXTCODECOPY'); def(0x3d, 'RETURNDATASIZE'); def(0x3e, 'RETURNDATACOPY'); def(0x3f, 'EXTCODEHASH');
def(0x40, 'BLOCKHASH'); def(0x41, 'COINBASE'); def(0x42, 'TIMESTAMP'); def(0x43, 'NUMBER');
// 0x44 is PREVRANDAO under Shanghai. On Hearth it returns the parent block's
// Homefire digest (docs/evm-spec.md §5) — miner-influenceable, and not to be
// used as randomness for anything an adversarial miner would profit from biasing.
def(0x44, 'PREVRANDAO'); def(0x45, 'GASLIMIT'); def(0x46, 'CHAINID'); def(0x47, 'SELFBALANCE');
def(0x48, 'BASEFEE');
def(0x50, 'POP'); def(0x51, 'MLOAD'); def(0x52, 'MSTORE'); def(0x53, 'MSTORE8');
def(0x54, 'SLOAD'); def(0x55, 'SSTORE'); def(0x56, 'JUMP'); def(0x57, 'JUMPI');
def(0x58, 'PC'); def(0x59, 'MSIZE'); def(0x5a, 'GAS'); def(0x5b, 'JUMPDEST');
def(0x5f, 'PUSH0');
for (let n = 1; n <= 32; n++) def(0x5f + n, 'PUSH' + n);
for (let n = 1; n <= 16; n++) def(0x7f + n, 'DUP' + n);
for (let n = 1; n <= 16; n++) def(0x8f + n, 'SWAP' + n);
for (let n = 0; n <= 4; n++) def(0xa0 + n, 'LOG' + n);
def(0xf0, 'CREATE'); def(0xf1, 'CALL'); def(0xf2, 'CALLCODE'); def(0xf3, 'RETURN');
def(0xf4, 'DELEGATECALL'); def(0xf5, 'CREATE2'); def(0xfa, 'STATICCALL'); def(0xfd, 'REVERT');
def(0xfe, 'INVALID'); def(0xff, 'SELFDESTRUCT');

/** Mnemonic for a byte; unassigned bytes get opcodes.js's UNDEFINED_xx spelling. */
export function nameOf(op) {
  return NAMES[op] || 'UNDEFINED_' + op.toString(16).padStart(2, '0');
}
export const isDefined = op => NAMES[op] !== null;
export const isPush = op => op >= 0x60 && op <= 0x7f;
export const pushBytes = op => (isPush(op) ? op - 0x5f : 0);
const TERMINATES = new Set([0x00, 0xf3, 0xfd, 0xfe, 0xff]);

/**
 * Linear-sweep disassembly.
 *
 * PUSH immediates are consumed as data, which is the entire reason a raw hex
 * dump is not good enough: a `0x5b` sitting inside PUSH data is NOT a jump
 * destination, and reading it as one is how a naive disassembler invents control
 * flow that the EVM does not have. `jumpdests` below is the set the interpreter
 * would actually accept.
 */
export function disassemble(code) {
  const b = toBytes(code);
  const ops = [];
  const jumpdests = new Set();
  let truncated = false;
  for (let pc = 0; pc < b.length;) {
    const op = b[pc];
    const n = pushBytes(op);
    const entry = { pc, op, name: nameOf(op), defined: isDefined(op), immediate: null, size: 1 + n };
    if (n > 0) {
      if (pc + 1 + n > b.length) {
        // Trailing PUSH data past the end of the code: real, and it happens with
        // metadata-appended bytecode cut short. Show what is there and say so.
        entry.immediate = toHex(b.slice(pc + 1));
        entry.truncated = true;
        truncated = true;
      } else {
        entry.immediate = toHex(b.slice(pc + 1, pc + 1 + n));
      }
    }
    if (op === 0x5b) jumpdests.add(pc);
    ops.push(entry);
    pc += 1 + n;
  }
  return { ops, jumpdests, truncated, size: b.length };
}

/**
 * The 4-byte selectors a contract compares calldata against, read out of its own
 * dispatcher. With no verified sources on this chain (docs/listing-checklist.md
 * §3) this is the closest thing to an ABI a reader can get, and it is honest: it
 * says what the code contains, not what someone claims it does.
 *
 * The heuristic is deliberately narrow — PUSH4 immediately followed by EQ, GT or
 * LT, which is what solc's linear and binary-search dispatchers both emit. Wider
 * matching would collect constants that are not selectors at all.
 */
export function extractSelectors(code) {
  const { ops } = disassemble(code);
  const found = [];
  const seen = new Set();
  for (let i = 0; i < ops.length; i++) {
    if (ops[i].op !== 0x63) continue;                       // PUSH4
    const next = ops[i + 1];
    if (!next || ![0x14, 0x11, 0x10].includes(next.op)) continue;  // EQ / GT / LT
    const sel = ops[i].immediate;
    if (sel && !seen.has(sel)) { seen.add(sel); found.push(sel); }
  }
  return found;
}

/** Signatures common enough to be worth naming when their selector turns up. */
const KNOWN_FUNCTIONS = [
  'name()', 'symbol()', 'decimals()', 'totalSupply()', 'balanceOf(address)',
  'transfer(address,uint256)', 'transferFrom(address,address,uint256)',
  'approve(address,uint256)', 'allowance(address,address)',
  'owner()', 'transferOwnership(address)', 'renounceOwnership()',
  'mint(address,uint256)', 'burn(uint256)', 'deposit()', 'withdraw(uint256)',
  'ownerOf(uint256)', 'tokenURI(uint256)', 'safeTransferFrom(address,address,uint256)',
  'setApprovalForAll(address,bool)', 'isApprovedForAll(address,address)',
  'supportsInterface(bytes4)', 'permit(address,address,uint256,uint256,uint8,bytes32,bytes32)',
  'DOMAIN_SEPARATOR()', 'nonces(address)',
  'getReserves()', 'token0()', 'token1()', 'factory()', 'pairCodeHash()',
  'swap(uint256,uint256,address,bytes)', 'sync()', 'skim(address)',
  'getPair(address,address)', 'createPair(address,address)', 'allPairsLength()',
  'WETH()', 'quote(uint256,uint256,uint256)',
  'swapExactTokensForTokens(uint256,uint256,address[],address,uint256)',
  'addLiquidity(address,address,uint256,uint256,uint256,uint256,address,uint256)',
  'aggregate3((address,bool,bytes)[])', 'getEthBalance(address)',
];

export const SELECTOR_NAMES = new Map(KNOWN_FUNCTIONS.map(sig => [selectorOf(sig), sig]));

/** A guess at what a contract is, from the selectors in its dispatcher. */
export function classifyCode(code) {
  const sels = new Set(extractSelectors(code).map(s => SELECTOR_NAMES.get(s)).filter(Boolean));
  const has = (...names) => names.every(n => sels.has(n));
  if (has('balanceOf(address)', 'ownerOf(uint256)')) return 'looks like ERC-721';
  if (has('balanceOf(address)', 'transfer(address,uint256)', 'totalSupply()')) return 'looks like ERC-20';
  if (has('getReserves()', 'token0()', 'token1()')) return 'looks like a Uniswap V2 pair';
  if (has('createPair(address,address)')) return 'looks like a Uniswap V2 factory';
  return null;
}
