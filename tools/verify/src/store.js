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

class Store {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
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
}

module.exports = { Store };
