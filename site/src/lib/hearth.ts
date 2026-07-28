// Central content + constants for the Hearth / EMBER marketing site.
// Pure marketing data — no backend calls. Every figure is sourced from the
// Hearth whitepaper, README and docs/coinnomics.md — nothing invented.

import { cloudsforgeHosts } from '@cloudsforge/ui'

// Resolve CloudsForge URLs from the current hostname at runtime (localhost in
// dev, *.cloudsforge.online in prod) so one build works everywhere.
const HOSTS = cloudsforgeHosts()
export const STUDIO_URL = HOSTS.site
export const PLAY_URL = HOSTS.play
/** The CloudsForge wallet — where EMBER becomes Shards and Shards get spent. */
export const FORGE_PAY_URL = HOSTS.wallet

/** The org, not a personal account: clicking "GitHub" must not leave CloudsForge. */
const REPO = 'https://github.com/cloudsforge-online/hearth'

export const HEARTH = {
  network: 'Hearth',
  coin: 'Ember',
  ticker: 'EMBER',
  tagline: 'Money Mined at Home',
  pitch: 'A people-mined, ASIC-resistant proof-of-work cryptocurrency built to spend, not hoard.',
  // Not "no pools": nothing in consensus prevents one (see MINING_POINTS below).
  // What is true is that there is no pool to sign up to and none is needed.
  sub: 'Mine EMBER on the computer you already own — no rig, no pool signup, no premine.',
  github: REPO,
  whitepaper: `${REPO}/blob/main/WHITEPAPER.md`,
  // The explorer is the root of the `explorer.` bundle now that the second,
  // unbranded marketing site it used to sit behind has been retired — so it no
  // longer needs a filename of its own.
  explorer: HOSTS.explorer,
  emberWallet: `${HOSTS.explorer}/wallet.html`,
  studio: 'CloudsForge',
} as const

/** Anchor sections for in-page nav. */
export const NAV_LINKS = [
  { to: '#why', label: 'Why Hearth' },
  { to: '#coin', label: 'The Coin' },
  { to: '#mining', label: 'Mining' },
  { to: '#loop', label: 'What it’s for' },
  { to: '#testnet', label: 'Testnet' },
] as const

/** Hero stat strip — all directly from the whitepaper / coinnomics constants. */
export const HERO_STATS = [
  { k: '15s', l: 'block time' },
  { k: 'CPU', l: 'memory-hard · ASIC-resistant' },
  { k: '0%', l: 'premine · fair launch' },
  { k: '10%', l: 'per block to the Commons' },
] as const

/**
 * "Why Hearth" — the problem/solution table from the README, verbatim in
 * substance. Each row: a big crypto problem and what Hearth does about it.
 */
export const WHY_ROWS = [
  {
    problem: 'Mining centralized into ASIC farms',
    solution:
      'Homefire PoW: memory-hard and CPU-friendly, so a farm earns little more per dollar than the laptop you already own. Work handed to you also cannot be redirected — the block pays the key that signed the proof.',
  },
  {
    problem: 'Coins behave like “gold” you hoard',
    solution:
      'Money-first coinnomics: disinflationary emission into a perpetual tail, offset by a fee burn. Net inflation trends toward ~0%. Built for velocity.',
  },
  {
    problem: 'Slow & expensive to pay with',
    solution:
      '15-second blocks and a sub-cent fee that is burned rather than auctioned. Tab payment channels for instant retail settlement are a signed state machine in the Rust core today, not yet a thing you can spend through.',
  },
  {
    problem: 'The “fee cliff” — security dies when rewards end',
    solution: 'Perpetual tail emission funds security forever, so it never rests on a fragile fee-only market.',
  },
  {
    problem: 'Development captured by VCs & premines',
    solution: 'Fair launch with no premine, plus an on-chain Commons treasury — 10% of every block, community-governed.',
  },
  {
    problem: 'Too hard for normal humans',
    solution:
      'A web wallet and a browser miner that need nothing installed, a live block explorer, and a reference node that is a full node, a wallet and a miner in one process.',
  },
] as const

/** "The coin" — spec facts. Sourced from README + coinnomics.md + evm-spec.md. */
export const COIN_FACTS = [
  { k: 'Network', v: 'Hearth' },
  { k: 'Coin', v: 'Ember' },
  { k: 'Ticker', v: 'EMBER' },
  // 18, not the 8 this said for a year. The "spark" was the UTXO chain's
  // smallest unit and that chain is retired; on the account model the unit is a
  // wei and 1 EMBER = 1e18 of them (docs/evm-spec.md §1, node/src/params.js
  // WEI_PER_EMBER). Publishing 8 here is not a rounding difference — it is the
  // number a wallet or an exchange would scale raw amounts by, wrong by 1e10.
  { k: 'Smallest unit', v: '1 EMBER = 10¹⁸ wei (18 decimals)' },
  { k: 'Block time', v: '15 seconds' },
  { k: 'Proof of work', v: 'Homefire — memory-hard, CPU-friendly, ASIC-resistant' },
  { k: 'Emission', v: 'Halving-free decay → perpetual tail' },
  { k: 'Commons share', v: '10% of every block reward' },
  { k: 'Base fee', v: 'Burned on every transaction' },
  { k: 'Supply', v: 'Uncapped but disinflationary' },
] as const

/**
 * Illustrative emission rows from docs/coinnomics.md (the smooth model in
 * proto/emission.js). Presented as-is, labelled as modeled — not a promise.
 */
export const EMISSION_ROWS = [
  { yr: '1', reward: '4.24', issued: '10,667,873', burned: '1,133,462', supply: '9,534,412', net: '100.00' },
  { yr: '5', reward: '1.06', issued: '2,666,968', burned: '1,416,827', supply: '22,527,372', net: '5.55' },
  { yr: '10', reward: '0.30', issued: '631,152', burned: '536,479', supply: '23,890,811', net: '0.40' },
  { yr: '30', reward: '0.30', issued: '631,152', burned: '536,479', supply: '25,784,267', net: '0.37' },
] as const

/**
 * Mining — what Homefire actually does, checked against node/src/pow.js.
 *
 * These four claims used to overstate it in two ways worth remembering, because
 * both are easy to write again. Homefire does not compile a program per nonce
 * the way RandomX does — it is chained SHA-256 over a scratchpad — and it is not
 * non-outsourceable: pow.js binds only the coinbase PUBLIC key into the seed, so
 * a pool operator can hand out work under its own key and sign the blocks
 * itself. What is true is that work handed to a hasher cannot be redirected by
 * that hasher, which is a real property and a smaller one.
 */
export const MINING_POINTS = [
  {
    title: 'Memory-hard, not compute-only',
    body: 'Every nonce fills a 64 KiB scratchpad with chained SHA-256, then takes a pseudo-random walk that reads and rewrites it, and derives the digest from the whole pad. Memory latency is the bottleneck, not gate count — which is what keeps commodity CPUs close to fair value and blunts the advantage a farm can buy.',
  },
  {
    title: 'Your work cannot be redirected',
    body: 'The proof has to be Ed25519-signed by the key the coinbase pays, so a block you find can only ever pay you. That stops your work being stolen; it does not make mining impossible to pool, and we would rather say so than imply otherwise.',
  },
  {
    title: 'Polite mining',
    body: 'The effort slider is a real duty cycle — the workers sleep through the rest of it — a background tab drops to a trickle, and in browsers that report power state the miner pauses the moment you unplug. Money mined in the background of the computer you already own, with the fans staying quiet.',
  },
  {
    title: 'One app',
    body: 'The reference node is a full node, a wallet and a miner in one process, and the browser miner is the same proof-of-work in a tab. No stratum config, no pool signup, no separate wallet.',
  },
] as const

/**
 * What EMBER is FOR — the mine → convert → spend loop across CloudsForge.
 * Every step here is a thing that exists in code today; the honest status of
 * the whole loop is stated alongside it in TheLoop, and stays consistent with
 * the pre-mainnet caveat in Testnet.
 */
export const LOOP_STEPS = [
  {
    verb: 'Mine',
    where: 'Hearth',
    body: 'Homefire runs on the CPU you already own, politely, in the background. Blocks pay a wallet whose key is generated on your device and never leaves it.',
  },
  {
    verb: 'Hold',
    where: 'Your wallet, or ours',
    // The address shape and the key scheme both moved with the account-model
    // rebuild: `0x…` EIP-55 over secp256k1, not `ember1…` over Ed25519. An
    // Ed25519 key names no account on an EVM chain, so the old sentence told a
    // reader to expect a deposit address that can no longer exist.
    body: 'Keep your own key in the web wallet, or deposit to a custodied 0x… address. CloudsForge custodies EMBER with hearthd’s own secp256k1 scheme rather than a second one it invented.',
  },
  {
    verb: 'Convert',
    where: 'Forge Pay',
    body: 'Forge Pay watches the Hearth chain and converts EMBER into Shards — the single unit every CloudsForge product bills in. One wallet per account, not one per product.',
  },
  {
    verb: 'Spend',
    where: 'Everything else we make',
    body: 'Trading fees in Crucible, token deploys in ForgeMint, cosmetics and worlds in Games. The money you mined at home pays for the things next door to it.',
  },
] as const

/** Testnet quick-start. From README "Try it now" + the shipped compose file. */
export const TESTNET_NODES = [
  { name: 'node-a', rpc: 'http://localhost:8645' },
  { name: 'node-b', rpc: 'http://localhost:8647' },
  { name: 'node-c', rpc: 'http://localhost:8649' },
] as const

export const TESTNET_BOOT = 'docker compose -f hearth/docker-compose.testnet.yml up --build'
export const TESTNET_QUERY = 'curl localhost:8645/info'
export const TESTNET_SUPPLY = 'curl localhost:8645/supply'

/** Footer link groups. */
export const FOOTER_LINKS = {
  build: [
    { label: 'GitHub', href: HEARTH.github, external: true },
    { label: 'Whitepaper', href: HEARTH.whitepaper, external: true },
    { label: 'Live explorer', href: HEARTH.explorer, external: true },
    { label: 'Web wallet', href: HEARTH.emberWallet, external: true },
  ],
  network: [
    { label: 'Why Hearth', href: '#why', external: false },
    { label: 'The coin', href: '#coin', external: false },
    { label: 'Mining', href: '#mining', external: false },
    { label: 'What EMBER is for', href: '#loop', external: false },
    { label: 'Run the testnet', href: '#testnet', external: false },
  ],
} as const
