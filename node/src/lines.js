'use strict';
/* Read a newline-delimited file one line at a time, without ever holding the
 * whole of it.
 *
 * WHY THIS EXISTS, AND IT IS NOT AN OPTIMISATION.
 *
 * Both chains replayed their on-disk history like this:
 *
 *     const lines = fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean)
 *
 * V8 will not build a string longer than `buffer.constants.MAX_STRING_LENGTH` —
 * 536,870,888 bytes — and throws ERR_STRING_TOO_LONG rather than returning a
 * short read. At the ~1.5 KB per block this chain writes and a 15 second block
 * interval, that ceiling arrives at about 350,000 blocks: SIXTY-ONE DAYS of
 * uptime, after which THE NODE CANNOT START AND ITS CHAIN IS UNREADABLE BY THE
 * ONLY SOFTWARE THAT CAN READ IT. There is no error the operator can act on and
 * no partial recovery; the process simply refuses to come up, and it does so at
 * a restart, which is exactly when the chain is needed most.
 *
 * It degrades before it dies, too: the string, the array of lines and every
 * parsed block are all live at once, so the failure begins as a node that takes
 * minutes to start and ends as one that cannot.
 *
 * This is a correctness bomb with a date on it rather than a capacity concern,
 * and that is why the reader is a shared module with its own note rather than
 * an inlined loop in two places that will drift.
 *
 * BOUNDED, which the thing it replaces was not. A line longer than
 * `maxLineBytes` is reported and skipped rather than accumulated, so a corrupt
 * or truncated file cannot reproduce the original failure through the back door.
 * Nothing on disk should ever be near it: a block is capped at
 * `P.MAX_BLOCK_BYTES` by consensus and at `P.P2P_MAX_LINE` (4 MiB) by the wire,
 * so 16 MiB is a wide margin around both.
 */

const fs = require('fs');

const NL = 0x0a;
const EMPTY = Buffer.alloc(0);
const DEFAULT_MAX_LINE_BYTES = 16 * 1024 * 1024;
const DEFAULT_CHUNK_BYTES = 1024 * 1024;

/**
 * Every newline-delimited line in `file`, decoded as UTF-8, as an iterator.
 *
 * A final line with no trailing newline is delivered — a power cut during an
 * append leaves exactly that, and the caller decides what to do with it. Multi-
 * byte characters are safe across chunk boundaries because only whole lines are
 * ever decoded; the remainder is carried as bytes.
 *
 * PULLED RATHER THAN PUSHED, which `readLines` below was and still is for every
 * caller that wants it. The difference is who owns the loop: a caller that owns
 * it can stop early, and — the reason this exists — can AWAIT between lines. The
 * chain replay does, so that a boot whose length is proportional to the chain is
 * not also a stall of that length (micro-org#349). A push-shaped reader cannot
 * offer that: `onLine` returning a promise would be ignored here and the file
 * would be read to the end regardless.
 *
 * The file descriptor is closed by the `finally` below on ANY exit, including
 * the `return()` a `for…of` sends when its body breaks or throws.
 *
 * @param {string}   file
 * @param {object}   [opts]
 * @param {number}   [opts.maxLineBytes]  refuse a line longer than this
 * @param {(bytes: number) => void} [opts.onOversized]  told once per skipped line
 * @param {number}   [opts.chunkBytes]    read buffer size
 */
function* eachLine(file, opts = {}) {
  const maxLineBytes = opts.maxLineBytes || DEFAULT_MAX_LINE_BYTES;
  const onOversized = opts.onOversized || (() => {});
  const chunkBytes = opts.chunkBytes || DEFAULT_CHUNK_BYTES;

  const fd = fs.openSync(file, 'r');
  try {
    const chunk = Buffer.allocUnsafe(chunkBytes);
    let carry = EMPTY;
    // True while discarding the tail of a line that was already refused, so an
    // oversized line is reported once rather than once per chunk it spans.
    let skipping = false;
    let n;
    while ((n = fs.readSync(fd, chunk, 0, chunkBytes, null)) > 0) {
      const data = carry.length ? Buffer.concat([carry, chunk.subarray(0, n)]) : chunk.subarray(0, n);
      let start = 0;
      for (;;) {
        const nl = data.indexOf(NL, start);
        if (nl < 0) break;
        if (skipping) skipping = false;             // the refused line ends here
        else yield data.toString('utf8', start, nl);
        start = nl + 1;
      }
      const rest = data.length - start;
      if (skipping) { carry = EMPTY; continue; }
      if (rest > maxLineBytes) { onOversized(rest); skipping = true; carry = EMPTY; continue; }
      // Copied, not a view: `chunk` is reused on the next read, and a subarray
      // of it would also pin the whole buffer.
      carry = rest ? Buffer.from(data.subarray(start)) : EMPTY;
    }
    if (carry.length && !skipping) yield carry.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Call `onLine` with every line in `file`. The push-shaped reader, unchanged in
 * behaviour and now one line of code over `eachLine` — two loops that read the
 * same format would drift, and this one is on the boot path of both chains.
 */
function readLines(file, onLine, opts = {}) {
  for (const line of eachLine(file, opts)) onLine(line);
}

module.exports = { readLines, eachLine, DEFAULT_MAX_LINE_BYTES };
