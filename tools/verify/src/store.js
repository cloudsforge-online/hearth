'use strict';
/* Verified records: one JSON file per address.
 *
 * Not a database, and not the explorer's index format either. The reasoning is
 * different from the index's: there is one record per VERIFIED CONTRACT, a
 * number that grows with developer activity rather than with chain length, and
 * each is a self-contained document that is written once and read many times.
 * A directory of files is the correct shape for that — it is greppable,
 * diffable, trivially backed up, and an operator can hand one to someone
 * without exporting anything.
 *
 * Writes go to a temporary file and are renamed into place, so a reader never
 * sees a half-written record and a crash mid-write cannot corrupt one.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { norm, maskImmutables } = require('./bytecode');

const sha256 = hex => crypto.createHash('sha256').update(norm(hex), 'hex').digest('hex');

class Store {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    /* ── THE RUNTIME-CODE INDEX, AND WHY ONE CONTRACT IS USUALLY MANY ───────
     *
     * A verified record is keyed by address, and for a hand-deployed contract
     * that is the whole story. It is the wrong story for a FACTORY: Forge
     * Create sells the same `FixedSupplyToken` over and over with different
     * constructor arguments, so a hundred customers own a hundred addresses
     * carrying ONE runtime bytecode. Verified per address, ninety-nine of them
     * read as anonymous blobs while an identical contract sits verified next
     * door.
     *
     * Runtime bytecode is what the verifier proves against, and it carries no
     * constructor arguments — they are consumed by the constructor and never
     * appear in the deployed code. So "the code at A is byte-for-byte the code
     * at B, and B's source compiles to it" is the SAME claim the verifier
     * already makes, transported to A without weakening it.
     *
     * Two keys per record, because immutables are the one thing that legitimately
     * differs between deployments of one source:
     *
     *   <sha256 of the deployed code>          — identical deployments
     *   masked-<sha256 of the immutable-masked code>  — same source, own immutables
     *
     * The second is what makes a token with 8 decimals resolve against one with
     * 18: `decimals` is `immutable`, so it is written into the runtime code at
     * construction and the two deployments differ at exactly those bytes.
     * Masking uses the ranges from the TWIN'S OWN COMPILE, which is why the
     * entry stores them — solc is the only thing that knows where they are, and
     * guessing would mean deleting bytes from a stranger's contract.
     */
    this.indexDir = path.join(dir, 'by-runtime');
    fs.mkdirSync(this.indexDir, { recursive: true });
  }

  _path(address) {
    const a = String(address).toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(a)) throw new Error(`not an address: ${address}`);
    // The address is validated to 40 hex characters before it becomes a path.
    return path.join(this.dir, `${a}.json`);
  }

  has(address) {
    try { return fs.existsSync(this._path(address)); } catch { return false; }
  }

  get(address) {
    let file;
    try { file = this._path(address); } catch { return null; }
    if (!fs.existsSync(file)) return null;
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  }

  put(record) {
    const file = this._path(record.address);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(record, null, 2) + '\n');
    fs.renameSync(tmp, file);
    return record;
  }

  list() {
    return fs.readdirSync(this.dir)
      .filter(f => /^0x[0-9a-f]{40}\.json$/.test(f))
      .map(f => {
        const r = this.get(f.slice(0, -5));
        return r && {
          address: r.address, contractName: r.contractName, compilerVersion: r.compilerVersion,
          matchType: r.matchType, verifiedAt: r.verifiedAt,
        };
      })
      .filter(Boolean)
      .sort((a, b) => String(b.verifiedAt).localeCompare(String(a.verifiedAt)));
  }

  get count() {
    try {
      return fs.readdirSync(this.dir).filter(f => /^0x[0-9a-f]{40}\.json$/.test(f)).length;
    } catch { return 0; }
  }

  // ── the runtime-code index ────────────────────────────────────────────────

  /**
   * Index a verified record by the code that is actually deployed at it.
   *
   * @param {object} o
   * @param {string} o.address              the verified address
   * @param {string} o.runtimeCode          `eth_getCode` at that address
   * @param {object} [o.immutableReferences] solc's map for the matched contract
   */
  indexRuntime({ address, runtimeCode, immutableReferences }) {
    const a = String(address).toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(a)) throw new Error(`not an address: ${address}`);
    const hex = norm(runtimeCode);
    if (!hex.length) return null;

    const written = [];
    const write = (key, body) => {
      /* FIRST WRITER WINS. Verifying a clone of an already-verified contract
       * must not silently re-point the key at the clone: every twin answer
       * names its source in `twinOf`, and that name changing under readers who
       * cited it buys nothing — the source is identical either way, which is
       * the entire premise. An entry whose record has since been deleted is
       * stale, so that one is replaced. */
      const existing = this._index(key);
      if (existing && existing.address !== a && this.has(existing.address)) return;
      this._write(key, body);
      written.push(key);
    };

    const keys = [sha256(hex)];
    write(keys[0], { address: a, kind: 'exact' });

    const masked = maskImmutables(hex, immutableReferences);
    if (masked.ranges.length) {
      keys.push(`masked-${sha256(masked.hex)}`);
      write(keys[1], { address: a, kind: 'masked', immutableReferences: immutableReferences || null });
    }

    /* A marker, so "is this record in the index?" is a question about THIS
     * address rather than about who happens to own its keys. Without it, a
     * record whose keys a twin already owns reads as un-indexed forever and
     * every start re-does the work. */
    this._write(`addr-${a}`, { address: a, keys, owns: written });
    return written;
  }

  _write(key, body) {
    const file = path.join(this.indexDir, `${key}.json`);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(body, null, 2) + '\n');
    fs.renameSync(tmp, file);
  }

  /**
   * Find a verified record whose runtime bytecode is the code given.
   *
   * Exact first: identical bytes need no interpretation. Then each masked
   * entry, because a masked lookup is only meaningful against the ranges of the
   * compile that produced it — the caller's code has to be masked the same way
   * before the hashes can be compared at all.
   *
   * @param {string} runtimeCode  code from `eth_getCode`
   * @returns {{record: object, match: 'exact'|'immutables', immutableValues: string[],
   *   immutableRanges: number}|null}
   */
  findByRuntime(runtimeCode) {
    const hex = norm(runtimeCode);
    if (!hex.length) return null;

    const entry = this._index(sha256(hex));
    if (entry) {
      const record = this.get(entry.address);
      if (record) return { record, match: 'exact', immutableValues: record.immutableValues || [], immutableRanges: record.immutableRanges || 0 };
    }

    let names;
    try { names = fs.readdirSync(this.indexDir); } catch { return null; }
    for (const name of names) {
      if (!/^masked-[0-9a-f]{64}\.json$/.test(name)) continue;
      const body = this._index(name.slice(0, -5));
      if (!body || !body.immutableReferences) continue;
      const masked = maskImmutables(hex, body.immutableReferences);
      if (!masked.ranges.length) continue;
      if (`masked-${sha256(masked.hex)}.json` !== name) continue;
      const record = this.get(body.address);
      if (record) {
        return {
          record, match: 'immutables',
          immutableValues: masked.values, immutableRanges: masked.ranges.length,
        };
      }
    }
    return null;
  }

  _index(key) {
    if (!/^(masked-)?[0-9a-f]{64}$/.test(String(key))) return null;
    const file = path.join(this.indexDir, `${key}.json`);
    if (!fs.existsSync(file)) return null;
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  }

  /** Records written before the index existed, or by a build that had no index. */
  unindexed() {
    let names;
    try { names = fs.readdirSync(this.dir); } catch { return []; }
    return names
      .filter(f => /^0x[0-9a-f]{40}\.json$/.test(f))
      .map(f => f.slice(0, -5))
      .filter(a => !fs.existsSync(path.join(this.indexDir, `addr-${a}.json`)));
  }
}

module.exports = { Store, sha256 };
