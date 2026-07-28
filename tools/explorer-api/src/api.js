'use strict';
/* ============================================================================
 * THE ETHERSCAN-COMPATIBLE /api SURFACE
 * ============================================================================
 *
 * CoinGecko, CoinMarketCap, portfolio trackers, tax tools and several exchange
 * back-ends all speak this shape. It is the de-facto standard, and the reason
 * it is worth more than a prettier explorer is that not having it means manual
 * data submission and no automated supply verification
 * (docs/listing-checklist.md §3).
 *
 * THE ENVELOPE IS LOAD-BEARING. Clients STRING-MATCH `status`:
 *
 *     { "status": "1", "message": "OK",                    "result": <payload> }
 *     { "status": "0", "message": "No transactions found", "result": [] }
 *     { "status": "0", "message": "NOTOK",                 "result": "<why>" }
 *
 * `status` is the STRING "1" or "0", never a number and never a boolean. Every
 * numeric field in a result row is a DECIMAL STRING — Etherscan has always
 * done this, JavaScript clients depend on it (a wei value does not survive
 * `JSON.parse` as a Number), and emitting an actual number breaks them.
 * `module=proxy` is the sole exception: it returns raw JSON-RPC, because that
 * is what Etherscan does and what its clients parse.
 *
 * WHERE WE DELIBERATELY DIFFER FROM ETHERSCAN — all four are in the README:
 *
 *   1. `txlistinternal` REFUSES rather than returning an empty list, unless the
 *      node exposes a call tracer. Hearth's v1 RPC has no `debug_*` or
 *      `trace_*` (docs/exchange-integration.md §5.2), so internal transfers
 *      are not merely absent from the index — they are unknowable. An empty
 *      list would be a claim that there are none.
 *   2. Address queries REFUSE while the index is behind the node, for the same
 *      reason: "no transactions found" and "I have not looked yet" must not
 *      look identical.
 *   3. `offset` defaults to 100 and caps at 1,000, not 10,000 — rows are
 *      hydrated from the node rather than stored.
 *   4. `logIndex` and `transactionIndex` are emitted as canonical `0x0`.
 *      Etherscan emits `0x` for zero, which is not valid QUANTITY hex and
 *      which strict decoders reject.
 */

const { KIND } = require('./store');
const { formatEmber } = require('./supply');

// ---- the envelope ----------------------------------------------------------

const OK = result => ({ status: '1', message: 'OK', result });
const NONE = (message, result = []) => ({ status: '0', message, result });
const NOTOK = why => ({ status: '0', message: 'NOTOK', result: why });

/** Thrown by a handler to produce a NOTOK envelope with a specific reason. */
class ApiError extends Error {}
const refuse = why => { throw new ApiError(why); };

// ---- parameter parsing -----------------------------------------------------

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const HASH_RE = /^0x[0-9a-fA-F]{64}$/;

function wantAddress(q, name = 'address') {
  const v = (q.get(name) || '').trim();
  if (!ADDR_RE.test(v)) refuse('Error! Invalid address format');
  return v.toLowerCase();
}

function wantHash(q, name = 'txhash') {
  const v = (q.get(name) || '').trim();
  if (!HASH_RE.test(v)) refuse('Error! Invalid transaction hash format');
  return v.toLowerCase();
}

/** Etherscan accepts decimal, `latest`, `earliest`, and 0x hex. */
function blockTag(v, fallback) {
  if (v === undefined || v === null || v === '') return fallback;
  const s = String(v).trim().toLowerCase();
  if (s === 'latest' || s === 'pending') return fallback;
  if (s === 'earliest') return 0;
  const n = s.startsWith('0x') ? Number(BigInt(s)) : Number(s);
  if (!Number.isInteger(n) || n < 0) refuse(`Error! Invalid block number ${v}`);
  return n;
}

const qhex = n => '0x' + BigInt(n).toString(16);
const dec = v => (v === null || v === undefined ? '' : BigInt(v).toString());

class Api {
  constructor({ env, store, indexer, rpc, hydrator, supply, verify }) {
    this.env = env;
    this.store = store;
    this.indexer = indexer;
    this.rpc = rpc;
    this.hydrator = hydrator;
    this.supply = supply;
    this.verify = verify;
  }

  /**
   * @param {URLSearchParams} q
   * @returns {Promise<object>} the body to serialise
   */
  async handle(q) {
    if (this.env.requireApiKey && q.get('apikey') !== this.env.requireApiKey) {
      return NOTOK('Error! Invalid API Key');
    }
    const module = (q.get('module') || '').toLowerCase();
    const action = q.get('action') || '';
    try {
      switch (module) {
        case 'account': return await this.account(action.toLowerCase(), q);
        case 'contract': return await this.contract(action.toLowerCase(), q);
        case 'stats': return await this.stats(action.toLowerCase(), q);
        case 'transaction': return await this.transaction(action.toLowerCase(), q);
        case 'logs': return await this.logs(action.toLowerCase(), q);
        case 'proxy': return await this.proxy(action, q);
        case '': return NOTOK('Error! Missing Or invalid Module name');
        default: return NOTOK(`Error! Missing Or invalid Module name (${module})`);
      }
    } catch (e) {
      if (e instanceof ApiError) return NOTOK(e.message);
      return NOTOK(`Error! ${String(e.message || e)}`);
    }
  }

  // ---- shared ---------------------------------------------------------------

  /** Refuse address queries while the index has not caught up. See §2 above. */
  _requireIndex() {
    if (this.indexer.parked) {
      refuse(`Error! The index has stopped: ${this.indexer.parked}`);
    }
    const lag = this.indexer.lag;
    if (lag === null) refuse('Error! The index has not reached the node yet');
    if (lag > this.env.maxLagBlocks) {
      const head = this.store.headNumber;
      refuse(
        `Error! The index is ${lag} blocks behind the node and would report an incomplete answer. `
        + `Indexed ${this.store.startBlock}..${head === null ? '(nothing)' : head}, node head `
        + `${this.indexer.stats().nodeHead}. Retry when /health reports ok.`,
      );
    }
  }

  _paging(q) {
    const page = Math.max(1, Number(q.get('page') || 1) || 1);
    let offset = Number(q.get('offset') || this.env.defaultOffset) || this.env.defaultOffset;
    if (offset > this.env.maxOffset) offset = this.env.maxOffset;
    if (offset < 1) offset = 1;
    const desc = String(q.get('sort') || 'asc').toLowerCase() === 'desc';
    return { skip: (page - 1) * offset, limit: offset, desc };
  }

  _range(q) {
    const head = this.store.headNumber === null ? 0 : this.store.headNumber;
    return {
      fromBlock: blockTag(q.get('startblock'), this.store.startBlock),
      toBlock: blockTag(q.get('endblock'), head),
      head,
    };
  }

  // ---- module=account -------------------------------------------------------

  async account(action, q) {
    switch (action) {
      case 'balance': {
        const addr = wantAddress(q);
        const tag = q.get('tag') || 'latest';
        return OK(dec(await this.rpc.getBalance(addr, tag === 'pending' ? 'latest' : tag)));
      }

      case 'balancemulti': {
        const raw = (q.get('address') || '').split(',').map(s => s.trim()).filter(Boolean);
        if (raw.length === 0) refuse('Error! Invalid address format');
        if (raw.length > 20) refuse('Error! Max 20 addresses per request');
        for (const a of raw) if (!ADDR_RE.test(a)) refuse('Error! Invalid address format');
        const tag = q.get('tag') || 'latest';
        const out = await this.rpc.batch(raw.map(a => ({
          method: 'eth_getBalance', params: [a.toLowerCase(), tag === 'pending' ? 'latest' : tag],
        })));
        return OK(raw.map((a, i) => ({
          account: a,
          balance: out[i].ok ? dec(out[i].result) : '',
          ...(out[i].ok ? {} : { error: out[i].error.message }),
        })));
      }

      case 'txlist': return await this.txlist(q, false);
      case 'txlistinternal': return await this.txlistinternal(q);
      case 'tokentx': return await this.tokentx(q, false);
      case 'tokennfttx': return await this.tokentx(q, true);

      default:
        return NOTOK(`Error! Missing Or invalid Action name (module=account&action=${action})`);
    }
  }

  async txlist(q) {
    this._requireIndex();
    const addr = wantAddress(q);
    const { fromBlock, toBlock, head } = this._range(q);
    const { skip, limit, desc } = this._paging(q);
    const postings = this.store.scan(addr.slice(2), {
      kinds: [KIND.TX], fromBlock, toBlock, desc, skip, limit,
    });
    if (postings.length === 0) return NONE('No transactions found');

    const rows = [];
    for (const p of postings) {
      const entry = await this.hydrator.block(p.block);
      if (!entry) continue;
      const tx = entry.block.transactions[p.txIndex];
      const receipt = entry.receipts[p.txIndex];
      if (!tx) continue;
      rows.push(this._txRow(entry.block, tx, receipt, p.txIndex, head));
    }
    return rows.length ? OK(rows) : NONE('No transactions found');
  }

  _txRow(block, tx, receipt, txIndex, head) {
    const n = Number(BigInt(block.number));
    const success = !receipt || receipt.status === undefined || BigInt(receipt.status || '0x0') === 1n;
    const input = tx.input || '0x';
    return {
      blockNumber: String(n),
      timeStamp: dec(block.timestamp),
      hash: tx.hash,
      nonce: dec(tx.nonce),
      blockHash: block.hash,
      transactionIndex: String(txIndex),
      from: tx.from,
      to: tx.to || '',
      value: dec(tx.value),
      gas: dec(tx.gas),
      gasPrice: dec(tx.gasPrice),
      /* isError is "1" when the transaction REVERTED. It is not an RPC error:
       * a reverted transaction is included, consumes gas and moves no value
       * (docs/exchange-integration.md §5.1). Anything crediting deposits must
       * read this, and it is the single most-missed field in the shape. */
      isError: success ? '0' : '1',
      txreceipt_status: receipt ? (success ? '1' : '0') : '',
      input,
      contractAddress: (receipt && receipt.contractAddress) || '',
      cumulativeGasUsed: receipt ? dec(receipt.cumulativeGasUsed) : '',
      gasUsed: receipt ? dec(receipt.gasUsed) : '',
      confirmations: String(Math.max(0, head - n)),
      methodId: input.length >= 10 ? input.slice(0, 10) : '0x',
      /* Empty, always. Resolving a selector to `transfer(address,uint256)`
       * needs a signature database we do not have and will not invent — a
       * wrong function name on an explorer page is worse than none. */
      functionName: '',
    };
  }

  async txlistinternal(q) {
    if (!this.indexer.tracing) {
      /* Rule 1 at the top of this file. This is the one place where matching
       * Etherscan exactly would mean lying: `{"status":"0","message":"No
       * transactions found"}` asserts that this address received no internal
       * transfers, and we cannot know that. */
      return NOTOK(
        'Error! Internal transactions are not indexed on this chain. They can only be derived from '
        + 'execution traces, and this node exposes no debug_traceTransaction / trace_block — neither is '
        + 'in the v1 RPC surface (docs/exchange-integration.md §5.2, docs/evm-spec.md §6). This endpoint '
        + 'refuses rather than returning an empty list, because an empty list would assert that there '
        + 'are none. Value moved by a contract CALL or SELFDESTRUCT is invisible here.',
      );
    }
    this._requireIndex();
    const addr = wantAddress(q);
    const { fromBlock, toBlock, head } = this._range(q);
    const { skip, limit, desc } = this._paging(q);
    const postings = this.store.scan(addr.slice(2), {
      kinds: [KIND.INTERNAL], fromBlock, toBlock, desc, skip, limit,
    });
    if (postings.length === 0) return NONE('No transactions found');
    const rows = [];
    for (const p of postings) {
      const entry = await this.hydrator.block(p.block);
      if (!entry) continue;
      const tx = entry.block.transactions[p.txIndex];
      if (!tx) continue;
      const trace = await this.rpc.traceTransaction(tx.hash).catch(() => null);
      const frame = trace ? frameAt(trace, p.subIndex) : null;
      if (!frame) continue;
      rows.push({
        blockNumber: String(p.block),
        timeStamp: dec(entry.block.timestamp),
        hash: tx.hash,
        from: frame.from || '',
        to: frame.to || '',
        value: frame.value ? dec(frame.value) : '0',
        contractAddress: /CREATE/i.test(String(frame.type || '')) ? (frame.to || '') : '',
        input: frame.input || '',
        type: String(frame.type || '').toLowerCase(),
        gas: frame.gas ? dec(frame.gas) : '',
        gasUsed: frame.gasUsed ? dec(frame.gasUsed) : '',
        traceId: String(p.subIndex),
        isError: frame.error ? '1' : '0',
        errCode: frame.error ? String(frame.error) : '',
        confirmations: String(Math.max(0, head - p.block)),
      });
    }
    return rows.length ? OK(rows) : NONE('No transactions found');
  }

  async tokentx(q, nft) {
    this._requireIndex();
    const addr = q.get('address') ? wantAddress(q) : null;
    const contract = q.get('contractaddress') ? wantAddress(q, 'contractaddress') : null;
    if (!addr && !contract) refuse('Error! Supply address, contractaddress, or both');
    const { fromBlock, toBlock, head } = this._range(q);
    const { skip, limit, desc } = this._paging(q);

    /* Keyed by the PARTICIPANT when we have one, because that is the selective
     * side: a token contract has every transfer, an address has its own. When
     * only a contract is given we key by the contract's own log postings. */
    const postings = addr
      ? this.store.scan(addr.slice(2), { kinds: [KIND.TOKEN], fromBlock, toBlock, desc, skip: 0, limit: Infinity })
      : this.store.scan(contract.slice(2), { kinds: [KIND.LOG], fromBlock, toBlock, desc, skip: 0, limit: Infinity });

    const rows = [];
    let seen = 0;
    for (const p of postings) {
      const entry = await this.hydrator.block(p.block);
      if (!entry) continue;
      const receipt = entry.receipts[p.txIndex];
      const tx = entry.block.transactions[p.txIndex];
      if (!receipt || !tx) continue;
      const found = entry.logs.find(l => l.blockLogIndex === p.subIndex);
      const log = found && found.log;
      if (!log) continue;
      if (contract && log.address.toLowerCase() !== contract) continue;
      const topics = log.topics || [];
      const isNft = topics.length === 4;
      if (isNft !== !!nft) continue;
      if (seen++ < skip) continue;

      const meta = await this.hydrator.tokenMeta(log.address);
      const from = '0x' + topics[1].slice(26);
      const to = '0x' + topics[2].slice(26);
      const row = {
        blockNumber: String(p.block),
        timeStamp: dec(entry.block.timestamp),
        hash: tx.hash,
        nonce: dec(tx.nonce),
        blockHash: entry.block.hash,
        from,
        contractAddress: log.address.toLowerCase(),
        to,
        ...(isNft ? { tokenID: dec(topics[3]) } : { value: dec(log.data === '0x' ? '0x0' : log.data.slice(0, 66)) }),
        tokenName: meta.name,
        tokenSymbol: meta.symbol,
        tokenDecimal: isNft ? '0' : meta.decimals,
        transactionIndex: String(p.txIndex),
        gas: dec(tx.gas),
        gasPrice: dec(tx.gasPrice),
        gasUsed: dec(receipt.gasUsed),
        cumulativeGasUsed: dec(receipt.cumulativeGasUsed),
        input: 'deprecated',
        confirmations: String(Math.max(0, head - p.block)),
        logIndex: String(p.subIndex),
      };
      rows.push(row);
      if (rows.length >= limit) break;
    }
    return rows.length ? OK(rows) : NONE('No transactions found');
  }

  // ---- module=contract ------------------------------------------------------

  async contract(action, q) {
    if (action !== 'getabi' && action !== 'getsourcecode') {
      return NOTOK(`Error! Missing Or invalid Action name (module=contract&action=${action})`);
    }
    const addr = wantAddress(q);
    const record = this.verify ? await this.verify.lookup(addr).catch(() => null) : null;

    if (action === 'getabi') {
      if (!record) return NOTOK('Contract source code not verified');
      return OK(JSON.stringify(record.abi));
    }

    if (action === 'getsourcecode') {
      /* Etherscan answers status "1" here even when nothing is verified, with
       * a single row of empty fields and the ABI field carrying the words
       * "Contract source code not verified". Clients branch on exactly that
       * string, so it is reproduced verbatim. */
      if (!record) {
        return OK([{
          SourceCode: '',
          ABI: 'Contract source code not verified',
          ContractName: '',
          CompilerVersion: '',
          OptimizationUsed: '',
          Runs: '',
          ConstructorArguments: '',
          EVMVersion: 'Default',
          Library: '',
          LicenseType: 'Unknown',
          Proxy: '0',
          Implementation: '',
          SwarmSource: '',
        }]);
      }
      return OK([{
        /* Etherscan's multi-file form: the standard-JSON input wrapped in one
         * extra pair of braces. Every client that supports multi-file
         * verification detects it by the `{{` prefix. */
        SourceCode: '{' + JSON.stringify(record.standardJsonInput) + '}',
        ABI: JSON.stringify(record.abi),
        ContractName: record.contractName,
        CompilerVersion: record.compilerVersion,
        OptimizationUsed: record.optimizationUsed ? '1' : '0',
        Runs: String(record.runs === null || record.runs === undefined ? '' : record.runs),
        ConstructorArguments: (record.constructorArguments || '').replace(/^0x/, ''),
        EVMVersion: record.evmVersion || 'Default',
        Library: record.libraries
          ? Object.entries(record.libraries).map(([k, v]) => `${k}:${String(v).replace(/^0x/, '')}`).join(';')
          : '',
        LicenseType: record.license || 'Unknown',
        Proxy: '0',
        Implementation: '',
        SwarmSource: '',
        /* Extensions, clearly named so nobody mistakes them for Etherscan's.
         * `MatchType` in particular must not be hidden: a partial match means
         * the metadata hash differs, which means the source is equivalent but
         * not byte-identical to what was compiled. */
        HearthMatchType: record.matchType,
        HearthVerifiedAt: record.verifiedAt,
        HearthConstructorArgumentsVerified: record.constructorArgumentsVerified ? '1' : '0',
      }]);
    }

    return NOTOK(`Error! Missing Or invalid Action name (module=contract&action=${action})`);
  }

  // ---- module=stats ---------------------------------------------------------

  async stats(action, q) {
    switch (action) {
      case 'ethsupply': {
        const s = await this.supply.read();
        // Etherscan's ethsupply is wei. So is this.
        return OK(s.totalWei.toString());
      }

      /** Extension. Etherscan has no circulating endpoint; aggregators need one. */
      case 'circulatingsupply': {
        const s = await this.supply.read();
        if (s.circulatingWei === null) return NOTOK('Error! ' + s.unavailable);
        return OK(s.circulatingWei.toString());
      }

      /** Extension, and the one an aggregator should actually read. */
      case 'supplybreakdown': {
        const s = await this.supply.read();
        return OK({
          height: String(s.height),
          totalSupplyWei: s.totalWei.toString(),
          totalSupplyEmber: formatEmber(s.totalWei),
          commonsTreasuryWei: s.commonsWei === null ? '' : s.commonsWei.toString(),
          commonsTreasuryEmber: s.commonsWei === null ? '' : formatEmber(s.commonsWei),
          circulatingSupplyWei: s.circulatingWei === null ? '' : s.circulatingWei.toString(),
          circulatingSupplyEmber: s.circulatingWei === null ? '' : formatEmber(s.circulatingWei),
          maxSupply: 'none (uncapped)',
          methodology: 'circulating = total − Commons treasury (docs/tokenomics.md §7)',
          unavailable: s.unavailable || '',
          source: s.source,
        });
      }

      case 'tokensupply': {
        const contract = wantAddress(q, 'contractaddress');
        try {
          return OK((await this.hydrator.totalSupply(contract)).toString());
        } catch (e) {
          return NOTOK(`Error! ${contract} did not answer totalSupply(): ${String(e.message || e)}`);
        }
      }

      default:
        return NOTOK(`Error! Missing Or invalid Action name (module=stats&action=${action})`);
    }
  }

  // ---- module=transaction ---------------------------------------------------

  async transaction(action, q) {
    if (action === 'getstatus') {
      /* Etherscan's getstatus reports CONTRACT EXECUTION status. A transaction
       * that is not mined yet has no status; the honest answer for one we
       * cannot find is an error, not "0" (which means "succeeded"). */
      const hash = wantHash(q);
      const receipt = await this.rpc.getTransactionReceipt(hash);
      if (!receipt) return NOTOK('Error! Transaction not found, or not yet mined');
      const failed = BigInt(receipt.status || '0x0') === 0n;
      return OK({ isError: failed ? '1' : '0', errDescription: failed ? 'Reverted' : '' });
    }

    if (action === 'gettxreceiptstatus') {
      const hash = wantHash(q);
      const receipt = await this.rpc.getTransactionReceipt(hash);
      if (!receipt) return NOTOK('Error! Transaction not found, or not yet mined');
      return OK({ status: BigInt(receipt.status || '0x0') === 1n ? '1' : '0' });
    }

    return NOTOK(`Error! Missing Or invalid Action name (module=transaction&action=${action})`);
  }

  // ---- module=logs ----------------------------------------------------------

  async logs(action, q) {
    if (action !== 'getlogs') {
      return NOTOK(`Error! Missing Or invalid Action name (module=logs&action=${action})`);
    }
    this._requireIndex();
    const head = this.store.headNumber === null ? 0 : this.store.headNumber;
    const fromBlock = blockTag(q.get('fromBlock') ?? q.get('fromblock'), this.store.startBlock);
    const toBlock = blockTag(q.get('toBlock') ?? q.get('toblock'), head);
    if (toBlock - fromBlock + 1 > this.env.maxLogRange) {
      refuse(`Error! Block range too wide (max ${this.env.maxLogRange})`);
    }
    const address = q.get('address') ? wantAddress(q) : null;
    const topics = [0, 1, 2, 3].map(i => {
      const v = q.get(`topic${i}`);
      if (!v) return null;
      if (!HASH_RE.test(v.trim())) refuse(`Error! Invalid topic${i}`);
      return v.trim().toLowerCase();
    });
    /* Etherscan's `topicX_Y_opr` says how two topic filters combine. `and` is
     * the default and the only one this serves — `or` across positions needs a
     * union of two index scans and no caller we have seen uses it. Refusing is
     * better than silently intersecting when they asked for a union. */
    for (const [k, v] of q.entries()) {
      if (/^topic\d_\d_opr$/.test(k) && String(v).toLowerCase() !== 'and') {
        refuse(`Error! ${k}=${v} is not supported; only 'and' is`);
      }
    }
    if (!address && !topics[0]) {
      refuse('Error! Supply an address, a topic0, or both');
    }
    const { skip, limit, desc } = this._paging(q);

    const key = address ? address.slice(2) : topics[0].slice(2);
    const kinds = address ? [KIND.LOG] : [KIND.TOPIC];
    const postings = this.store.scan(key, { kinds, fromBlock, toBlock, desc, skip: 0, limit: Infinity });

    const rows = [];
    let seen = 0;
    for (const p of postings) {
      const entry = await this.hydrator.block(p.block);
      if (!entry) continue;
      const receipt = entry.receipts[p.txIndex];
      if (!receipt) continue;
      const found = entry.logs.find(l => l.blockLogIndex === p.subIndex);
      const log = found && found.log;
      if (!log) continue;
      if (address && log.address.toLowerCase() !== address) continue;
      if (!topicsMatch(log.topics || [], topics)) continue;
      if (seen++ < skip) continue;
      const tx = entry.block.transactions[p.txIndex];
      rows.push({
        address: log.address.toLowerCase(),
        topics: log.topics || [],
        data: log.data || '0x',
        blockNumber: qhex(p.block),
        blockHash: entry.block.hash,
        timeStamp: qhex(BigInt(entry.block.timestamp)),
        gasPrice: tx ? qhex(BigInt(tx.gasPrice)) : '0x0',
        gasUsed: qhex(BigInt(receipt.gasUsed)),
        logIndex: qhex(p.subIndex),
        transactionHash: receipt.transactionHash,
        transactionIndex: qhex(p.txIndex),
      });
      if (rows.length >= limit) break;
    }
    return rows.length ? OK(rows) : NONE('No records found');
  }

  // ---- module=proxy ---------------------------------------------------------

  /**
   * A passthrough to `eth_*`, with Etherscan's parameter names.
   *
   * NOTE THE ENVELOPE CHANGES. This module answers raw JSON-RPC 2.0, exactly
   * as Etherscan does, because its clients hand the body straight to a
   * JSON-RPC parser. Wrapping it in {status,message,result} would break every
   * one of them.
   */
  async proxy(action, q) {
    const id = q.get('id') || '1';
    const envelope = body => ({ jsonrpc: '2.0', id, ...body });
    const P = {
      eth_blockNumber: () => [],
      eth_chainId: () => [],
      eth_gasPrice: () => [],
      eth_getBlockByNumber: () => [q.get('tag') || 'latest', String(q.get('boolean')).toLowerCase() === 'true'],
      eth_getBlockTransactionCountByNumber: () => [q.get('tag') || 'latest'],
      eth_getTransactionByHash: () => [wantHash(q)],
      eth_getTransactionByBlockNumberAndIndex: () => [q.get('tag') || 'latest', q.get('index') || '0x0'],
      eth_getTransactionCount: () => [wantAddress(q), q.get('tag') || 'latest'],
      eth_getTransactionReceipt: () => [wantHash(q)],
      eth_getCode: () => [wantAddress(q), q.get('tag') || 'latest'],
      eth_getStorageAt: () => [wantAddress(q), q.get('position') || '0x0', q.get('tag') || 'latest'],
      eth_sendRawTransaction: () => [q.get('hex')],
      eth_call: () => [{ to: q.get('to'), data: q.get('data') || '0x' }, q.get('tag') || 'latest'],
      eth_estimateGas: () => [{
        to: q.get('to') || undefined,
        data: q.get('data') || undefined,
        value: q.get('value') || undefined,
        gas: q.get('gas') || undefined,
        gasPrice: q.get('gasPrice') || undefined,
      }],
    };

    const method = action;
    let params;
    if (Object.prototype.hasOwnProperty.call(P, action)) {
      // A malformed address or hash is an invalid-params JSON-RPC error here,
      // not the {status,message,result} refusal the other modules use.
      try { params = P[action](); } catch (e) {
        return envelope({ error: { code: -32602, message: String(e.message || e) } });
      }
    } else if (q.get('params')) {
      /* Escape hatch: any v1 method with explicit JSON params. Etherscan has
       * no such thing, but a caller that needs eth_getLogs through the proxy
       * has nowhere else to go, and inventing more named-parameter mappings
       * would be guessing at a convention that does not exist. */
      if (!/^[a-z0-9_]+$/i.test(action)) return envelope({ error: { code: -32601, message: `invalid method ${action}` } });
      try { params = JSON.parse(q.get('params')); } catch {
        return envelope({ error: { code: -32602, message: 'params must be a JSON array' } });
      }
      if (!Array.isArray(params)) return envelope({ error: { code: -32602, message: 'params must be a JSON array' } });
    } else {
      return envelope({ error: { code: -32601, message: `the method ${action} is not exposed by module=proxy; pass params=<json array> to reach it` } });
    }

    try {
      return envelope({ result: await this.rpc.call(method, params) });
    } catch (e) {
      if (e instanceof ApiError) return envelope({ error: { code: -32602, message: e.message } });
      return envelope({ error: { code: e.code || -32603, message: String(e.message || e), ...(e.data ? { data: e.data } : {}) } });
    }
  }
}

/** Etherscan/eth_getLogs topic matching: null is a wildcard, position-wise. */
function topicsMatch(actual, filter) {
  for (let i = 0; i < 4; i++) {
    if (filter[i] === null) continue;
    if (!actual[i] || actual[i].toLowerCase() !== filter[i]) return false;
  }
  return true;
}

/** The nth frame of a callTracer trace, in the order indexer.js numbers them. */
function frameAt(root, n) {
  let seq = 0, found = null;
  const walk = f => {
    if (found || !f) return;
    if (seq === n) { found = f; return; }
    seq++;
    for (const c of f.calls || []) { walk(c); if (found) return; }
  };
  walk(root);
  return found;
}

module.exports = { Api, ApiError, OK, NONE, NOTOK, topicsMatch };
