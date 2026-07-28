/* Every view. One function per route; each takes the container and renders into it.
 *
 * The house rules, because they are what make this an explorer rather than a
 * dashboard:
 *
 *  1. A failed transaction is a RESULT, not an error. `status: 0x0` means mined,
 *     paid for and reverted, and it is rendered in full — the same fields, plus
 *     the reason. The single most common own goal in a home-made explorer is
 *     showing a reverted transaction as blank or as a network failure.
 *  2. Nothing is inferred that was not read. No decimals means raw units, not a
 *     guess of 18. No verified source means bytecode, not a claim about what the
 *     contract is.
 *  3. Every bounded query says what its bounds were.
 */

import * as rpc from './rpc.js';
import * as C from './chaindata.js';
import * as E from './emission.js';
import {
  el, link, blockLink, txLink, addrLink, kv, copyable, card, badge,
  table, finishTable, row, note, meter, hexBlock, tabs,
} from './dom.js';
import {
  toBig, toNum, toBytes, toHex, toChecksumAddress, formatEmber, formatGwei,
  formatInt, formatBytes, formatBigApprox, timeAgo, formatTimestamp, timestampLooksWrong,
  shorten, percent, asAscii, ADDRESS_RE, HASH_RE, ZERO_ADDRESS, WEI_PER_EMBER,
} from './format.js';
import { keccak256Hex } from './keccak.js';
import {
  decodeLog, asTokenTransfer, decodeRevert, formatTokenAmount, KNOWN_SIGNATURES,
  topicOf, TRANSFER_TOPIC,
} from './abi.js';
import { disassemble, extractSelectors, classifyCode, SELECTOR_NAMES } from './disasm.js';

const SCAN_NOTE = 'The eth_* surface has no address index — there is no '
  + 'eth_getTransactionsByAddress — so this list comes from walking blocks and '
  + 'filtering. It is exactly the range named above and nothing older.';

// ---- shared fragments ------------------------------------------------------

export function errorState(root, e, what) {
  const c = card(what || 'Could not load this');
  const isDown = e instanceof rpc.RpcUnreachable;
  c.appendChild(badge(isDown ? 'rpc unreachable' : 'rpc error', 'bad'));
  note(c, rpc.describeError(e), 'bad');
  if (isDown) {
    note(c, 'Nothing on this page is invented while a node is missing. Either point the '
      + 'explorer at a node with ?rpc=<url>, or open the canned fixture chain to see what the '
      + 'views look like.');
    const links = el('div', 'x-actions');
    links.appendChild(link('?fixtures=1#/', 'Browse the fixture chain', 'btn btn-ghost'));
    c.appendChild(links);
  }
  root.appendChild(c);
}

function emptyState(root, title, text) {
  const c = card(title);
  note(c, text);
  root.appendChild(c);
}

function statTile(label, value, sub) {
  const t = el('div', 'card stat x-stat');
  t.appendChild(el('div', 'n', value));
  t.appendChild(el('div', 'l', label));
  if (sub) t.appendChild(el('div', 'x-stat-sub', sub));
  return t;
}

/** The from → to pair, with the zero address and contract creation spelled out. */
function partyCell(addr, opts = {}) {
  if (!addr) return el('span', 'x-mute', opts.nullText || 'contract creation');
  const a = toChecksumAddress(addr);
  if (a === ZERO_ADDRESS) {
    const s = el('span');
    s.appendChild(addrLink(a, shorten(a, 8, 6)));
    s.appendChild(el('span', 'x-mute', ' (zero address)'));
    return s;
  }
  return addrLink(a, opts.short ? shorten(a, 8, 6) : a);
}

function txStatusBadge(receipt) {
  if (!receipt) return badge('pending', 'warn');
  return receipt.status === '0x1' ? badge('success', 'ok') : badge('failed', 'bad');
}

function txTable(parent, txs, opts = {}) {
  const tb = table(parent, ['Hash', 'Block', 'Age', 'From', 'To', 'Value', 'Fee cap'],
    { empty: opts.empty || 'No transactions in the range scanned.' });
  for (const tx of txs) {
    const feeCap = toBig(tx.gas) * toBig(tx.gasPrice);
    row(tb, [
      { node: txLink(tx.hash, shorten(tx.hash, 12, 6)) },
      { node: tx.blockNumber === null ? el('span', 'x-warn', 'pending') : blockLink(toNum(tx.blockNumber)) },
      { text: tx.timestamp ? timeAgo(toNum(tx.timestamp)) : '—', cls: 'x-mute' },
      { node: partyCell(tx.from, { short: true }) },
      { node: partyCell(tx.to, { short: true }) },
      { text: formatEmber(toBig(tx.value), 4) + ' EMBER', cls: 'x-amount' },
      { text: formatEmber(feeCap, 6), cls: 'x-mute' },
    ]);
  }
  finishTable(tb, 7);
  return tb;
}

/** Render a list of logs, decoded where the signature is known. */
async function logList(parent, logs, opts = {}) {
  if (!logs.length) {
    note(parent, opts.empty || 'This transaction emitted no logs.');
    return;
  }
  // Token metadata for every Transfer, in one pass, so amounts get their symbol.
  const tokens = new Set(logs.filter(l => (l.topics || [])[0] === TRANSFER_TOPIC).map(l => l.address));
  const meta = new Map();
  await Promise.all([...tokens].map(async a => { meta.set(a.toLowerCase(), await C.tokenMeta(a)); }));

  for (const l of logs) {
    const box = el('div', 'x-log');
    const head = el('div', 'x-log-head');
    head.appendChild(el('span', 'x-log-idx', '#' + toNum(l.logIndex)));
    const decoded = decodeLog(l);
    head.appendChild(el('span', 'x-log-name', decoded ? decoded.name : 'unknown event'));
    if (decoded) head.appendChild(el('span', 'x-log-sig mono', decoded.sig));
    else head.appendChild(badge('undecoded', 'warn'));
    head.appendChild(el('span', 'x-log-spacer'));
    head.appendChild(addrLink(toChecksumAddress(l.address), shorten(toChecksumAddress(l.address), 10, 6)));
    box.appendChild(head);

    if (decoded) {
      const t = table(box, ['Argument', 'Type', 'Value']);
      const m = meta.get(String(l.address).toLowerCase());
      for (const a of decoded.args) {
        let display;
        if (a.type === 'address') display = { node: addrLink(a.value, a.value) };
        else if (typeof a.value === 'bigint' && a.name === 'value' && m && m.decimals !== null) {
          display = { text: formatTokenAmount(a.value, m) + '  (' + formatInt(a.value) + ' raw)' };
        } else display = { text: typeof a.value === 'bigint' ? formatInt(a.value) : String(a.value) };
        row(t, [
          { text: a.name + (a.indexed ? ' (indexed)' : ''), cls: 'x-mute' },
          { text: a.type, cls: 'x-mute' },
          display,
        ]);
      }
    } else {
      note(box, 'No ABI for this contract and no known signature for topic0. Raw topics and '
        + 'data below — nothing is guessed at.', 'mute');
      const t = table(box, ['Position', 'Topic']);
      (l.topics || []).forEach((topic, i) => {
        row(t, [{ text: 'topic' + i, cls: 'x-mute' }, { text: topic, cls: 'brk' }]);
      });
      box.appendChild(hexBlock(l.data));
    }
    parent.appendChild(box);
  }
}

/** The ERC-20 movements inside one transaction, shown above the raw logs. */
async function tokenTransferSummary(parent, logs) {
  const transfers = logs.map(asTokenTransfer).filter(Boolean);
  if (!transfers.length) return;
  const c = card('Token transfers', { badge: transfers.length + ' ERC-20' });
  const metas = new Map();
  await Promise.all([...new Set(transfers.map(t => t.token.toLowerCase()))]
    .map(async a => metas.set(a, await C.tokenMeta(a))));
  const tb = table(c, ['Token', 'From', 'To', 'Amount']);
  for (const t of transfers) {
    const m = metas.get(t.token.toLowerCase());
    const tokenCell = el('span');
    tokenCell.appendChild(link('#/token/' + t.token, m && m.symbol ? m.symbol : shorten(t.token, 8, 6), 'x-link mono'));
    if (t.mint) tokenCell.appendChild(badge('mint', 'ok'));
    if (t.burn) tokenCell.appendChild(badge('burn', 'warn'));
    row(tb, [
      { node: tokenCell },
      { node: partyCell(t.from, { short: true }) },
      { node: partyCell(t.to, { short: true }) },
      { text: formatTokenAmount(t.value, m), cls: 'x-amount' },
    ]);
  }
  parent.appendChild(c);
}

// ---- home ------------------------------------------------------------------

export async function home(root) {
  const height = await C.tip();
  const [chainId, gasPrice] = await rpc.batchStrict([['eth_chainId', []], ['eth_gasPrice', []]]);
  const blocks = await C.latestBlocks(12, height);

  const tipBlock = blocks[0];
  const stats = el('div', 'grid g4 x-stats');
  stats.appendChild(statTile('block height', '#' + formatInt(height),
    tipBlock ? timeAgo(toNum(tipBlock.timestamp)) : ''));
  stats.appendChild(statTile('chain id', toNum(chainId),
    toNum(chainId) === 7411 ? 'hearth mainnet' : 'not 7411 — check which chain this is'));
  stats.appendChild(statTile('gas price', formatGwei(toBig(gasPrice)) + ' gwei', 'suggested by the node'));
  const gasPct = tipBlock ? percent(toBig(tipBlock.gasUsed), toBig(tipBlock.gasLimit)) : 0;
  stats.appendChild(statTile('tip block fullness', gasPct.toFixed(1) + '%',
    tipBlock ? formatInt(toBig(tipBlock.gasUsed)) + ' / ' + formatInt(toBig(tipBlock.gasLimit)) + ' gas' : ''));
  root.appendChild(stats);

  if (tipBlock && timestampLooksWrong(toNum(tipBlock.timestamp))) {
    const w = card('The tip block\'s timestamp is not in seconds');
    note(w, 'The header reads ' + toNum(tipBlock.timestamp) + ', which as UNIX seconds is far in '
      + 'the future. docs/evm-spec.md §4 requires the header to store SECONDS; the v1 header '
      + 'stored milliseconds. Every date on this page is wrong until that conversion lands, and '
      + 'every Solidity deadline comparison on this chain is wrong with it.', 'bad');
    root.appendChild(w);
  }

  const bc = card('Latest blocks', { aside: link('#/blocks', 'all blocks', 'x-link x-head-link') });
  const tb = table(bc, ['Height', 'Age', 'Txs', 'Gas used', 'Miner', 'Hash'], { empty: 'No blocks.' });
  for (const b of blocks) {
    const pct = percent(toBig(b.gasUsed), toBig(b.gasLimit));
    row(tb, [
      { node: blockLink(toNum(b.number)) },
      { text: timeAgo(toNum(b.timestamp)), cls: 'x-mute' },
      { text: String(b.transactions.length) },
      { node: meter(pct, formatInt(toBig(b.gasUsed)) + ' (' + pct.toFixed(1) + '%)') },
      { node: partyCell(b.miner, { short: true }) },
      { text: shorten(b.hash, 12, 8), cls: 'x-mute' },
    ]);
  }
  finishTable(tb, 6);
  root.appendChild(bc);

  const tc = card('Latest transactions');
  const txs = await C.recentTransactions(12, height);
  txTable(tc, txs, { empty: 'No transactions in the last 40 blocks. On a young chain that is normal.' });
  root.appendChild(tc);
}

// ---- blocks ----------------------------------------------------------------

export async function blockList(root, params) {
  const height = await C.tip();
  const to = params && params.to !== undefined ? Number(params.to) : height;
  const blocks = await C.latestBlocks(25, to);
  const c = card('Blocks ' + Math.max(0, to - 24) + ' – ' + to);
  const tb = table(c, ['Height', 'Age', 'Txs', 'Gas used', 'Size', 'Miner', 'Difficulty'], { empty: 'No blocks.' });
  for (const b of blocks) {
    const pct = percent(toBig(b.gasUsed), toBig(b.gasLimit));
    row(tb, [
      { node: blockLink(toNum(b.number)) },
      { text: timeAgo(toNum(b.timestamp)), cls: 'x-mute' },
      { text: String(b.transactions.length) },
      { node: meter(pct, pct.toFixed(1) + '%') },
      { text: formatBytes(toNum(b.size)), cls: 'x-mute' },
      { node: partyCell(b.miner, { short: true }) },
      { text: formatBigApprox(toBig(b.difficulty)), cls: 'x-mute' },
    ]);
  }
  finishTable(tb, 7);
  const nav = el('div', 'x-actions');
  if (to - 25 >= 0) nav.appendChild(link('#/blocks?to=' + (to - 25), '← older', 'btn btn-ghost'));
  if (to < height) nav.appendChild(link('#/blocks?to=' + Math.min(height, to + 25), 'newer →', 'btn btn-ghost'));
  c.appendChild(nav);
  root.appendChild(c);
}

export async function block(root, ref) {
  const b = await C.getBlock(ref, true);
  if (!b) {
    emptyState(root, 'No such block',
      `Nothing on this chain has height or hash ${ref}. If it is a height above the tip, the block `
      + 'has not been mined yet; if it is a hash, it may be on a branch this node never saw.');
    return;
  }
  const height = toNum(b.number);
  const head = card('Block #' + formatInt(height), { badge: b.transactions.length + ' txs' });
  const nav = el('div', 'x-actions');
  if (height > 0) nav.appendChild(link('#/block/' + (height - 1), '← ' + (height - 1), 'btn btn-ghost'));
  nav.appendChild(link('#/block/' + (height + 1), (height + 1) + ' →', 'btn btn-ghost'));
  head.appendChild(nav);

  kv(head, 'hash', copyable(b.hash));
  kv(head, 'parent', b.number === '0x0' ? el('span', 'x-mute', b.parentHash)
    : blockLink(height - 1, b.parentHash));
  kv(head, 'timestamp', formatTimestamp(toNum(b.timestamp)) + '  ·  ' + timeAgo(toNum(b.timestamp)),
    { tone: timestampLooksWrong(toNum(b.timestamp)) ? 'bad' : null });
  kv(head, 'miner', partyCell(b.miner), { hint: 'The coinbase account. Fees are paid here — no burn in v1.' });
  const gasPct = percent(toBig(b.gasUsed), toBig(b.gasLimit));
  kv(head, 'gas used', meter(gasPct, formatInt(toBig(b.gasUsed)) + ' / ' + formatInt(toBig(b.gasLimit))
    + ' (' + gasPct.toFixed(2) + '%)'));
  kv(head, 'size', formatBytes(toNum(b.size)) + '  (' + formatInt(toBig(b.size)) + ' bytes RLP)');
  kv(head, 'difficulty', formatBigApprox(toBig(b.difficulty)) + '  (' + formatInt(toBig(b.difficulty)) + ')',
    { hint: '2^256 / (target + 1) — derived from the Homefire target' });
  kv(head, 'total difficulty', formatBigApprox(toBig(b.totalDifficulty)),
    { hint: 'Cumulative work. docs/evm-spec.md §4: this must be stored, not recomputed per request.' });
  kv(head, 'nonce', b.nonce, { hint: 'The Homefire PoW nonce, low 8 bytes' });
  kv(head, 'mixHash', copyable(b.mixHash),
    { hint: 'The Homefire digest. This is what PREVRANDAO returns — miner-influenceable; never use it as randomness an adversarial miner could profit from biasing.' });
  const extra = toBytes(b.extraData);
  kv(head, 'extraData', extra.length ? (asAscii(extra) ? `${b.extraData}  "${asAscii(extra)}"` : b.extraData) : 'empty');
  root.appendChild(head);

  const roots = card('Roots and bloom');
  kv(roots, 'stateRoot', copyable(b.stateRoot));
  kv(roots, 'transactionsRoot', copyable(b.transactionsRoot));
  kv(roots, 'receiptsRoot', copyable(b.receiptsRoot));
  kv(roots, 'sha3Uncles', b.sha3Uncles + (b.uncles && b.uncles.length === 0 ? '  (no uncles on this chain)' : ''));
  const bloomBits = toBytes(b.logsBloom).reduce((n, byte) => n + (byte.toString(2).match(/1/g) || []).length, 0);
  kv(roots, 'logsBloom', bloomBits + ' of 2048 bits set');
  roots.appendChild(hexBlock(b.logsBloom, { max: true }));
  root.appendChild(roots);

  const txc = card('Transactions in this block');
  if (!b.transactions.length) {
    note(txc, 'This block is empty. It still cost a full Homefire proof to produce, and it still '
      + 'pays its subsidy — an empty block is not a failed one.');
  } else if (typeof b.transactions[0] === 'string') {
    // The chain is allowed to ignore fullTx (methods.js: "a hint only").
    const tb = table(txc, ['Hash']);
    for (const h of b.transactions) row(tb, [{ node: txLink(h, h) }]);
    note(txc, 'The node returned hashes rather than full transactions for this block; open one to see it.');
  } else {
    txTable(txc, b.transactions.map(t => ({ ...t, timestamp: b.timestamp })), { empty: 'None.' });
  }
  root.appendChild(txc);
}

// ---- transaction -----------------------------------------------------------

export async function transaction(root, hash) {
  const [txr, rcr] = await rpc.batch([
    ['eth_getTransactionByHash', [hash]],
    ['eth_getTransactionReceipt', [hash]],
  ]);
  if (!txr.ok) throw txr.error;
  const tx = txr.value;
  const receipt = rcr.ok ? rcr.value : null;

  if (!tx) {
    emptyState(root, 'No such transaction',
      `Nothing on this chain has hash ${hash}. It may never have been broadcast, it may have been `
      + 'dropped from the mempool, or it may have been mined on a branch that was reorged away.');
    return;
  }

  const failed = receipt && receipt.status === '0x0';
  const pending = !receipt;

  const head = card('Transaction', { badge: null, aside: txStatusBadge(receipt) });
  kv(head, 'hash', copyable(tx.hash));

  if (pending) {
    note(head, 'This transaction is in the mempool and has not been mined. It has no receipt, no '
      + 'gas used and no logs yet — eth_getTransactionReceipt correctly returns null rather than '
      + 'an error, which is what every client polls for.', 'warn');
  }

  if (failed) {
    const box = el('div', 'x-fail');
    box.appendChild(el('strong', null, 'This transaction failed.'));
    box.appendChild(el('span', null, ' It was mined, it consumed '
      + formatInt(toBig(receipt.gasUsed)) + ' gas and the sender paid for it. Its state changes were '
      + 'rolled back; any logs it would have emitted do not exist. status = 0x0 is a real outcome, '
      + 'not an error.'));
    head.appendChild(box);
  }

  kv(head, 'status', pending ? 'pending — not yet mined'
    : (failed ? 'failed (status 0x0)' : 'success (status 0x1)'),
  { tone: pending ? 'warn' : (failed ? 'bad' : 'ok') });
  kv(head, 'block', tx.blockNumber === null ? el('span', 'x-warn', 'pending')
    : blockLink(toNum(tx.blockNumber)));
  if (tx.blockHash) kv(head, 'block hash', link('#/block/' + tx.blockHash, tx.blockHash, 'x-link mono'));
  if (tx.transactionIndex !== null) kv(head, 'index in block', toNum(tx.transactionIndex));
  kv(head, 'from', partyCell(tx.from));

  if (receipt && receipt.contractAddress) {
    const created = el('span');
    created.appendChild(addrLink(toChecksumAddress(receipt.contractAddress)));
    created.appendChild(badge('created', 'ok'));
    kv(head, 'created contract', created);
    kv(head, 'to', el('span', 'x-mute', 'none — this transaction is a contract creation'));
  } else {
    kv(head, 'to', partyCell(tx.to));
  }

  kv(head, 'value', formatEmber(toBig(tx.value), 18) + ' EMBER', { tone: toBig(tx.value) > 0n ? 'amount' : null });
  kv(head, 'nonce', formatInt(toBig(tx.nonce)));
  kv(head, 'gas price', formatGwei(toBig(tx.gasPrice)) + ' gwei  (' + formatInt(toBig(tx.gasPrice)) + ' wei)');
  kv(head, 'gas limit', formatInt(toBig(tx.gas)));
  if (receipt) {
    const used = toBig(receipt.gasUsed);
    const pct = percent(used, toBig(tx.gas));
    kv(head, 'gas used', meter(pct, formatInt(used) + ' of ' + formatInt(toBig(tx.gas)) + ' (' + pct.toFixed(1) + '%)'));
    const price = toBig(receipt.effectiveGasPrice || tx.gasPrice);
    kv(head, 'transaction fee', formatEmber(used * price, 18) + ' EMBER',
      { hint: 'gasUsed × effectiveGasPrice — paid to the block\'s coinbase; v1 burns nothing (docs/evm-spec.md §1)' });
    kv(head, 'cumulative gas in block', formatInt(toBig(receipt.cumulativeGasUsed)));
  }
  kv(head, 'type', tx.type + (tx.type === '0x0' ? '  (legacy — v1 has no EIP-1559)' : ''));
  kv(head, 'chain id', tx.chainId === undefined
    ? el('span', 'x-warn', 'absent — a pre-155 UNPROTECTED transaction, replayable on any chain that accepts them')
    : toNum(tx.chainId));
  root.appendChild(head);

  // The revert reason, recovered by replaying the call. The receipt does not
  // carry one — nothing in the Ethereum receipt format does — so this is the
  // only way to show it, and it is a best-effort read against current state.
  if (failed) {
    const rc = card('Why it failed');
    const at = tx.blockNumber === null ? 'latest' : tx.blockNumber;
    const res = await rpc.tryCall('eth_call', [{
      from: tx.from, to: tx.to, gas: tx.gas, gasPrice: tx.gasPrice, value: tx.value, data: tx.input,
    }, at]);
    if (!res.ok && res.error instanceof rpc.RpcError && res.error.code === rpc.EXECUTION_REVERTED) {
      const decoded = decodeRevert(res.error.data);
      kv(rc, 'revert', el('span', 'x-bad', decoded.text), { mono: decoded.kind === 'custom' });
      kv(rc, 'raw revert data', res.error.data || '0x');
      if (decoded.kind === 'custom') {
        note(rc, 'A custom error. Decoding it needs the contract\'s ABI, and this chain has no '
          + 'verified sources yet (docs/listing-checklist.md §3), so the selector is all there is.');
      }
    } else if (res.ok) {
      note(rc, 'Replaying this call against the current state succeeds, so the reason it failed is '
        + 'no longer reproducible — state has moved on, or it ran out of gas rather than reverting. '
        + 'Gas used was ' + formatInt(toBig(receipt.gasUsed)) + ' of a '
        + formatInt(toBig(tx.gas)) + ' limit'
        + (toBig(receipt.gasUsed) === toBig(tx.gas) ? ', which is the whole limit — that is what running out of gas looks like.' : '.'));
    } else {
      note(rc, 'Could not replay the call to recover a reason: ' + rpc.describeError(res.error), 'mute');
    }
    note(rc, 'Recovered by re-running the call with eth_call. An Ethereum receipt carries no revert '
      + 'reason, so this is a replay against state as it is now, not a record of what happened then.', 'mute');
    root.appendChild(rc);
  }

  if (receipt) await tokenTransferSummary(root, receipt.logs || []);

  // Input data
  const input = tx.input || '0x';
  const ic = card('Input data', { badge: formatBytes((input.length - 2) / 2) });
  if (input === '0x') {
    note(ic, 'Empty — a plain value transfer.');
  } else {
    const sel = input.slice(0, 10);
    const known = SELECTOR_NAMES.get(sel);
    kv(ic, 'function selector', known ? sel + '   ' + known : sel + '   (unknown signature)');
    if (!known) {
      note(ic, 'The first four bytes are the function selector. Without an ABI it cannot be '
        + 'resolved to a name — and guessing from a public signature database is exactly the kind '
        + 'of unverified claim this page does not make.', 'mute');
    }
    tabs(ic, [
      { label: 'Raw', render: p => p.appendChild(hexBlock(input)) },
      { label: '32-byte words', render: p => {
        const body = toBytes('0x' + input.slice(10));
        const t = table(p, ['#', 'Word', 'As uint', 'As address']);
        for (let i = 0; i * 32 < body.length; i++) {
          const w = toHex(body.slice(i * 32, i * 32 + 32));
          const asAddr = '0x' + w.slice(26);
          row(t, [
            { text: i, cls: 'x-mute' }, { text: w, cls: 'brk' },
            { text: formatInt(toBig(w)) },
            { text: /^0x0{24}/.test(w) && toBig(w) !== 0n ? toChecksumAddress(asAddr) : '', cls: 'x-mute' },
          ]);
        }
        if (body.length % 32) note(p, 'Trailing ' + (body.length % 32) + ' bytes are not a whole word.');
      } },
    ]);
  }
  root.appendChild(ic);

  if (receipt) {
    const lc = card('Logs', { badge: (receipt.logs || []).length + ' emitted' });
    await logList(lc, receipt.logs || [], {
      empty: failed
        ? 'None. A reverted transaction emits no logs — anything it logged before reverting was rolled back with the rest of its state.'
        : 'This transaction emitted no logs.',
    });
    root.appendChild(lc);
  }

  const sig = card('Signature');
  kv(sig, 'v', tx.v);
  kv(sig, 'r', tx.r);
  kv(sig, 's', tx.s);
  root.appendChild(sig);
}

// ---- address ---------------------------------------------------------------

export async function address(root, addr, params = {}) {
  const a = toChecksumAddress(addr);
  const acct = await C.accountKind(a);
  const height = await C.tip();

  const head = card(acct.isContract ? 'Contract' : 'Address',
    { aside: badge(acct.isContract ? 'contract' : 'EOA', acct.isContract ? 'accent' : null) });
  kv(head, 'address', copyable(a));
  kv(head, 'balance', formatEmber(acct.balance, 18) + ' EMBER',
    { tone: 'amount', hint: formatInt(acct.balance) + ' wei' });
  kv(head, acct.isContract ? 'nonce (contracts created)' : 'nonce (transactions sent)', formatInt(acct.nonce));
  if (!acct.isContract) {
    const pend = await rpc.tryCall('eth_getTransactionCount', [a, 'pending']);
    if (pend.ok && toBig(pend.value) !== acct.nonce) {
      kv(head, 'pending nonce', formatInt(toBig(pend.value)) + '  (' + (toBig(pend.value) - acct.nonce)
        + ' queued in the mempool)', { tone: 'warn' });
    }
  }
  if (acct.balance === 0n && acct.nonce === 0n && !acct.isContract) {
    note(head, 'This account has never been used: zero balance, zero nonce, no code. On an account '
      + 'model that is indistinguishable from an address that does not exist — and it is a valid '
      + 'answer, not an error.');
  }
  root.appendChild(head);

  if (acct.isContract) await contractPanel(root, a, acct.code);

  // Token holdings, from the transfers this address has taken part in.
  const logFrom = Math.max(0, height - C.DEFAULT_LOG_SCAN);
  let transfers = [];
  try {
    transfers = await C.tokenTransfersFor(a, logFrom, height);
  } catch (e) {
    const c = card('Token transfers');
    note(c, 'eth_getLogs failed for this address: ' + rpc.describeError(e), 'bad');
    root.appendChild(c);
  }

  if (transfers.length) {
    const tokens = [...new Set(transfers.map(t => t.token.toLowerCase()))];
    const bc = card('Token balances', { badge: tokens.length + ' tokens seen' });
    const tb = table(bc, ['Token', 'Symbol', 'Balance', 'Transfers seen'], { empty: 'None.' });
    for (const t of tokens) {
      const m = await C.tokenMeta(t);
      const bal = await C.tokenBalance(t, a);
      row(tb, [
        { node: link('#/token/' + toChecksumAddress(t), shorten(toChecksumAddress(t), 10, 6), 'x-link mono') },
        { text: m.symbol || '—' },
        { text: bal === null ? 'balanceOf reverted or is absent' : formatTokenAmount(bal, m), cls: 'x-amount' },
        { text: String(transfers.filter(x => x.token.toLowerCase() === t).length), cls: 'x-mute' },
      ]);
    }
    finishTable(tb, 4);
    note(bc, 'Balances are read live with balanceOf(address). The token list is whatever moved to or '
      + `from this address in blocks ${formatInt(logFrom)}–${formatInt(height)} — a token held but `
      + 'never moved in that window will not appear.', 'mute');
    root.appendChild(bc);

    const tc = card('Token transfers', { badge: transfers.length });
    const tt = table(tc, ['Block', 'Token', 'From', 'To', 'Amount', 'Tx'], { empty: 'None.' });
    for (const t of transfers.slice(0, 100)) {
      const m = await C.tokenMeta(t.token);
      row(tt, [
        { node: blockLink(toNum(t.log.blockNumber)) },
        { text: m.symbol || shorten(t.token, 8, 4) },
        { node: partyCell(t.from, { short: true }) },
        { node: partyCell(t.to, { short: true }) },
        { text: (t.to === a ? '+' : t.from === a ? '−' : '') + formatTokenAmount(t.value, m),
          cls: t.to === a ? 'x-ok' : 'x-amount' },
        { node: txLink(t.log.transactionHash, shorten(t.log.transactionHash, 10, 4)) },
      ]);
    }
    finishTable(tt, 6);
    root.appendChild(tc);
  }

  // Transactions: the bounded scan.
  const depth = params.depth ? Number(params.depth) : C.DEFAULT_TX_SCAN;
  const scan = await C.scanTransactions(a, { depth, height });
  const txc = card('Transactions', { badge: `blocks ${formatInt(scan.from)}–${formatInt(scan.to)}` });
  txTable(txc, scan.txs, {
    empty: `No transactions from or to this address in blocks ${formatInt(scan.from)}–${formatInt(scan.to)}. `
      + 'That is the range scanned, not the whole chain.',
  });
  note(txc, SCAN_NOTE, 'mute');
  const more = el('div', 'x-actions');
  if (depth < 500) {
    more.appendChild(link(`#/address/${a}?depth=${Math.min(500, depth * 4)}`,
      `scan ${Math.min(500, depth * 4)} blocks instead`, 'btn btn-ghost'));
  }
  txc.appendChild(more);
  root.appendChild(txc);
}

async function contractPanel(root, a, code) {
  const bytes = toBytes(code);
  const c = card('Contract code', { badge: formatBytes(bytes.length) });
  kv(c, 'code size', formatInt(bytes.length) + ' bytes',
    { hint: 'EIP-170 caps deployed runtime code at 24,576 bytes' });
  kv(c, 'code hash', copyable(keccak256Hex(bytes)),
    { hint: 'keccak256 of the runtime code — computed in the page; eth_getCode does not return it' });
  const guess = classifyCode(code);
  if (guess) kv(c, 'shape', guess, { mono: false });

  const meta = await C.tokenMeta(a);
  if (meta.isToken) {
    kv(c, 'token', (meta.name || '?') + ' (' + (meta.symbol || '?') + ')', { mono: false });
    if (meta.decimals !== null) kv(c, 'decimals', meta.decimals);
    if (meta.totalSupply !== null) {
      kv(c, 'total supply', formatTokenAmount(meta.totalSupply, meta));
    }
    const l = el('div', 'x-actions');
    l.appendChild(link('#/token/' + a, 'Open the token view', 'btn btn-ghost'));
    c.appendChild(l);
  }

  const sels = extractSelectors(code);
  const dis = disassemble(code);

  tabs(c, [
    { label: 'Interface', render: p => {
      if (!sels.length) {
        note(p, 'No function selectors found in the dispatcher. That is normal for a proxy, for '
          + 'hand-written assembly, or for a contract whose only entry point is its fallback — the '
          + 'EIP-1167 minimal proxy has exactly this shape. It does not mean the contract does nothing.');
        return;
      }
      const t = table(p, ['Selector', 'Signature']);
      for (const s of sels) {
        row(t, [{ text: s }, { text: SELECTOR_NAMES.get(s) || 'unknown', cls: SELECTOR_NAMES.get(s) ? '' : 'x-mute' }]);
      }
      note(p, 'Read out of the contract\'s own dispatcher: every PUSH4 immediately compared with '
        + 'EQ, GT or LT. It is what the bytecode contains, not a claim about what the contract is. '
        + 'Selectors with no name here are simply not in this page\'s table.', 'mute');
    } },
    { label: 'Disassembly', render: p => {
      const pre = el('pre', 'x-disasm mono');
      const lines = [];
      for (const op of dis.ops) {
        const pcs = op.pc.toString(16).padStart(4, '0');
        let line = pcs + '  ' + op.name.padEnd(13, ' ');
        if (op.immediate) line += op.immediate;
        if (!op.defined) line += '   ← not an instruction in Shanghai; halts the frame';
        if (op.truncated) line += '   ← PUSH data runs past the end of the code';
        lines.push(line);
      }
      pre.textContent = lines.join('\n');
      p.appendChild(pre);
      note(p, `${formatInt(dis.ops.length)} instructions, ${dis.jumpdests.size} JUMPDESTs. Linear `
        + 'sweep: PUSH immediates are consumed as data, so a 0x5b inside PUSH data is correctly not '
        + 'counted as a jump destination. The tail of a solc-compiled contract is CBOR metadata and '
        + 'disassembles as nonsense — that is expected, not a bug.', 'mute');
    } },
    { label: 'Bytecode', render: p => {
      p.appendChild(hexBlock(code));
    } },
    { label: 'Source', render: p => {
      note(p, 'No verified source. This chain has no source-verification service yet — '
        + 'docs/listing-checklist.md §3 lists "verified contract sources" as outstanding, and '
        + 'docs/evm-spec.md §8 puts it in phase 8. Until one exists, the bytecode above is the only '
        + 'thing anyone can check, and no page should imply otherwise.', 'warn');
      note(p, 'What that costs a reader: custom errors cannot be decoded, events outside the '
        + 'standard set cannot be named, and constructor arguments cannot be shown.', 'mute');
    } },
  ]);
  root.appendChild(c);
}

// ---- tokens ----------------------------------------------------------------

export async function tokens(root) {
  const height = await C.tip();
  const from = Math.max(0, height - C.DEFAULT_LOG_SCAN);
  const found = await C.discoverTokens(from, height);
  const c = card('Tokens', { badge: found.length + ' seen moving' });
  note(c, `Every contract that emitted an ERC-20 Transfer in blocks ${formatInt(from)}–`
    + `${formatInt(height)}. There is no token registry on this chain and there does not need to be: `
    + 'the standard Transfer topic is the detector, which is why an explorer can list tokens the day '
    + 'the first one is deployed.');
  const tb = table(c, ['Token', 'Symbol', 'Name', 'Decimals', 'Total supply', 'Transfers', 'Addresses'],
    { empty: 'No ERC-20 Transfer events in the range scanned. Either no tokens exist yet, or none have moved.' });
  for (const t of found) {
    const m = await C.tokenMeta(t.address);
    row(tb, [
      { node: link('#/token/' + t.address, shorten(t.address, 10, 6), 'x-link mono') },
      { text: m.symbol || '—' },
      { text: m.name || '—', cls: m.name ? '' : 'x-mute' },
      { text: m.decimals === null ? 'not exposed' : m.decimals, cls: m.decimals === null ? 'x-warn' : '' },
      { text: m.totalSupply === null ? '—' : formatTokenAmount(m.totalSupply, m) },
      { text: String(t.transfers) },
      { text: String(t.holders.size), cls: 'x-mute' },
    ]);
  }
  finishTable(tb, 7);
  root.appendChild(c);
}

export async function token(root, addr) {
  const a = toChecksumAddress(addr);
  const height = await C.tip();
  const from = Math.max(0, height - C.DEFAULT_LOG_SCAN);
  const [meta, code] = await Promise.all([C.tokenMeta(a), rpc.call('eth_getCode', [a, 'latest'])]);

  const head = card(meta.name ? `${meta.name} (${meta.symbol || '?'})` : 'Token',
    { aside: badge(code && code !== '0x' ? 'contract' : 'no code', code && code !== '0x' ? 'accent' : 'bad') });
  kv(head, 'address', copyable(a));
  kv(head, 'name', meta.name === null ? el('span', 'x-warn', 'name() did not answer') : meta.name, { mono: false });
  kv(head, 'symbol', meta.symbol === null ? el('span', 'x-warn', 'symbol() did not answer') : meta.symbol, { mono: false });
  kv(head, 'decimals', meta.decimals === null
    ? el('span', 'x-warn', 'decimals() did not answer — amounts below are RAW UNITS')
    : meta.decimals);
  kv(head, 'total supply', meta.totalSupply === null ? '—' : formatTokenAmount(meta.totalSupply, meta));
  if (!code || code === '0x') {
    note(head, 'There is no code at this address. A call into an address with no code SUCCEEDS and '
      + 'returns empty in the EVM, which is why nothing above threw — and why an explorer must '
      + 'check for code rather than trusting an empty return.', 'bad');
  }
  root.appendChild(head);

  const logs = await C.getLogs({ fromBlock: from, toBlock: height, address: [a.toLowerCase()], topics: [TRANSFER_TOPIC] });
  const transfers = logs.map(asTokenTransfer).filter(Boolean)
    .sort((x, y) => toNum(y.log.blockNumber) - toNum(x.log.blockNumber));

  // Holders, from the transfers seen, with live balances. This is a sample of
  // the holder set — not a rich list, and it does not claim to be one.
  const holders = [...new Set(transfers.flatMap(t => [t.from, t.to]).filter(h => h !== ZERO_ADDRESS))];
  const hc = card('Holders', { badge: holders.length + ' addresses seen' });
  const htb = table(hc, ['Address', 'Balance', 'Share of supply'], { empty: 'No transfers, so no holders to sample.' });
  const balances = await Promise.all(holders.slice(0, 50).map(async h => [h, await C.tokenBalance(a, h)]));
  balances.sort((x, y) => (y[1] === null ? -1n : y[1]) > (x[1] === null ? -1n : x[1]) ? 1 : -1);
  for (const [h, bal] of balances) {
    const share = bal !== null && meta.totalSupply ? percent(bal, meta.totalSupply) : null;
    row(htb, [
      { node: addrLink(h, shorten(h, 12, 8)) },
      { text: bal === null ? 'balanceOf did not answer' : formatTokenAmount(bal, meta), cls: 'x-amount' },
      { text: share === null ? '—' : share.toFixed(2) + '%', cls: 'x-mute' },
    ]);
  }
  finishTable(htb, 3);
  note(hc, 'Addresses that sent or received this token in the range scanned, with balances read '
    + 'live. It is a sample, not a rich list: an address that received tokens before block '
    + formatInt(from) + ' and has not moved them since is not here. A real rich list needs an '
    + 'indexer that follows every transfer from genesis.', 'mute');
  root.appendChild(hc);

  const tc = card('Transfers', { badge: transfers.length + ' in range' });
  const tb = table(tc, ['Block', 'From', 'To', 'Amount', 'Tx'], { empty: 'No transfers in the range scanned.' });
  for (const t of transfers.slice(0, 100)) {
    const cell = el('span');
    cell.appendChild(partyCell(t.from, { short: true }));
    if (t.mint) cell.appendChild(badge('mint', 'ok'));
    row(tb, [
      { node: blockLink(toNum(t.log.blockNumber)) },
      { node: cell },
      { node: partyCell(t.to, { short: true }) },
      { text: formatTokenAmount(t.value, meta), cls: 'x-amount' },
      { node: txLink(t.log.transactionHash, shorten(t.log.transactionHash, 10, 6)) },
    ]);
  }
  finishTable(tb, 5);
  root.appendChild(tc);
}

// ---- logs ------------------------------------------------------------------

export async function logs(root, params) {
  const height = await C.tip();
  const c = card('Logs and events');
  note(c, 'eth_getLogs is the query indexers and dapp developers live on: indexed by address and by '
    + 'topic, and accelerated by each block\'s bloom filter. Topic matching is positional — position '
    + 'i constrains topics[i], an empty position matches anything, and several values in one '
    + 'position are an OR.');

  const form = el('form', 'x-form');
  const field = (name, label, value, placeholder, list) => {
    const wrap = el('div', 'x-field');
    wrap.appendChild(el('label', 'lbl', label));
    const i = el('input', 'field');
    i.name = name;
    i.value = value || '';
    i.spellcheck = false;
    i.autocomplete = 'off';
    if (placeholder) i.placeholder = placeholder;
    if (list) i.setAttribute('list', list);
    wrap.appendChild(i);
    form.appendChild(wrap);
    return i;
  };

  const defFrom = params.fromBlock !== undefined ? params.fromBlock : Math.max(0, height - 100);
  const fAddr = field('address', 'contract address', params.address, '0x… (blank matches every contract)');
  const fEvent = field('event', 'event signature or topic0', params.event,
    'Transfer(address,address,uint256)  ·  or a 32-byte topic', 'x-sigs');
  const fT1 = field('topic1', 'topic 1', params.topic1, '0x… (blank = any)');
  const fT2 = field('topic2', 'topic 2', params.topic2, '0x… (blank = any)');
  const fFrom = field('fromBlock', 'from block', defFrom, '0');
  const fTo = field('toBlock', 'to block', params.toBlock !== undefined ? params.toBlock : height, 'latest');

  const dl = el('datalist');
  dl.id = 'x-sigs';
  for (const s of KNOWN_SIGNATURES) dl.appendChild(el('option')).value = s;
  form.appendChild(dl);

  const actions = el('div', 'x-actions');
  const go = el('button', 'btn btn-primary', 'Search logs');
  go.type = 'submit';
  actions.appendChild(go);
  const quick = el('button', 'btn btn-ghost', 'All ERC-20 transfers');
  quick.type = 'button';
  quick.addEventListener('click', () => { fEvent.value = 'Transfer(address,address,uint256)'; go.click(); });
  actions.appendChild(quick);
  form.appendChild(actions);
  c.appendChild(form);

  const results = el('div');
  c.appendChild(results);
  root.appendChild(c);

  form.addEventListener('submit', ev => {
    ev.preventDefault();
    const q = new URLSearchParams();
    for (const [k, v] of [['address', fAddr.value], ['event', fEvent.value], ['topic1', fT1.value],
      ['topic2', fT2.value], ['fromBlock', fFrom.value], ['toBlock', fTo.value]]) {
      if (String(v).trim()) q.set(k, String(v).trim());
    }
    location.hash = '#/logs?' + q.toString();
  });

  // Only query when something was actually asked for; an unfiltered scan of the
  // whole chain is a denial of service, not a default.
  if (!params.address && !params.event && !params.topic1 && !params.topic2) {
    note(results, 'Set at least a contract address or an event, then search. An unconstrained query '
      + 'over every block is refused by the node anyway — methods.js caps a range at 10,000 blocks '
      + 'and a result set at 20,000 logs.', 'mute');
    return;
  }

  let topic0 = null;
  if (params.event) {
    const v = String(params.event).trim();
    topic0 = HASH_RE.test(v) ? v.toLowerCase() : topicOf(v);
    if (!HASH_RE.test(v)) {
      kv(results, 'topic0', topic0 + '   = keccak256("' + v + '")');
    }
  }
  const topics = [];
  if (topic0) topics.push(topic0); else topics.push(null);
  topics.push(params.topic1 ? String(params.topic1).toLowerCase() : null);
  topics.push(params.topic2 ? String(params.topic2).toLowerCase() : null);
  while (topics.length && topics[topics.length - 1] === null) topics.pop();

  let found;
  try {
    found = await C.getLogs({
      fromBlock: Number(params.fromBlock ?? defFrom),
      toBlock: params.toBlock === undefined || params.toBlock === 'latest' ? height : Number(params.toBlock),
      address: params.address ? [String(params.address).toLowerCase()] : null,
      topics: topics.length ? topics : null,
    });
  } catch (e) {
    note(results, rpc.describeError(e), 'bad');
    if (e instanceof rpc.RpcError) {
      note(results, 'That is the node refusing the query, which is the correct behaviour for a '
        + 'range or result set that is too large. Narrow the block range or add an address.', 'mute');
    }
    return;
  }

  const rc = card('Results', { badge: found.length + ' logs' });
  if (!found.length) {
    note(rc, 'No logs matched. An empty result is a valid answer — it is not an error and it does '
      + 'not mean the query was wrong.');
  } else {
    await logList(rc, found);
  }
  results.appendChild(rc);
}

// ---- supply ----------------------------------------------------------------

/**
 * The aggregator page, and the one with a trap in it.
 *
 * `GET /supply`'s `circulating` field is the sum of the entire UTXO set and
 * INCLUDES the Commons treasury (node/src/rpc.js:228-240 → chain.js:166-170;
 * docs/tokenomics.md §7 and docs/listing-checklist.md §3 both flag it). An
 * aggregator that publishes it overstates circulating supply by the whole
 * treasury balance. Both figures are shown here, named for what they are, with
 * the subtraction done in the open.
 */
export async function supply(root, params = {}) {
  const height = await C.tip();

  const head = card('Supply', { badge: 'for aggregators' });
  note(head, 'CoinGecko and CoinMarketCap take a circulating supply figure at face value. The two '
    + 'numbers below are different quantities and one of them must not be published as circulating.');
  root.appendChild(head);

  const model = E.cumulative(height);
  const commonsAddr = params.commons
    || (document.querySelector('meta[name="hearth-commons-address"]') || {}).content
    || null;

  let commonsOnChain = null;
  let commonsError = null;
  if (commonsAddr && ADDRESS_RE.test(commonsAddr)) {
    const r = await rpc.tryCall('eth_getBalance', [commonsAddr.toLowerCase(), 'latest']);
    if (r.ok) commonsOnChain = toBig(r.value); else commonsError = r.error;
  }

  const totalEmber = E.sparksToEmber(model.totalSparks);
  const commonsModelEmber = E.sparksToEmber(model.commonsSparks);
  const circulatingModelEmber = E.sparksToEmber(model.totalSparks - model.commonsSparks);

  const figures = el('div', 'grid g3 x-stats');
  figures.appendChild(statTile('total supply', totalEmber + ' EMBER',
    'every EMBER ever issued, up to block ' + formatInt(height)));
  figures.appendChild(statTile('circulating supply', circulatingModelEmber + ' EMBER',
    'total MINUS the Commons treasury — this is the figure to publish'));
  figures.appendChild(statTile('Commons treasury', commonsModelEmber + ' EMBER',
    'minted, never spendable — excluded from circulating'));
  root.appendChild(figures);

  const m = card('How each number is arrived at');
  kv(m, 'height', formatInt(height), { mono: false });
  kv(m, 'total supply', totalEmber + ' EMBER',
    { hint: 'Σ subsidy(h) for h = 0..tip — deterministic, offline-computable' });
  kv(m, '− Commons treasury', commonsModelEmber + ' EMBER',
    { hint: 'Σ floor(subsidy(h) × 0.10) — 10% of every subsidy, params.js:22, enforced at chain.js:310-313' });
  kv(m, '= circulating supply', circulatingModelEmber + ' EMBER', { tone: 'amount' });
  kv(m, 'max supply', 'none — the schedule is uncapped, with a perpetual 0.3 EMBER tail', { mono: false });
  note(m, 'This is the methodology in docs/tokenomics.md §7. Nothing else is excluded: there is no '
    + 'vesting, no lock-up, no team wallet, no foundation reserve and no escrow, because none of '
    + 'those exist.');
  root.appendChild(m);

  const trap = card('The number NOT to publish', { aside: badge('read this', 'bad') });
  const t = el('div', 'x-fail');
  t.appendChild(el('strong', null, 'GET /supply’s `circulating` field includes the Commons treasury.'));
  t.appendChild(el('span', null, ' It is the sum of the entire UTXO set (node/src/rpc.js:228-240 calls '
    + 'chain.supply(), which at chain.js:166-170 sums every unspent output), and the Commons address '
    + 'holds unspent outputs like any other. Publishing it overstates circulating supply by the '
    + 'whole treasury balance. The field name is misleading; the arithmetic is not ambiguous — '
    + 'subtract commonsTreasury from circulating and you have the right figure.'));
  trap.appendChild(t);
  root.appendChild(trap);

  const src = card('Where these figures come from, and what is still missing');
  kv(src, 'total & Commons', 'modelled from the emission schedule', { mono: false });
  note(src, 'Neither figure is read from the chain. There is no eth_* method that returns total '
    + 'supply — there is no eth_totalSupply and there will not be one — and the REST /supply route '
    + 'sums a UTXO set the account model does not have. So both are computed here from the published '
    + 'schedule (docs/coinnomics.md, node/src/params.js:140-151), which is deterministic and '
    + 'offline-computable. That is honest but it is not the same as reading the chain: if the '
    + 'account-model genesis or emission differs by so much as one block, this figure drifts and '
    + 'nothing here would notice.', 'warn');

  if (commonsAddr && ADDRESS_RE.test(commonsAddr)) {
    kv(src, 'Commons address', addrLink(toChecksumAddress(commonsAddr)));
    if (commonsOnChain !== null) {
      kv(src, 'Commons balance, on chain', formatEmber(commonsOnChain, 8) + ' EMBER', { tone: 'amount' });
      const modelWei = (model.commonsSparks * WEI_PER_EMBER) / 100000000n;
      const drift = commonsOnChain > modelWei ? commonsOnChain - modelWei : modelWei - commonsOnChain;
      kv(src, 'model vs chain', drift === 0n ? 'identical'
        : formatEmber(drift, 8) + ' EMBER apart', { tone: drift === 0n ? 'ok' : 'warn' });
      note(src, 'The on-chain balance is authoritative. Any gap means either the model above is out '
        + 'of step with consensus, or the treasury has been spent from — and docs/tokenomics.md §8 '
        + 'says there is no spend path, so a gap is a question worth asking out loud.', 'mute');
    } else if (commonsError) {
      note(src, 'Could not read the Commons balance: ' + rpc.describeError(commonsError), 'bad');
    }
  } else {
    kv(src, 'Commons address', el('span', 'x-warn', 'not configured'));
    note(src, 'docs/tokenomics.md §8: under the account model the Commons becomes a 0x… address, and '
      + '"the replacement address has not been chosen and is not in the spec". Until it is, the '
      + 'treasury balance cannot be read from the chain at all — only modelled. Set it with '
      + '<meta name="hearth-commons-address"> or ?commons=0x… once it exists.', 'warn');
  }
  root.appendChild(src);

  const want = card('What an aggregator actually needs next');
  const list = el('ul', 'x-list');
  for (const item of [
    'A plain-text total supply endpoint: a decimal number, no JSON wrapper, no units.',
    'A plain-text circulating supply endpoint returning total − Commons, computed on the node.',
    'A holder count and a rich list, which need an indexer — eth_* cannot answer either.',
    'An Etherscan-compatible /api shim (module=account&action=balance, module=stats, module=logs). '
      + 'Aggregators, tax tools and several exchange back-ends all speak it.',
    'Verified contract sources, so a token page can show what a contract actually is.',
  ]) list.appendChild(el('li', null, item));
  want.appendChild(list);
  note(want, 'This list is docs/listing-checklist.md §3, unchanged. Every one of them is still open.', 'mute');
  root.appendChild(want);
}

// ---- the fixture gallery ---------------------------------------------------

export async function gallery(root, TOUR) {
  const c = card('Fixture gallery', { aside: badge('canned data', 'warn') });
  note(c, 'Every view, every state, rendered from canned JSON-RPC responses with no chain running. '
    + 'The failure states are the point: they are most of what a real explorer shows and they are '
    + 'what a demo skips.');

  const group = (title, items) => {
    const g = el('div', 'x-gal');
    g.appendChild(el('h4', null, title));
    const ul = el('ul', 'x-list');
    for (const [href, label, why] of items) {
      const li = el('li');
      li.appendChild(link(href, label, 'x-link'));
      if (why) li.appendChild(el('span', 'x-mute', ' — ' + why));
      ul.appendChild(li);
    }
    g.appendChild(ul);
    c.appendChild(g);
  };

  const t = TOUR;
  group('Blocks', [
    ['#/', 'Home', 'stats, latest blocks, latest transactions'],
    ['#/blocks', 'Block list', 'paged'],
    ['#/block/' + t.blocks.withTxs, 'Block with transactions', 'gas meter, roots, bloom'],
    ['#/block/' + t.blocks.empty, 'Empty block', 'the tip — most blocks are empty'],
    ['#/block/999999', 'A block that does not exist', 'not-found state'],
  ]);
  group('Transactions', [
    ['#/tx/' + t.txs.send, 'Plain EMBER transfer', 'success, no input data, no logs'],
    ['#/tx/' + t.txs.erc20, 'ERC-20 transfer', 'one decoded Transfer log'],
    ['#/tx/' + t.txs.swap, 'A swap', 'four logs: two Transfers, Sync, Swap'],
    ['#/tx/' + t.txs.wrap, 'Wrapping EMBER', 'Deposit plus a mint from the zero address'],
    ['#/tx/' + t.txs.deploy, 'Contract creation', 'to is null; the created address is on the receipt'],
    ['#/tx/' + t.txs.revert, 'A REVERTED transaction', 'status 0x0 with a decoded Error(string) reason'],
    ['#/tx/' + t.txs.panic, 'A transaction that panicked', 'Panic(0x11), arithmetic overflow'],
    ['#/tx/' + t.txs.pending, 'A pending transaction', 'in the mempool: null receipt, null block'],
    ['#/tx/' + t.txs.unknown, 'A transaction that does not exist', 'not-found state'],
  ]);
  group('Addresses and contracts', [
    ['#/address/' + t.addresses.alice, 'An active EOA', 'balance, nonce, token balances, transfers'],
    ['#/address/' + t.addresses.dead, 'An address with no history', 'zero everything — a valid answer'],
    ['#/address/' + t.addresses.usdf, 'A token contract', 'code size, code hash, selectors, disassembly'],
    ['#/address/' + t.addresses.proxy, 'A contract with no selectors', 'an EIP-1167 minimal proxy; no verified source'],
  ]);
  group('Tokens, logs, supply', [
    ['#/tokens', 'Tokens', 'detected from the standard Transfer topic'],
    ['#/token/' + t.addresses.usdf, 'A token', 'metadata, holders sampled, transfers'],
    ['#/logs?event=Transfer(address,address,uint256)', 'Log search', 'by event signature'],
    ['#/logs?address=' + t.addresses.pair + '&event=Sync(uint112,uint112)', 'Log search by address + topic', ''],
    ['#/supply', 'Supply', 'both figures, and the one not to publish'],
  ]);
  group('When things are broken', [
    ['?fixtures=down#/', 'An unreachable node', 'no invented data, and it says why'],
    ['?rpc=http://127.0.0.1:1#/', 'A wrong RPC URL', 'a real connection failure against a dead port'],
  ]);
  root.appendChild(c);
}
