'use strict';
/* The browser wallet's key storage, exercised outside a browser.
 *
 * `web/assets/keystore.js` is the only thing standing between someone's coins
 * and anything that can read their browser profile, so it is worth a test that
 * runs in CI rather than only when a human clicks through the page. WebCrypto is
 * the same implementation here as there; `localStorage` is not, so it is shimmed
 * with a Map — the module touches nothing else browser-specific.
 *
 * Run: node test/keystore.js   (also part of `npm test`) */

const store = new Map();
globalThis.localStorage = {
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: k => store.delete(k),
};

let pass = 0, fail = 0;
const ok = (c, label) => { c ? (pass++, console.log('  ✓ ' + label)) : (fail++, console.log('  ✗ ' + label)); };
const section = s => console.log('\n• ' + s);

(async () => {
  const KS = await import('../../web/assets/keystore.js');
  const WC = await import('../../web/assets/wallet-core.js');

  section('a new key is sealed, never stored in the clear');
  {
    ok(KS.peek().kind === 'none', 'an empty browser reports nothing stored');

    const key = await KS.create('correct horse battery');
    const seen = KS.peek();
    ok(seen.kind === 'locked', 'after create, the store reports a sealed key');
    ok(seen.address === key.address, 'the address is readable WITHOUT the passphrase, so a locked wallet can still show a balance');

    const raw = localStorage.getItem(KS.STORE_KEY);
    ok(!raw.includes('PRIVATE KEY') && !raw.includes(key.priv.slice(30, 60)),
      'nothing resembling the PEM appears in what is written to storage');

    const again = await KS.unlock('correct horse battery');
    ok(again.priv === key.priv && again.address === key.address, 'unlock returns the same key');

    let refused = false;
    try { await KS.unlock('wrong horse battery'); }
    catch (e) { refused = /wrong passphrase/.test(e.message); }
    ok(refused, 'a wrong passphrase is refused by the GCM tag, not silently mis-decrypted');
  }

  section('the KDF and the nonces are not reused');
  {
    const key = await WC.generateKey();
    const a = await KS.seal(key.priv, key.address, 'pw12345678');
    const b = await KS.seal(key.priv, key.address, 'pw12345678');
    ok(a.ct !== b.ct, 'the same key under the same passphrase encrypts differently twice');
    ok(a.kdf.salt !== b.kdf.salt && a.iv !== b.iv, 'salt and IV are fresh per seal');
    // Reusing an AES-GCM IV across two messages under one key is catastrophic;
    // a fixed salt would make one rainbow table cover every Hearth wallet.
    ok(a.kdf.iterations >= 600_000, 'PBKDF2 iterations at the OWASP floor or above');

    let tooShort = false;
    try { await KS.seal(key.priv, key.address, 'short'); } catch { tooShort = true; }
    ok(tooShort, 'a too-short passphrase is rejected before anything is written');
  }

  section('a plaintext v1 key can be migrated without losing it');
  {
    store.clear();
    const legacy = await WC.generateKey();
    localStorage.setItem(KS.LEGACY_STORE_KEY, JSON.stringify({
      priv: legacy.priv, address: legacy.address, created: 1_700_000_000_000,
    }));

    const seen = KS.peek();
    ok(seen.kind === 'legacy' && seen.address === legacy.address,
      'a v1 plaintext key is reported as legacy rather than read implicitly');

    const migrated = await KS.migrate('a new passphrase');
    ok(migrated.priv === legacy.priv, 'migration preserves the exact key');
    ok(migrated.address === legacy.address, 'and therefore the address, so no coins move');
    ok(localStorage.getItem(KS.LEGACY_STORE_KEY) === null, 'the plaintext record is removed');
    ok(KS.peek().kind === 'locked', 'and the store now reports a sealed key');
    ok(JSON.parse(localStorage.getItem(KS.STORE_KEY)).created === 1_700_000_000_000,
      'the original creation date survives');
    ok((await KS.unlock('a new passphrase')).priv === legacy.priv,
      'the migrated key opens with the chosen passphrase');
  }

  section('a failed migration is not a way to lose a key');
  {
    store.clear();
    const legacy = await WC.generateKey();
    localStorage.setItem(KS.LEGACY_STORE_KEY, JSON.stringify({ priv: legacy.priv, address: legacy.address }));
    let threw = false;
    try { await KS.migrate('short'); } catch { threw = true; }
    ok(threw && localStorage.getItem(KS.LEGACY_STORE_KEY) !== null,
      'a migration that fails leaves the original key exactly where it was');
  }

  section('forget means forget');
  {
    store.clear();
    const key = await WC.generateKey();
    localStorage.setItem(KS.LEGACY_STORE_KEY, JSON.stringify({ priv: key.priv, address: key.address }));
    await KS.save(key, 'passphrase!');
    KS.forget();
    ok(KS.peek().kind === 'none' && store.size === 0, 'both the sealed and the legacy record are cleared');
  }

  console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass}/${pass + fail} checks`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
