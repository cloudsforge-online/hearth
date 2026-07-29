/* WHICH CHAIN THIS BUNDLE IS FOR — the one place the id is configured.
 *
 * EIP-155 binds a signature to a chain id, so this number is not a label. It
 * decides which network can replay the bytes the wallet hands the user, and it
 * decides whether the explorer's "this is not chain X" banner is a warning or a
 * lie. It used to be a literal `7411` in seven places across the wallet, the
 * explorer, both fixture sets and two self-tests, while the only chain this
 * estate runs is hearth-testnet — 7412 (node/src/params.js CHAIN_IDS). Every
 * transaction the wallet signed was therefore bound to a chain nobody was
 * serving, and the explorer banner fired on the correct chain.
 *
 * RESOLUTION ORDER, deliberately the same shape as rpc.js's endpoint order:
 *
 *   ?chainid=<n>  →  <meta name="hearth-chain-id">  →  DEFAULT_CHAIN_ID
 *
 * The meta is what the container templates: web/nginx.conf rewrites it from
 * ${HEARTH_CHAIN_ID} with sub_filter, exactly as it templates the RPC upstream,
 * so one image serves testnet and mainnet. An empty or non-numeric value — a
 * page opened straight off disk, or an unsubstituted placeholder — falls
 * through to the default rather than to zero.
 *
 * WHAT THIS DELIBERATELY IS NOT: `eth_chainId`. Adopting whatever the node
 * reports would mean a link of the form `?rpc=https://not-hearth.example` gets
 * to choose what its victim's signature is bound to, which is the exact attack
 * EIP-155 exists to stop (docs/evm-spec.md §1). The node's answer is compared
 * against this value and disagreement is reported; it is never adopted.
 */

/** docs/evm-spec.md §1 — verified unclaimed against the live chain registry. */
export const MAINNET_CHAIN_ID = 7411;
/** A separate id is mandatory, not cosmetic: it is what stops testnet bytes
 *  replaying on mainnet. node/src/params.js refuses to let them be equal. */
export const TESTNET_CHAIN_ID = 7412;

/* The shipped default is the testnet, because that is the only Hearth chain
 * that exists: the estate's docker-compose.yml runs `HEARTH_NETWORK=hearth-testnet`
 * on every node and Beacon asserts 7412 against all three of them. A bundle
 * defaulting to a mainnet that has not launched signs for nothing. */
export const DEFAULT_CHAIN_ID = TESTNET_CHAIN_ID;

const NUMERIC = /^[0-9]+$/;

function parse(value) {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  // `${HEARTH_CHAIN_ID}` arrives verbatim if envsubst never ran, and '' arrives
  // when the placeholder was left alone. Neither is a chain id; both mean
  // "nobody configured this", which is what the default is for.
  if (!NUMERIC.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * Resolve the configured chain id. Pure enough to test: pass `search` and
 * `metaContent` explicitly, or let it read the document. Under node — the
 * self-tests import this transitively — there is no document and no location,
 * and the default is returned.
 */
export function resolveChainId({ search, metaContent } = {}) {
  if (search === undefined && typeof location !== 'undefined') search = location.search;
  if (typeof search === 'string') {
    const q = parse(new URLSearchParams(search).get('chainid'));
    if (q !== null) return q;
  }
  if (metaContent === undefined && typeof document !== 'undefined') {
    const m = document.querySelector('meta[name="hearth-chain-id"]');
    metaContent = m ? m.content : undefined;
  }
  const meta = parse(metaContent);
  if (meta !== null) return meta;
  return DEFAULT_CHAIN_ID;
}

let cached = null;

/** The configured chain id, resolved once per page load. */
export function chainId() {
  return cached !== null ? cached : (cached = resolveChainId());
}

/** For tests that need to run the resolution again after changing the document. */
export function resetChainId() { cached = null; }

/**
 * A human name for an id — used in the explorer's chain-id tile and the wallet's
 * mismatch banner. An id this bundle does not know is named as such rather than
 * guessed at: "unknown" is the honest answer and the alarming one, which is
 * correct here.
 */
export function chainName(id) {
  const n = Number(id);
  if (n === MAINNET_CHAIN_ID) return 'hearth mainnet';
  if (n === TESTNET_CHAIN_ID) return 'hearth testnet';
  return 'an unrecognised chain';
}
