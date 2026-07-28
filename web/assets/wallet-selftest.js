/* The wallet's self-test. Zero dependencies, no framework, no build step.
 *
 *   node web/assets/wallet-selftest.js
 *
 * There is no test runner in `web/` and there is not going to be one — the whole
 * point of this front-end is plain files served by nginx. So the checks that
 * matter are written as assertions against published vectors and against the
 * node's own modules, and they run under plain node.
 *
 * WHAT THIS IS REALLY FOR. The wallet carries browser ports of three things the
 * node also implements: secp256k1, RLP and the legacy transaction. A port that
 * is 99.9% right is worse than no port at all — it signs transactions that
 * recover to an address nobody controls, and it does so only for the one key in
 * a thousand that trips the difference. So under node this file does not merely
 * test the ports, it runs BOTH implementations over the same random inputs and
 * compares them:
 *
 *   sha256.js       vs node crypto (SHA-256 and HMAC), 200 random inputs
 *   secp256k1.js    vs node/src/crypto/secp256k1.js, 200 random keys — public
 *                   keys, RFC 6979 nonces, r, s, recoveryId, and recovery
 *   rlp.js          vs node/src/crypto/rlp.js, 500 random structures
 *   transaction.js  vs node/src/chain/transaction.js — signing hash, signed
 *                   bytes, hash, sender and intrinsic gas, over 120 random
 *                   transactions plus the EIP-155 worked example
 *
 * node/src is the authority in every one of those pairs. If a comparison fails,
 * this directory is wrong.
 *
 * The browser-only half — keystore.js under WebCrypto, and the fixture chain —
 * runs here too: WebCrypto is the same implementation in node 18+, and
 * localStorage is shimmed with a Map, exactly as node/test/keystore.js does for
 * the old wallet.
 */

import { sha256, hmacSha256, concat } from './wallet/sha256.js';
import * as secp from './wallet/secp256k1.js';
import * as RLP from './wallet/rlp.js';
import * as T from './wallet/transaction.js';
import { parseUnits, parseEmber, parseGwei, parseInteger } from './wallet/amount.js';
import { accountFromPrivateKey, accountFromInput, parseAddress } from './wallet/account.js';
import { keccak256 } from './explorer/keccak.js';
import { formatEmber, toChecksumAddress } from './explorer/format.js';

let pass = 0;
const failures = [];

function ok(cond, msg) { if (cond) pass++; else failures.push(msg); }
function eq(actual, expected, msg) {
  const a = typeof actual === 'bigint' ? actual + 'n' : JSON.stringify(actual);
  const b = typeof expected === 'bigint' ? expected + 'n' : JSON.stringify(expected);
  if (a === b) pass++; else failures.push(`${msg}\n      want ${b}\n      got  ${a}`);
}

const hex = b => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
const unhex = (s) => {
  const h = s.replace(/^0x/, '');
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
};

/** A deterministic PRNG, so a failure is reproducible rather than "sometimes". */
function rng(seed) {
  let x = seed >>> 0;
  return () => {
    x ^= x << 13; x >>>= 0;
    x ^= x >> 17;
    x ^= x << 5; x >>>= 0;
    return x;
  };
}
function randomBytes(next, n) {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = next() & 0xff;
  return out;
}

/* ---- the EIP-155 worked example -------------------------------------------
 * Lifted from node/test/transaction.js, which lifted it from EIP-155 itself.
 * NOTE the EIP publishes a signing hash of 65 hex digits — a typo present in the
 * document since 2016 — so the signed bytes are the authoritative half, and they
 * are byte-exact. Pinning these means RFC 6979 nonce generation is checked, not
 * merely round-tripped: any other k produces different bytes. */
const EIP155 = {
  privateKey: '0x4646464646464646464646464646464646464646464646464646464646464646',
  chainId: 1,
  tx: {
    nonce: 9, gasPrice: 20000000000n, gasLimit: 21000, value: 10n ** 18n, data: '0x',
    to: '0x3535353535353535353535353535353535353535',
  },
  signingData: '0xec098504a817c800825208943535353535353535353535353535353535353535880de0b6b3a764000080018080',
  signed: '0xf86c098504a817c800825208943535353535353535353535353535353535353535880de0b6b3a7640000'
    + '8025a028ef61340bd939bc2195fe537567866003e1a15d3c71ff63e1590620aa636276a067cbe9d8997f76'
    + '1aecb703304b3800ccf555c9f3dc64214b297fb1966a3b6d83',
  sender: '0x9d8a62f656a8d1615c1294fd71e9cfb3e4855a4f',
};

export async function run({ verbose = true } = {}) {
  const say = verbose ? (s) => console.log(s) : () => {};

  // ---- SHA-256 and HMAC -----------------------------------------------------
  say('• sha-256 (the sync one RFC 6979 needs)');
  eq(hex(sha256(new Uint8Array(0))), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    'sha256("") — the NIST empty vector');
  eq(hex(sha256(new TextEncoder().encode('abc'))),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', 'sha256("abc")');
  eq(hex(sha256(new TextEncoder().encode('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'))),
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1', 'sha256 of the 56-byte NIST vector');
  // 55, 56 and 64 bytes are where a padding bug hides: 56 is the first length
  // that needs a second block for the length field alone.
  for (const n of [54, 55, 56, 57, 63, 64, 65, 119, 120]) {
    ok(sha256(new Uint8Array(n)).length === 32, `sha256 over ${n} zero bytes returns 32 bytes`);
  }
  eq(hex(hmacSha256(new Uint8Array(20).fill(0x0b), new TextEncoder().encode('Hi There'))),
    'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7', 'RFC 4231 HMAC test case 1');
  eq(hex(hmacSha256(new TextEncoder().encode('Jefe'), new TextEncoder().encode('what do ya want for nothing?'))),
    '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843', 'RFC 4231 HMAC test case 2');
  eq(hex(concat(Uint8Array.of(1, 2), Uint8Array.of(3))), '010203', 'concat');

  // ---- secp256k1 ------------------------------------------------------------
  say('• secp256k1');
  eq(secp.N, 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n, 'the group order');
  eq(secp.P, (1n << 256n) - (1n << 32n) - 977n, 'the field prime');
  {
    // G itself, from the standard: private key 1 gives the generator.
    const pub = secp.publicKeyFromPrivate(unhex('00'.repeat(31) + '01'));
    eq(hex(pub).slice(0, 2), '04', 'an uncompressed key starts with 0x04');
    eq(hex(pub).slice(2, 66), '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798', 'G.x');
    eq(hex(pub).slice(66), '483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8', 'G.y');
    eq(hex(secp.publicKeyFromPrivate(unhex('00'.repeat(31) + '01'), true)),
      '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798', 'and compressed, with the parity tag');
  }
  ok(!secp.isValidPrivateKey(new Uint8Array(32)), 'zero is not a private key');
  ok(!secp.isValidPrivateKey(secp.bigToBuf32(secp.N)), 'n itself is not a private key');
  ok(secp.isValidPrivateKey(secp.bigToBuf32(secp.N - 1n)), 'n-1 is');
  {
    const priv = unhex(EIP155.privateKey);
    const msg = keccak256(new TextEncoder().encode('hearth'));
    const sig = secp.sign(msg, priv);
    ok(sig.s <= secp.N_HALF, 'signatures are low-s (EIP-2) by construction');
    ok(secp.verify(msg, sig, secp.publicKeyFromPrivate(priv)), 'and verify under the matching public key');
    const same = secp.sign(msg, priv);
    ok(same.r === sig.r && same.s === sig.s, 'RFC 6979: signing twice gives identical bytes');
    ok(!secp.verify(keccak256(new TextEncoder().encode('hearthh')), sig, secp.publicKeyFromPrivate(priv)),
      'and do not verify over a different message');
    // The high-s twin: still a valid ECDSA signature, refused by default.
    const twin = { r: sig.r, s: secp.N - sig.s };
    ok(!secp.verify(msg, twin, secp.publicKeyFromPrivate(priv)), 'the high-s twin is refused when lowS is on');
    ok(secp.verify(msg, twin, secp.publicKeyFromPrivate(priv), { lowS: false }),
      'and accepted when it is off — which is exactly what the ecrecover precompile needs');
    const rec = secp.recoverPublicKey(msg, sig);
    eq(hex(rec), hex(secp.publicKeyFromPrivate(priv)), 'recovery returns the signing key');
    ok(secp.recoverPublicKey(msg, { r: 0n, s: sig.s, recoveryId: 0 }) === null, 'r = 0 recovers to nothing');
    ok(secp.recoverPublicKey(msg, { ...sig, recoveryId: 7 }) === null, 'an out-of-range recovery id recovers to nothing');
    ok(secp.decodePoint(unhex('04' + '11'.repeat(64))) === null, 'a point not on the curve is refused');
  }

  // ---- RLP ------------------------------------------------------------------
  say('• RLP');
  eq(hex(RLP.encode('')), '80', 'the empty string');
  eq(hex(RLP.encode(0n)), '80', 'zero encodes as empty — the canonical form');
  eq(hex(RLP.encode('dog')), '83646f67', '"dog"');
  eq(hex(RLP.encode(['cat', 'dog'])), 'c88363617483646f67', 'a list of two strings');
  eq(hex(RLP.encode(1024n)), '820400', 'a two-byte integer');
  eq(hex(RLP.encode([[], [[]], [[], [[]]]])), 'c7c0c1c0c3c0c1c0', 'the "set theoretic" vector');
  eq(hex(RLP.encode('Lorem ipsum dolor sit amet, consectetur adipisicing elit')),
    'b8384c6f72656d20697073756d20646f6c6f722073697420616d65742c20636f6e7365637465747572206164697069736963696e6720656c6974',
    'the 56-byte string that crosses into the long form');
  /* Each of these is a DIFFERENT byte string that a lax decoder would read as
   * something it already has a canonical spelling for — which is how one
   * transaction ends up with two hashes. */
  for (const bad of [
    '0x8100',        // 0x00 must encode as itself, not as a one-byte string
    '0x817f',        // ditto for anything below 0x80
    '0xb800',        // long form used for a length the short form encodes
    '0xb90000',      // leading zero in a long-form length
    '0x8302',        // a length that runs past the end of the input
  ]) {
    ok((() => { try { RLP.decode(bad); return false; } catch { return true; } })(),
      'a non-canonical or truncated encoding is refused: ' + bad);
  }
  eq(hex(RLP.decode('0xc180')[0]), '', 'a list holding the empty string IS canonical and decodes');
  ok((() => { try { RLP.decode('0x83646f6700'); return false; } catch { return true; } })(),
    'trailing bytes after the top-level item are refused');

  // ---- the EIP-155 worked example ------------------------------------------
  say('• EIP-155, the worked example from the EIP itself');
  {
    const signingBytes = RLP.encode([
      9n, 20000000000n, 21000n, unhex(EIP155.tx.to), 10n ** 18n, new Uint8Array(0), 1n, 0n, 0n,
    ]);
    eq('0x' + hex(signingBytes), EIP155.signingData, 'the bytes the signature covers');
    eq('0x' + hex(T.signingHash(EIP155.tx, 1)), '0x' + hex(keccak256(signingBytes)),
      'and the signing hash is keccak over exactly those');

    const signed = T.sign(EIP155.tx, EIP155.privateKey, { chainId: 1 });
    eq('0x' + hex(T.encode(signed)), EIP155.signed,
      'the signed transaction is byte-exact — which pins the RFC 6979 nonce, not just the encoding');
    eq(signed.v, 37n, 'v = recoveryId + chainId * 2 + 35');
    eq('0x' + hex(T.recoverSender(signed)), EIP155.sender, 'and it recovers to the published sender');

    const decoded = T.decode(EIP155.signed, { chainId: 1 });
    eq('0x' + hex(T.encode(decoded)), EIP155.signed, 'encode(decode(raw)) is byte-identical to raw');
    eq(decoded.chainId, 1, 'the decoded chain id');
    ok(decoded.protected, 'and it is a protected transaction');
  }

  // ---- transactions on Hearth's own chain id -------------------------------
  say('• transactions on chain 7411');
  {
    const priv = unhex('0x' + '11'.repeat(32));
    const me = accountFromPrivateKey(priv);
    const draft = { nonce: 3n, gasPrice: 12n * 10n ** 9n, gasLimit: 21000n, to: EIP155.tx.to, value: 5n * 10n ** 17n, data: '0x' };
    const out = T.signAndCheck(draft, priv, me.addressBytes);
    eq(out.tx.v, BigInt(7411 * 2 + 35) + BigInt(out.tx.recoveryId), 'v encodes chain 7411');
    eq('0x' + hex(out.sender), me.address.toLowerCase(), 'signAndCheck recovers to the signing account');
    eq(out.intrinsicGas, 21000n, 'a plain transfer costs the base 21,000');
    eq(hex(out.hash), hex(keccak256(out.raw)), 'the hash is keccak over the signed bytes');

    // The check that makes signAndCheck worth its cost.
    let refused = false;
    try { T.signAndCheck(draft, priv, unhex('0x' + '22'.repeat(20))); }
    catch (e) { refused = e.code === 'SENDER_MISMATCH'; }
    ok(refused, 'signing for one account and claiming another is refused before broadcast');

    // A transaction signed for chain 1 must not decode as a Hearth transaction.
    const foreign = T.encode(T.sign(draft, priv, { chainId: 1 }));
    const bad = T.validate(foreign);
    ok(!bad.ok && bad.code === 'INVALID_CHAINID', 'a transaction signed for another chain is refused by chain id');

    eq(T.intrinsicGas({ ...draft, to: null, data: '0x' + '00'.repeat(10) }), 21000n + 32000n + 40n + 2n,
      'a creation costs 21000 + 32000 + 4 per zero byte + the EIP-3860 word');
    eq(T.intrinsicGas({ ...draft, data: '0x' + 'ff'.repeat(10) }), 21000n + 160n, '16 per non-zero byte');

    let tooLow = false;
    try { T.checkGas({ ...draft, gasLimit: 20999n }); } catch (e) { tooLow = e.code === 'INTRINSIC_GAS_TOO_LOW'; }
    ok(tooLow, 'a gas limit under the intrinsic cost is refused');

    eq('0x' + hex(T.contractAddress('0x' + '11'.repeat(20), 0)),
      '0x' + hex(keccak256(RLP.encode([unhex('11'.repeat(20)), 0n]))).slice(24),
      'a creation address is keccak(rlp([sender, nonce]))[12:]');
  }

  // ---- addresses ------------------------------------------------------------
  say('• addresses');
  {
    const acc = accountFromPrivateKey(EIP155.privateKey);
    eq(acc.address.toLowerCase(), EIP155.sender, 'the address is keccak(pub)[12:]');
    eq(acc.address, toChecksumAddress(EIP155.sender), 'and is rendered EIP-55 checksummed');
    ok(acc.privHex.startsWith('0x') && acc.privHex.length === 66, 'the private key renders as 0x + 64 hex');

    ok(parseAddress('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed').ok, 'a valid EIP-55 address passes');
    ok(!parseAddress('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD').ok, 'one flipped character fails its checksum');
    ok(parseAddress('0x' + '11'.repeat(20)).ok, 'an all-lowercase address carries no checksum and is allowed');
    ok(!parseAddress('0x' + '11'.repeat(20)).checksummed, 'but is flagged as unchecked, so the UI can warn');
    ok(!parseAddress('ember1qqqqq').ok, 'an ember1 address is refused with a reason, not silently');
    ok(!parseAddress('0x123').ok, 'a hex string of the wrong length is refused');
    ok((() => { try { accountFromInput('-----BEGIN PRIVATE KEY-----'); return false; } catch (e) { return /PEM/.test(e.message); } })(),
      'a pre-EVM PEM key is refused by name rather than by a hex parse error');
    ok((() => { try { accountFromInput('0x' + '00'.repeat(32)); return false; } catch { return true; } })(),
      'a zero private key is refused');
  }

  // ---- amounts --------------------------------------------------------------
  say('• amounts, at 18 decimals');
  eq(parseEmber('1'), 10n ** 18n, 'one EMBER');
  eq(parseEmber('0.000000000000000001'), 1n, 'one wei');
  eq(parseEmber('12.5'), 125n * 10n ** 17n, 'a fractional amount');
  eq(parseEmber('0'), 0n, 'zero parses (the caller decides whether zero is allowed)');
  eq(parseGwei('12'), 12n * 10n ** 9n, 'twelve gwei');
  eq(parseGwei('1.5'), 1_500_000_000n, 'and a fractional one');
  eq(parseInteger('21000', 'gas limit'), 21000n, 'a gas limit');
  for (const [bad, why] of [
    ['1,5', 'a comma is refused rather than guessed at'],
    ['0.0000000000000000001', '19 decimal places is refused, not truncated'],
    ['abc', 'a non-number is refused'],
    ['', 'an empty field is refused'],
    ['-1', 'a negative amount is refused'],
  ]) {
    ok((() => { try { parseEmber(bad); return false; } catch { return true; } })(), why);
  }
  eq(formatEmber(parseEmber('1234.5'), 6), '1,234.5', 'parse and format are inverses');
  eq(parseUnits('1', 6), 1_000_000n, 'and a 6-decimal token still works');

  // ---- the keystore ---------------------------------------------------------
  say('• keystore v3');
  {
    const store = new Map();
    globalThis.localStorage = {
      getItem: k => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: k => store.delete(k),
    };
    const KS = await import('./wallet/keystore.js');

    eq(KS.peek().kind, 'none', 'an empty browser reports nothing stored');
    const acc = await KS.create('correct horse battery');
    eq(KS.peek().kind, 'locked', 'after create, the store reports a sealed key');
    eq(KS.peek().address, acc.address, 'the address is readable WITHOUT the passphrase, so a locked wallet can show a balance');

    const raw = localStorage.getItem(KS.STORE_KEY);
    ok(!raw.includes(acc.privHex.slice(2, 34)), 'nothing resembling the private key appears in what is written');
    eq(JSON.parse(raw).version, 3, 'the record is versioned from the first line');
    eq(JSON.parse(raw).curve, 'secp256k1', 'and names its curve');
    ok(JSON.parse(raw).kdf.iterations >= 600_000, 'PBKDF2 at the OWASP floor or above');

    eq((await KS.unlock('correct horse battery')).privHex, acc.privHex, 'unlock returns the same key');
    let refused = false;
    try { await KS.unlock('wrong horse battery'); } catch (e) { refused = /wrong passphrase/.test(e.message); }
    ok(refused, 'a wrong passphrase is refused by the GCM tag, not silently mis-decrypted');

    const a = await KS.seal(acc.privHex, acc.address, 'pw12345678');
    const b = await KS.seal(acc.privHex, acc.address, 'pw12345678');
    ok(a.ct !== b.ct && a.iv !== b.iv && a.kdf.salt !== b.kdf.salt,
      'salt and IV are fresh per seal — a reused GCM IV is catastrophic and a fixed salt makes one rainbow table cover every wallet');
    let short = false;
    try { await KS.seal(acc.privHex, acc.address, 'short'); } catch { short = true; }
    ok(short, 'a too-short passphrase is rejected before anything is written');

    // A tampered address must not be believed: the key that comes out wins.
    const tampered = { ...a, address: '0x' + '99'.repeat(20) };
    let caught = false;
    try { await KS.open(tampered, 'pw12345678'); } catch (e) { caught = /tampered/.test(e.message); }
    ok(caught, 'a record whose stored address does not match its key is refused');

    // A future version is named, not misread.
    let versioned = false;
    try { await KS.open({ ...a, version: 4 }, 'pw12345678'); } catch (e) { versioned = /version 4/.test(e.message); }
    ok(versioned, 'an unrecognised keystore version is refused by number');

    // The pre-EVM records: reported, never read, never deleted.
    store.clear();
    localStorage.setItem('hearth.wallet.v2', JSON.stringify({ v: 2, address: 'ember1abc', ct: 'ff' }));
    const seen = KS.peek();
    eq(seen.kind, 'pre-evm', 'an Ed25519 keystore is reported as pre-EVM rather than as a decode error');
    eq(seen.address, 'ember1abc', 'and its address is shown so the notice can name it');
    await KS.create('a new passphrase entirely');
    ok(localStorage.getItem('hearth.wallet.v2') !== null,
      'creating an account-model key does NOT delete the pre-EVM record — it is not this page\'s to remove');
    eq(KS.peek().kind, 'locked', 'and the v3 key takes precedence for this wallet');
    KS.forget();
    ok(localStorage.getItem(KS.STORE_KEY) === null && localStorage.getItem('hearth.wallet.v2') !== null,
      'forget removes this wallet\'s key and only this wallet\'s key');

    store.clear();
    localStorage.setItem(KS.STORE_KEY, JSON.stringify({ version: 99 }));
    eq(KS.peek(), { kind: 'unreadable', version: 99 }, 'a record from a newer format is reported, not overwritten');
  }

  // ---- the fixture chain ----------------------------------------------------
  say('• fixtures');
  {
    const F = await import('./wallet/fixtures.js');
    F.reset();
    const priv = unhex('0x' + '33'.repeat(32));
    const me = accountFromPrivateKey(priv);
    F.adoptOwner(me.address);
    const call = async (method, params = []) => {
      const r = await F.fixtureTransport({ jsonrpc: '2.0', id: 1, method, params });
      if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code });
      return r.result;
    };
    eq(await call('eth_chainId'), '0x1cf3', 'the fixture chain is 7411');
    const balance = BigInt(await call('eth_getBalance', [me.address, 'latest']));
    ok(balance > 0n, 'the unlocked account has a balance to spend');
    const nonce = BigInt(await call('eth_getTransactionCount', [me.address, 'pending']));

    const signed = T.signAndCheck({
      nonce, gasPrice: 12n * 10n ** 9n, gasLimit: 21000n,
      to: F.FIXTURE.COUNTERPARTY, value: 10n ** 18n, data: '0x',
    }, priv, me.addressBytes);
    const accepted = await call('eth_sendRawTransaction', [signed.rawHex]);
    eq(accepted, signed.hashHex, 'the fixture returns the same hash the wallet computed');
    eq(await call('eth_getTransactionReceipt', [accepted]), null,
      'a pending transaction has a NULL receipt — never an error, because every client polls it');
    const pend = await call('eth_getTransactionByHash', [accepted]);
    eq(pend.blockNumber, null, 'and a null block number');
    eq(BigInt(await call('eth_getTransactionCount', [me.address, 'pending'])), nonce + 1n,
      'the pending nonce advances, so a second send does not reuse the first nonce');

    // Replaying the same bytes, and sending with a stale nonce, both fail the
    // way the node fails — in geth's words, because clients match on them.
    let dup = null;
    try { await call('eth_sendRawTransaction', [signed.rawHex]); } catch (e) { dup = e.message; }
    ok(/already known|nonce too low/.test(String(dup)), 'a replayed transaction is refused: ' + dup);

    const stale = T.signAndCheck({
      nonce: 0n, gasPrice: 12n * 10n ** 9n, gasLimit: 21000n,
      to: F.FIXTURE.COUNTERPARTY, value: 1n, data: '0x',
    }, priv, me.addressBytes);
    let low = null;
    try { await call('eth_sendRawTransaction', [stale.rawHex]); } catch (e) { low = e.message; }
    eq(low, 'nonce too low', 'a stale nonce is refused in the words every client matches on');

    const broke = T.signAndCheck({
      nonce: nonce + 1n, gasPrice: 12n * 10n ** 9n, gasLimit: 21000n,
      to: F.FIXTURE.COUNTERPARTY, value: 10n ** 30n, data: '0x',
    }, priv, me.addressBytes);
    let poor = null;
    try { await call('eth_sendRawTransaction', [broke.rawHex]); } catch (e) { poor = e.message; }
    eq(poor, 'insufficient funds for gas * price + value', 'and so is an amount the account cannot cover');

    eq(await call('eth_getBlockByNumber', ['pending', false]), null, 'there is no pending block on this chain');
    eq(await call('eth_getBlockByNumber', ['0xffffff', false]), null, 'a height above the tip is null, not an error');
    eq(await call('eth_getTransactionByHash', ['0x' + '99'.repeat(32)]), null, 'an unknown hash is null');
  }

  // ---- cross-checks against the node ---------------------------------------
  if (typeof window === 'undefined') {
    say('• cross-checks against node/src (the authority)');
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    const nodeCrypto = require('crypto');
    const nodeSecp = require('../../node/src/crypto/secp256k1.js');
    const nodeRlp = require('../../node/src/crypto/rlp.js');
    const nodeTx = require('../../node/src/chain/transaction.js');
    const nodeGas = require('../../node/src/evm/gas.js');

    // --- sha256 vs the platform ---
    let shaDrift = 0, hmacDrift = 0;
    const next = rng(0xc0ffee);
    for (let i = 0; i < 200; i++) {
      const msg = randomBytes(next, i % 200);
      if (hex(sha256(msg)) !== nodeCrypto.createHash('sha256').update(Buffer.from(msg)).digest('hex')) shaDrift++;
      const key = randomBytes(next, (i % 90) + 1);
      const mine = hex(hmacSha256(key, msg));
      const theirs = nodeCrypto.createHmac('sha256', Buffer.from(key)).update(Buffer.from(msg)).digest('hex');
      if (mine !== theirs) hmacDrift++;
    }
    eq(shaDrift, 0, 'sha256.js agrees with node crypto over 200 inputs');
    eq(hmacDrift, 0, 'and so does the HMAC, including keys longer than the block size');

    // --- secp256k1 vs node/src/crypto/secp256k1.js ---
    // This is the comparison the whole file exists for. A wallet that signs
    // differently from the node is worse than one that cannot sign at all.
    let pubDrift = 0, nonceDrift = 0, sigDrift = 0, recDrift = 0, verDrift = 0;
    const KEYS = 200;
    for (let i = 0; i < KEYS; i++) {
      const priv = nodeSecp.randomPrivateKey();
      const privU8 = new Uint8Array(priv);
      const msg = nodeCrypto.randomBytes(32);
      const msgU8 = new Uint8Array(msg);

      if (hex(secp.publicKeyFromPrivate(privU8)) !== nodeSecp.publicKeyFromPrivate(priv).toString('hex')) pubDrift++;
      if (hex(secp.publicKeyFromPrivate(privU8, true)) !== nodeSecp.publicKeyFromPrivate(priv, true).toString('hex')) pubDrift++;
      if (secp.rfc6979Nonce(msgU8, privU8) !== nodeSecp.rfc6979Nonce(msg, priv)) nonceDrift++;

      const mine = secp.sign(msgU8, privU8);
      const theirs = nodeSecp.sign(msg, priv);
      if (mine.r !== theirs.r || mine.s !== theirs.s || mine.recoveryId !== theirs.recoveryId) sigDrift++;

      // Each side recovers from the OTHER'S signature, so a shared-bug in one
      // direction cannot hide.
      const recMine = secp.recoverPublicKey(msgU8, theirs);
      const recTheirs = nodeSecp.recoverPublicKey(msg, mine);
      if (!recMine || hex(recMine) !== recTheirs.toString('hex')) recDrift++;
      if (!secp.verify(msgU8, theirs, new Uint8Array(nodeSecp.publicKeyFromPrivate(priv)))) verDrift++;
      if (!nodeSecp.verify(msg, mine, nodeSecp.publicKeyFromPrivate(priv))) verDrift++;
    }
    eq(pubDrift, 0, `public keys match node/src/crypto/secp256k1.js over ${KEYS} random keys, compressed and not`);
    eq(nonceDrift, 0, `RFC 6979 nonces match over ${KEYS} random (key, message) pairs`);
    eq(sigDrift, 0, `r, s and recoveryId all match over ${KEYS} random signatures`);
    eq(recDrift, 0, 'each implementation recovers the right key from the other\'s signature');
    eq(verDrift, 0, 'and each verifies the other\'s signatures');

    // --- RLP vs node/src/crypto/rlp.js ---
    const nextR = rng(0x1234abcd);
    function randomItem(depth) {
      const roll = nextR() % 10;
      if (depth < 3 && roll < 3) {
        const n = nextR() % 4;
        const out = [];
        for (let i = 0; i < n; i++) out.push(randomItem(depth + 1));
        return out;
      }
      // Lengths either side of the 55-byte long-form boundary, and the empty
      // string, which is the canonical encoding of zero.
      const len = [0, 1, 2, 31, 54, 55, 56, 57, 130][nextR() % 9];
      return randomBytes(nextR, len);
    }
    function toBuffers(v) { return Array.isArray(v) ? v.map(toBuffers) : Buffer.from(v); }
    let rlpDrift = 0, rlpRoundDrift = 0;
    for (let i = 0; i < 500; i++) {
      const item = randomItem(0);
      const mine = hex(RLP.encode(item));
      const theirs = nodeRlp.encode(toBuffers(item)).toString('hex');
      if (mine !== theirs) rlpDrift++;
      if (hex(RLP.encode(RLP.decode('0x' + theirs))) !== theirs) rlpRoundDrift++;
    }
    eq(rlpDrift, 0, 'rlp.js encodes identically to node/src/crypto/rlp.js over 500 random structures');
    eq(rlpRoundDrift, 0, 'and decode(encode(x)) round-trips byte for byte, which is what stops one transaction having two hashes');

    // --- transactions vs node/src/chain/transaction.js ---
    let hashDrift = 0, bytesDrift = 0, senderDrift = 0, gasDrift = 0, idDrift = 0;
    const nextT = rng(0x5eed);
    for (let i = 0; i < 120; i++) {
      const priv = nodeSecp.randomPrivateKey();
      const creation = i % 7 === 0;
      const dataLen = [0, 1, 4, 68, 200][i % 5];
      const draft = {
        nonce: BigInt(nextT() % 100000),
        gasPrice: BigInt(nextT() % 1000) * 10n ** 9n + 1n,
        gasLimit: 21000n + BigInt(dataLen) * 100n + (creation ? 60000n : 0n),
        to: creation ? null : '0x' + Buffer.from(randomBytes(nextT, 20)).toString('hex'),
        value: BigInt(nextT()) * 10n ** 9n,
        data: '0x' + Buffer.from(randomBytes(nextT, dataLen)).toString('hex'),
      };
      const mine = T.sign(draft, new Uint8Array(priv));
      const theirs = nodeTx.sign(draft, priv);

      if (hex(T.signingHash(draft)) !== nodeTx.signingHash(draft).toString('hex')) hashDrift++;
      if (hex(T.encode(mine)) !== nodeTx.encode(theirs).toString('hex')) bytesDrift++;
      if (hex(T.hash(mine)) !== nodeTx.hash(theirs).toString('hex')) hashDrift++;
      if (T.intrinsicGas(draft) !== nodeGas.intrinsicGas({ data: Buffer.from(unhex(draft.data)), isCreation: creation })) gasDrift++;
      // Each side recovers the sender from the other's bytes.
      const senderMine = T.recoverSender(T.decode('0x' + nodeTx.encode(theirs).toString('hex')));
      const senderTheirs = nodeTx.recoverSender(nodeTx.decode(Buffer.from(T.encode(mine))));
      if (hex(senderMine) !== senderTheirs.toString('hex')) senderDrift++;
      if (hex(senderMine) !== nodeTx.addressFromPublicKey(nodeSecp.publicKeyFromPrivate(priv)).toString('hex')) senderDrift++;
      if (creation) {
        const a = T.contractAddress(senderMine, draft.nonce);
        const b = nodeTx.contractAddress(senderTheirs, draft.nonce);
        if (hex(a) !== b.toString('hex')) idDrift++;
      }
    }
    eq(hashDrift, 0, 'signing hashes and transaction hashes match node/src/chain/transaction.js over 120 transactions');
    eq(bytesDrift, 0, 'and the signed bytes are identical, creations and calls alike');
    eq(senderDrift, 0, 'each implementation recovers the same sender from the other\'s bytes');
    eq(gasDrift, 0, 'intrinsic gas matches node/src/evm/gas.js, including the EIP-3860 initcode words');
    eq(idDrift, 0, 'and contract creation addresses agree');

    // --- the rejection rules, case for case ---
    const REJECTS = [
      ['0x', 'empty input'],
      ['0x02f8', 'a typed (EIP-2718) transaction'],
      ['0xc0', 'an empty list'],
    ];
    let rejectDrift = 0;
    for (const [raw] of REJECTS) {
      const mine = T.validate(raw);
      const theirs = nodeTx.validate(raw);
      if (mine.ok !== theirs.ok) rejectDrift++;
    }
    eq(rejectDrift, 0, 'malformed input is accepted or rejected the same way by both');

    // A leading-zero nonce: the canonicality rule that has no home in RLP.
    const nonCanonical = '0x' + nodeRlp.encode([
      Buffer.from([0, 1]), Buffer.from([1]), Buffer.from([0x52, 0x08]),
      Buffer.alloc(20), Buffer.alloc(0), Buffer.alloc(0),
      Buffer.from([0x3a, 0x95]), Buffer.alloc(32, 1), Buffer.alloc(32, 1),
    ]).toString('hex');
    const mineNC = T.validate(nonCanonical);
    const theirsNC = nodeTx.validate(nonCanonical);
    ok(!mineNC.ok && !theirsNC.ok && mineNC.code === theirsNC.code,
      `a leading-zero nonce is refused by both, with the same code (${mineNC.code})`);

    // --- the miner's proof signature ---
    // web/assets/mining/miner.js signs the Homefire digest with the same module.
    // Spec §4: Homefire is unchanged, the key it binds is not.
    const { POW_SIG_FORM } = await import('./mining/miner.js').catch(() => ({ POW_SIG_FORM: null }));
    if (POW_SIG_FORM) {
      eq(POW_SIG_FORM, 'secp256k1-r||s-64-lowS',
        'the miner names the proof-signature form it assumes, so a phase-5 mismatch is a grep');
    }
    const digest = nodeCrypto.randomBytes(32);
    const mkey = nodeSecp.randomPrivateKey();
    const msig = secp.sign(new Uint8Array(digest), new Uint8Array(mkey));
    const wire = hex(secp.bigToBuf32(msig.r)) + hex(secp.bigToBuf32(msig.s));
    eq(wire.length, 128, 'a proof signature is 64 bytes on the wire');
    ok(nodeSecp.verify(digest, { r: BigInt('0x' + wire.slice(0, 64)), s: BigInt('0x' + wire.slice(64)) },
      nodeSecp.publicKeyFromPrivate(mkey)),
    'and the node verifies it against the coinbase public key');
  }

  say('');
  if (failures.length) {
    console.log(`${pass} passed, ${failures.length} FAILED`);
    for (const f of failures) console.log('  ✗ ' + f);
  } else {
    console.log(`${pass} checks passed.`);
  }
  return { pass, failures };
}

// Running under node: execute and set the exit code. In a browser this file is
// inert until something imports and calls run().
if (typeof window === 'undefined' && typeof process !== 'undefined') {
  run().then(r => { process.exitCode = r.failures.length ? 1 : 0; });
}
