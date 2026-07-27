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
  sub: 'Mine EMBER on the computer you already own — no farms, no pools, no premine.',
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
  { k: 'CPU', l: 'only · non-outsourceable' },
  { k: '0%', l: 'premine · fair launch' },
  { k: '10%', l: 'per block to the Commons' },
] as const

/**
 * "Why Hearth" — the problem/solution table from the README, verbatim in
 * substance. Each row: a big crypto problem and what Hearth does about it.
 */
export const WHY_ROWS = [
  {
    problem: 'Mining centralized into ASIC farms & pools',
    solution:
      'Homefire PoW: RandomX-class, memory-hard and non-outsourceable. A farm earns no more per dollar than your laptop, and pools can’t form.',
  },
  {
    problem: 'Coins behave like “gold” you hoard',
    solution:
      'Money-first coinnomics: disinflationary emission into a perpetual tail, offset by a fee burn. Net inflation trends toward ~0%. Built for velocity.',
  },
  {
    problem: 'Slow & expensive to pay with',
    solution: '15-second blocks, sub-cent fees, and instant retail settlement over Tab payment channels.',
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
      'One app — node, wallet and polite miner in a single download — a web wallet, a block explorer, and a two-line “Accept EMBER” SDK.',
  },
] as const

/** "The coin" — spec facts. Sourced from README + coinnomics.md. */
export const COIN_FACTS = [
  { k: 'Network', v: 'Hearth' },
  { k: 'Coin', v: 'Ember' },
  { k: 'Ticker', v: 'EMBER' },
  { k: 'Smallest unit', v: '1 EMBER = 100,000,000 sparks' },
  { k: 'Block time', v: '15 seconds' },
  { k: 'Proof of work', v: 'Homefire — CPU-only, non-outsourceable' },
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

/** Mining — Homefire pillars, from whitepaper §2. */
export const MINING_POINTS = [
  {
    title: 'RandomX-class & memory-hard',
    body: 'Each nonce compiles a program that runs against a large scratchpad — a random walk that reads and writes memory. Commodity CPUs are the fair-value hardware; there is no super-linear farm advantage to buy.',
  },
  {
    title: 'CPU-only, non-outsourceable',
    body: 'The puzzle binds work to the miner who’d be paid, so a hasher can’t sell their work to a pool operator. Pools can’t form — which is exactly what keeps mining spread across ordinary people.',
  },
  {
    title: 'Polite mining',
    body: 'The app mines only on AC power or when your machine is idle, throttled and low-variance. Money mined in the background of the computer you already own — no rigs, no roar, no rented warehouse.',
  },
  {
    title: 'One app',
    body: 'A single download is a full node, a wallet and the miner at once. No stratum config, no pool signup, no separate wallet — start the app and you’re on the network.',
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
    body: 'Keep your own key in the web wallet, or deposit to a custodied ember1… address. CloudsForge custodies EMBER with hearthd’s own Ed25519 scheme rather than a second one it invented.',
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
