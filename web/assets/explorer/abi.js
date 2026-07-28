/* Just enough ABI to decode what an explorer actually shows.
 *
 * There is no ABI registry on this chain and no verified sources (see
 * docs/listing-checklist.md §3 — "Verified contract sources ⬜"), so the only
 * events that can be decoded are the ones whose signature is known in advance.
 * That is a short list and it covers most of what anyone looks at: ERC-20,
 * ERC-721, WETH and Uniswap V2, which is exactly the DeFi layer docs/evm-spec.md
 * §7 deploys.
 *
 * An unknown event is rendered raw, clearly labelled as undecoded. It is never
 * guessed at: showing a plausible but wrong argument list is worse than showing
 * bytes, because someone will trade on it.
 */

import { keccak256Hex, utf8 } from './keccak.js';
import { toBig, toBytes, toHex, addressFromTopic, toChecksumAddress, formatUnits, ZERO_ADDRESS } from './format.js';

/** topic0 = keccak256(the canonical signature text). */
export const topicOf = sig => keccak256Hex(utf8(sig));
/** The 4-byte selector of a function signature. */
export const selectorOf = sig => keccak256Hex(utf8(sig)).slice(0, 10);

/** The ERC-20 Transfer topic. Detecting tokens is entirely this constant. */
export const TRANSFER_TOPIC = topicOf('Transfer(address,address,uint256)');
export const APPROVAL_TOPIC = topicOf('Approval(address,address,uint256)');

/**
 * Known events. `indexed` marks arguments that live in topics rather than data;
 * decoding depends on getting that split right, which is why it is declared
 * rather than inferred.
 */
const EVENT_LIST = [
  { sig: 'Transfer(address,address,uint256)', name: 'Transfer',
    inputs: [{ name: 'from', type: 'address', indexed: true },
      { name: 'to', type: 'address', indexed: true },
      { name: 'value', type: 'uint256', indexed: false }] },
  // ERC-721 shares the Transfer signature and differs only in that tokenId is
  // indexed, so the log has four topics and no data. Same topic0, different
  // shape: decodeLog picks by topic count.
  { sig: 'Transfer(address,address,uint256)', name: 'Transfer', erc721: true,
    inputs: [{ name: 'from', type: 'address', indexed: true },
      { name: 'to', type: 'address', indexed: true },
      { name: 'tokenId', type: 'uint256', indexed: true }] },
  { sig: 'Approval(address,address,uint256)', name: 'Approval',
    inputs: [{ name: 'owner', type: 'address', indexed: true },
      { name: 'spender', type: 'address', indexed: true },
      { name: 'value', type: 'uint256', indexed: false }] },
  { sig: 'ApprovalForAll(address,address,bool)', name: 'ApprovalForAll',
    inputs: [{ name: 'owner', type: 'address', indexed: true },
      { name: 'operator', type: 'address', indexed: true },
      { name: 'approved', type: 'bool', indexed: false }] },
  { sig: 'Deposit(address,uint256)', name: 'Deposit',
    inputs: [{ name: 'dst', type: 'address', indexed: true },
      { name: 'wad', type: 'uint256', indexed: false }] },
  { sig: 'Withdrawal(address,uint256)', name: 'Withdrawal',
    inputs: [{ name: 'src', type: 'address', indexed: true },
      { name: 'wad', type: 'uint256', indexed: false }] },
  { sig: 'Swap(address,uint256,uint256,uint256,uint256,address)', name: 'Swap',
    inputs: [{ name: 'sender', type: 'address', indexed: true },
      { name: 'amount0In', type: 'uint256', indexed: false },
      { name: 'amount1In', type: 'uint256', indexed: false },
      { name: 'amount0Out', type: 'uint256', indexed: false },
      { name: 'amount1Out', type: 'uint256', indexed: false },
      { name: 'to', type: 'address', indexed: true }] },
  { sig: 'Sync(uint112,uint112)', name: 'Sync',
    inputs: [{ name: 'reserve0', type: 'uint112', indexed: false },
      { name: 'reserve1', type: 'uint112', indexed: false }] },
  { sig: 'Mint(address,uint256,uint256)', name: 'Mint',
    inputs: [{ name: 'sender', type: 'address', indexed: true },
      { name: 'amount0', type: 'uint256', indexed: false },
      { name: 'amount1', type: 'uint256', indexed: false }] },
  { sig: 'Burn(address,uint256,uint256,address)', name: 'Burn',
    inputs: [{ name: 'sender', type: 'address', indexed: true },
      { name: 'amount0', type: 'uint256', indexed: false },
      { name: 'amount1', type: 'uint256', indexed: false },
      { name: 'to', type: 'address', indexed: true }] },
  { sig: 'PairCreated(address,address,address,uint256)', name: 'PairCreated',
    inputs: [{ name: 'token0', type: 'address', indexed: true },
      { name: 'token1', type: 'address', indexed: true },
      { name: 'pair', type: 'address', indexed: false },
      { name: 'index', type: 'uint256', indexed: false }] },
  { sig: 'OwnershipTransferred(address,address)', name: 'OwnershipTransferred',
    inputs: [{ name: 'previousOwner', type: 'address', indexed: true },
      { name: 'newOwner', type: 'address', indexed: true }] },
];

/** topic0 → the candidate signatures that hash to it. */
export const EVENTS = new Map();
for (const e of EVENT_LIST) {
  e.topic0 = topicOf(e.sig);
  e.topicCount = 1 + e.inputs.filter(i => i.indexed).length;
  const bucket = EVENTS.get(e.topic0) || [];
  bucket.push(e);
  EVENTS.set(e.topic0, bucket);
}

/** Every signature this page knows, for the search box's datalist. */
export const KNOWN_SIGNATURES = [...new Set(EVENT_LIST.map(e => e.sig))];

function word(bytes, i) { return bytes.slice(i * 32, i * 32 + 32); }

function decodeValue(type, raw, isTopic) {
  const hex = typeof raw === 'string' ? raw : toHex(raw);
  if (type === 'address') return addressFromTopic(hex);
  if (type === 'bool') return toBig(hex) !== 0n ? 'true' : 'false';
  if (/^u?int/.test(type)) return toBig(hex);
  if (type === 'bytes32') return hex;
  return isTopic ? hex + ' (hashed — indexed dynamic argument)' : hex;
}

/**
 * Decode one log against the known-signature table.
 * Returns { name, sig, args:[{name,type,value,indexed}] } or null when the
 * signature is unknown or the log does not fit the shape it claims.
 */
export function decodeLog(log) {
  const topics = log.topics || [];
  if (!topics.length) return null;
  const candidates = EVENTS.get(String(topics[0]).toLowerCase());
  if (!candidates) return null;
  const def = candidates.find(c => c.topicCount === topics.length);
  if (!def) return null;
  const data = toBytes(log.data || '0x');
  const args = [];
  let ti = 1, di = 0;
  for (const input of def.inputs) {
    let value;
    if (input.indexed) {
      value = decodeValue(input.type, topics[ti++], true);
    } else {
      if ((di + 1) * 32 > data.length) return null;   // truncated: refuse to guess
      value = decodeValue(input.type, toHex(word(data, di++)), false);
    }
    args.push({ name: input.name, type: input.type, value, indexed: !!input.indexed });
  }
  return { name: def.name, sig: def.sig, erc721: !!def.erc721, args };
}

/**
 * An ERC-20 Transfer, as a token movement — or null if this log is not one.
 * A four-topic Transfer is ERC-721 and deliberately excluded: an NFT id is not
 * an amount, and summing it would produce a nonsense balance.
 */
export function asTokenTransfer(log) {
  if (String((log.topics || [])[0]).toLowerCase() !== TRANSFER_TOPIC) return null;
  if ((log.topics || []).length !== 3) return null;
  const data = toBytes(log.data || '0x');
  if (data.length < 32) return null;
  return {
    token: toChecksumAddress(log.address),
    from: addressFromTopic(log.topics[1]),
    to: addressFromTopic(log.topics[2]),
    value: toBig(toHex(word(data, 0))),
    mint: addressFromTopic(log.topics[1]) === ZERO_ADDRESS,
    burn: addressFromTopic(log.topics[2]) === ZERO_ADDRESS,
    log,
  };
}

// ---- reading a token's metadata -------------------------------------------

export const SELECTORS = {
  name: selectorOf('name()'),
  symbol: selectorOf('symbol()'),
  decimals: selectorOf('decimals()'),
  totalSupply: selectorOf('totalSupply()'),
  balanceOf: selectorOf('balanceOf(address)'),
};

/** calldata for `balanceOf(address)`. */
export function balanceOfCalldata(addr) {
  return SELECTORS.balanceOf + String(addr).replace(/^0x/, '').toLowerCase().padStart(64, '0');
}

/**
 * Decode an ABI-encoded `string` return. Falls back to a bytes32 reading,
 * because a handful of very early tokens (MKR is the famous one) return
 * `bytes32` from name() and symbol(), and a strict decoder shows them blank.
 */
export function decodeString(returnData) {
  const b = toBytes(returnData || '0x');
  if (b.length === 0) return null;
  if (b.length >= 64) {
    const offset = Number(toBig(toHex(word(b, 0))));
    if (Number.isSafeInteger(offset) && offset + 32 <= b.length) {
      const len = Number(toBig(toHex(b.slice(offset, offset + 32))));
      if (Number.isSafeInteger(len) && offset + 32 + len <= b.length) {
        return new TextDecoder().decode(b.slice(offset + 32, offset + 32 + len));
      }
    }
  }
  if (b.length === 32) {
    const trimmed = b.slice(0, b.findIndex(x => x === 0) === -1 ? 32 : b.findIndex(x => x === 0));
    const s = new TextDecoder().decode(trimmed);
    return /^[\x20-\x7e]*$/.test(s) && s.length ? s : null;
  }
  return null;
}

export function decodeUint(returnData) {
  const b = toBytes(returnData || '0x');
  if (b.length < 32) return null;
  return toBig(toHex(word(b, 0)));
}

// ---- revert reasons --------------------------------------------------------

const ERROR_STRING_SELECTOR = '0x08c379a0';
const PANIC_SELECTOR = '0x4e487b71';

/** Solidity's Panic(uint256) codes, which are otherwise an opaque number. */
const PANIC_CODES = {
  0x00: 'generic compiler panic',
  0x01: 'assert(false)',
  0x11: 'arithmetic overflow or underflow',
  0x12: 'division or modulo by zero',
  0x21: 'invalid enum conversion',
  0x22: 'malformed storage byte array',
  0x31: 'pop() on an empty array',
  0x32: 'array index out of bounds',
  0x41: 'out of memory',
  0x51: 'call to an uninitialised internal function',
};

/**
 * Turn revert output into something a human can read. Mirrors
 * node/src/jsonrpc/methods.js `decodeRevertReason` and extends it with Panic,
 * which is common enough that "0x4e487b71…11" on screen is a wasted line.
 * A custom error stays raw with its selector shown — that is genuinely all that
 * can be said without the ABI.
 */
export function decodeRevert(data) {
  const b = toBytes(data || '0x');
  if (b.length === 0) return { kind: 'empty', text: 'reverted with no reason string' };
  const sel = toHex(b.slice(0, 4));
  if (sel === ERROR_STRING_SELECTOR && b.length >= 4 + 64) {
    const s = decodeString(toHex(b.slice(4)));
    if (s !== null) return { kind: 'Error', text: s };
  }
  if (sel === PANIC_SELECTOR && b.length >= 4 + 32) {
    const code = Number(toBig(toHex(b.slice(4, 36))));
    return { kind: 'Panic', code, text: `Panic(0x${code.toString(16)}) — ${PANIC_CODES[code] || 'unknown panic code'}` };
  }
  return { kind: 'custom', selector: sel, text: 'custom error ' + sel + ' — needs the contract ABI to decode' };
}

/** Amount + symbol, when the token's decimals are known; raw units when not. */
export function formatTokenAmount(value, meta) {
  if (!meta || meta.decimals === null || meta.decimals === undefined) {
    return formatUnits(value, 0, 0) + ' (raw units — decimals unknown)';
  }
  return formatUnits(value, meta.decimals, 6) + (meta.symbol ? ' ' + meta.symbol : '');
}
