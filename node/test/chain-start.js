'use strict';
/* The chain's start is block 1, and nothing subtracts genesis. Run: node test/chain-start.js
 *
 * cloudsforge-online/micro-org#396. A marketing draft nearly published "13,216 blocks in 421.8
 * days — a realised average block time of ~46 minutes against a 15 s target, 0.5% of a continuous
 * chain." Every number in it was wrong and the chain was fine. The genesis timestamp EMBER carries
 * (1750000000, 2025-06-15T15:06:40Z) is a hand-picked round number, fixed so every node derives the
 * same genesis hash — `src/chain/genesis.js` says so at the line that sets it, and that reason is
 * correct. Block 1 was mined 2026-08-04T19:12:21Z, 415 days later. So `tip.timestamp -
 * genesis.timestamp` overstates the chain's age by 415 days, and it does it in the direction that
 * reads like the difficulty-floor problem in micro-org#363, which is real. A reader who knows about
 * #363 believes it.
 *
 * WHAT MAKES THIS WORTH A SUITE RATHER THAN A COMMENT. The wrong number is not merely wrong, it is
 * PLAUSIBLE, it is arrived at by the most natural subtraction available, and there is no failure
 * anywhere when somebody makes it — no exception, no NaN, no negative. Nothing but a person
 * noticing. The three groups below are, in order: the one source, the way it is exposed, and a scan
 * that fails if anything in this tree reaches for the subtraction again.
 *
 * THE THIRD GROUP IS THE ONE THAT MATTERS IN A YEAR. The first two assert that a correct API
 * exists; only the scan asserts that the incorrect one is not being used, which is the actual
 * defect — the chain always had block 1, and every consumer could always have read it.
 */

const fs = require('fs');
const path = require('path');
const C = require('./evm-common');
const { EvmNode } = require('../src/evmnode');
const { JsonRpcServer } = require('../src/jsonrpc/server');

const T = C.harness('Hearth — the chain started at block 1 (micro-org#396)');
const { ok, eq, group } = T;

const miner = C.testKey('chain-start-miner');

/* A genesis timestamp with EMBER's shape: a round number, far in the past, that no miner ever
 * produced. The point of the fixture is the GAP between it and block 1 — if the two were close,
 * every assertion below would pass under the broken arithmetic too. */
const GENESIS_TS = 1750000000;

const newNode = () => new EvmNode({
  quiet: true,
  coinbaseKey: miner,
  genesis: { alloc: {}, target: C.EASY_TARGET, timestamp: GENESIS_TS },
});

(async () => {
  // -------------------------------------------------------------------------
  group('one source, on the chain itself');
  // -------------------------------------------------------------------------
  {
    const n = newNode();

    eq(n.chain.config.timestamp, GENESIS_TS, 'the genesis timestamp is the fixed constant');
    eq(n.chain.height, 0, 'and the chain holds nothing but genesis');
    eq(n.chain.launchedAt(), null,
      'launchedAt() is NULL before block 1 — a chain that has not started has no start, and a '
      + 'default here would be the whole defect one layer down');

    n.onMinedBlock(C.mine(n).block);
    const first = n.chain.entryAt(1).block.header.timestamp;

    eq(n.chain.launchedAt(), first, 'once block 1 exists, launchedAt() is its timestamp');
    ok(n.chain.launchedAt() !== GENESIS_TS, 'which is not the genesis timestamp');
    ok(n.chain.launchedAt() - GENESIS_TS > 365 * 24 * 3600,
      'and the gap between them is over a year — the 415 days #396 was wrong by');

    n.onMinedBlock(C.mine(n).block);
    n.onMinedBlock(C.mine(n).block);
    eq(n.chain.height, 3, 'three blocks on');
    eq(n.chain.launchedAt(), first,
      'the start does not move as the chain grows — it is block 1, not the oldest block still held');
  }

  // -------------------------------------------------------------------------
  group('exposed over JSON-RPC, so no consumer has to infer it');
  // -------------------------------------------------------------------------
  {
    const n = newNode();
    const srv = new JsonRpcServer({ chain: n.rpcChain });
    const call = (m, p = []) => srv.methods[m](p, { remote: 'test' });

    ok(typeof srv.methods.hearth_chainStart === 'function', 'hearth_chainStart is registered');
    ok(!srv.methods.eth_chainStart,
      'under hearth_ and not eth_: a client finding an unknown eth_ method has been lied to about '
      + 'which chain it is talking to');

    {
      const r = await call('hearth_chainStart');
      eq(r.launchedAt, null, 'before block 1 the answer is null, not a substitute');
      eq(r.genesisTimestamp, '0x' + GENESIS_TS.toString(16),
        'and the genesis timestamp rides along, so the caller can see what it must NOT subtract');
      eq(r.height, '0x0', 'with the height it was answered at');
    }

    n.onMinedBlock(C.mine(n).block);
    const first = n.chain.entryAt(1).block.header.timestamp;

    {
      const r = await call('hearth_chainStart');
      eq(r.launchedAt, '0x' + first.toString(16), 'after block 1 it is block 1, hex-quantity encoded');
      eq(r.launchHeight, '0x1', 'and it says which height that is, rather than leaving it folklore');
      ok(r.launchedAt !== r.genesisTimestamp, 'the two are different values in the same response');

      /* The response is the whole answer in one call ON PURPOSE. A consumer told only when the
       * chain started learns nothing about the trap; one that must make a second call to find the
       * genesis figure will instead make the subtraction it already knows how to make. */
      eq(Object.keys(r).sort().join(','), 'genesisTimestamp,height,launchHeight,launchedAt',
        'four fields, one round trip');
    }

    await new Promise(r => setImmediate(r));
  }

  // -------------------------------------------------------------------------
  group('and in /info, which is the response the estate already fetches');
  // -------------------------------------------------------------------------
  {
    /* The JSON-RPC method is the correct API; THIS is the one that closes #396. The network page,
     * status and the explorer all read /info, and a consumer that must learn a new method to get
     * the start will go on computing it from what it already has. */
    const n = newNode();

    eq(n.info().launchedAt, null, '/info reports null before block 1');
    eq(n.info().genesisTimestamp, GENESIS_TS, 'and names the genesis timestamp as such');

    n.onMinedBlock(C.mine(n).block);
    const first = n.chain.entryAt(1).block.header.timestamp;
    eq(n.info().launchedAt, first, 'and block 1 once there is one');
    ok(n.info().launchedAt !== n.info().genesis,
      'launchedAt is a time, not the genesis hash — different fields, no chance of confusion');
    ok(!Object.prototype.hasOwnProperty.call(n.info(), 'age'),
      'no derived age is published: the subtraction is the consumer\'s to make, correctly, and a '
      + 'figure computed here would go stale between the fetch and the render');
  }

  // -------------------------------------------------------------------------
  group('nothing in this tree subtracts a genesis timestamp to produce a duration');
  // -------------------------------------------------------------------------
  {
    /* The scan that would have stopped #396. It reads SOURCE, not behaviour, because the broken
     * arithmetic has no behaviour to observe — it produces a number, and the number is plausible.
     *
     * Comments and string literals are stripped first: this file's own prose quotes the
     * subtraction it forbids, and so does genesis.js's warning, and a check that fires on its own
     * documentation gets deleted rather than fixed. */
    const strip = src => src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
      .replace(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g, '""');

    const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(d => {
      const p = path.join(dir, d.name);
      if (d.isDirectory()) return d.name === 'node_modules' ? [] : walk(p);
      return d.isFile() && p.endsWith('.js') ? [p] : [];
    });

    /* Both directions, because `a - b` and `b - a` are equally wrong and the second is what
     * somebody writes when computing "how long ago". `-(?!-)` so a decrement is not a hit. */
    const GENESIS_TERM = String.raw`[\w$.]*(?:[Gg]enesis|GENESIS)[\w$.]*?\s*(?:\.\s*timestamp|Timestamp|_TIMESTAMP)`;
    const FORBIDDEN = [
      new RegExp(String.raw`-\s*\(?\s*${GENESIS_TERM}`),
      new RegExp(String.raw`${GENESIS_TERM}\s*\)?\s*-(?!-)`),
      /-\s*\(?\s*1750000000\b/,
      /\b1750000000\s*\)?\s*-(?!-)/,
    ];

    const roots = [path.join(__dirname, '..', 'src'), path.join(__dirname, '..', 'bin')]
      .filter(p => fs.existsSync(p));
    const files = roots.flatMap(walk);

    ok(files.length > 50, `the scan found ${files.length} source files, so it is looking at the tree`);

    const hits = [];
    for (const f of files) {
      const code = strip(fs.readFileSync(f, 'utf8'));
      for (const re of FORBIDDEN) {
        const m = code.match(re);
        if (m) hits.push(`${path.relative(path.join(__dirname, '..'), f)}: ${m[0].trim()}`);
      }
    }
    ok(hits.length === 0, `no source subtracts a genesis timestamp\n      ${hits.join('\n      ')}`);

    /* The scan is only worth having if it can fire. */
    const canary = strip('const ageDays = (tip.timestamp - genesis.timestamp) / 86400;');
    ok(FORBIDDEN.some(re => re.test(canary)), 'and the scan catches the exact line #396 was about');
    const canary2 = strip('const uptime = Date.now() / 1000 - GENESIS_TIMESTAMP;');
    ok(FORBIDDEN.some(re => re.test(canary2)), 'including the constant-named form of it');
    const decrement = strip('for (let genesisTimestamp = 5; genesisTimestamp > 0; genesisTimestamp--) {}');
    ok(!FORBIDDEN.some(re => re.test(decrement)), 'and a decrement is not a subtraction');
  }

  // -------------------------------------------------------------------------
  group('the genesis literal carries its own warning');
  // -------------------------------------------------------------------------
  {
    /* Not prose for its own sake: the reason the timestamp is fixed was already written at that
     * line, the CONSEQUENCE for arithmetic was not, and the next person to compute an age reads
     * the definition before they read this file. */
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'chain', 'genesis.js'), 'utf8');
    const at = src.indexOf('timestamp: 1750000000');
    ok(at > 0, 'the literal is where it was');
    const preceding = src.slice(Math.max(0, at - 2000), at);
    ok(/NOT when the chain started|not the launch/i.test(preceding),
      'and the comment above it says it is not the launch time');
    ok(/396/.test(preceding), 'with a pointer to micro-org#396');
    ok(/launchedAt/.test(preceding), 'and names what to read instead');
  }

  T.done();
})().catch(e => { console.error(e); process.exit(1); });
