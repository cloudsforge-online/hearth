'use strict';
/* How the two mining loops share a single-threaded process.
 *
 * There are two miners — src/miner.js for the UTXO chain and src/chain/miner.js
 * for the account model — and they are deliberately separate because they build
 * different candidates. What must NOT diverge is how either of them yields,
 * because that is not about blocks at all; it is about the gossip, the RPC
 * servers and the WebSocket keepalive that share the loop with them. So the rule
 * lives here once, with its reasoning, rather than twice as a constant.
 *
 * WHAT WAS WRONG. Both loops ran a fixed 150 nonces per turn. A nonce is one
 * FULL HOMEFIRE EVALUATION — ~9.5 ms of a core at the shipped parameters
 * (docs/pow-parameters.md; test/miner-loop.js measures it again on the machine
 * it runs on) — so a "batch" was about 1.4 SECONDS of blocked event loop. Two
 * consequences, both bad, and both invisible from inside the miner:
 *
 *   A BLOCK FROM A PEER SITS UNPARSED for up to that long, so this node keeps
 *   grinding a tip it would already know was dead. At a 15 s target that is a
 *   tenth of every interval spent on work that cannot win.
 *
 *   THROTTLE DID NOT THROTTLE. The rest between turns was a constant
 *   `(1 - throttle) * 12` ms — about 5 ms after 1,434 ms of work at
 *   `--throttle 0.6`, a 99.7% duty cycle. Somebody setting 0.6 to keep their
 *   laptop usable got 0.997 of a core and no way to tell.
 *
 * THE RULE. A turn is a slice of WALL CLOCK, and the rest that follows is
 * proportional to the work actually done. Both halves are necessary: a slice
 * alone leaves the throttle wrong, and a proportional rest alone leaves the loop
 * blocked for a second at a time inside each burst.
 */

/**
 * How long one turn of a mining loop may hold the event loop.
 *
 * 20 ms, which is two or three Homefire evaluations at the shipped parameters
 * and is chosen against what else is waiting rather than against mining: it is
 * under one frame at 50 Hz, far below the 100 ms at which an interactive
 * response feels delayed, and small against a 15 s block interval. A turn cannot
 * be shorter than ONE evaluation — the work is indivisible — so on a slow
 * machine or with a larger pad the real figure is that evaluation's cost, and
 * this constant simply stops it being a multiple of it.
 *
 * Yielding costs a `setImmediate`, i.e. microseconds, so at ~9.5 ms per
 * evaluation the overhead of this is under a tenth of a percent of hashrate.
 * test/miner-loop.js measures both the lag and the rate, so the trade is not
 * taken on trust.
 */
const SLICE_MS = 20;

/**
 * Schedule the next turn, having just spent `spentMs` hashing.
 *
 * `throttle` is a SHARE OF A CORE and is now honoured as one: resting
 * `spent * (1/throttle - 1)` makes work and rest sit in exactly the ratio the
 * operator asked for, whatever the machine's hashrate and whatever SLICE_MS is.
 * At 1.0 there is no rest at all and the loop yields with `setImmediate`, which
 * lets everything else run without giving up the core.
 *
 * Clamped below at 0.01 rather than allowing 0: `--throttle 0` reads as "do not
 * mine", but the loop was started, so honouring it literally would divide by
 * zero and honouring it as 0 would spin. 1% of a core is the nearest honest
 * answer, and `stop()` is how you mean the other thing.
 */
function schedule(step, spentMs, throttle) {
  const share = Number.isFinite(throttle) ? Math.min(1, Math.max(0.01, throttle)) : 1;
  if (share >= 1) return setImmediate(step);
  const rest = Math.round(Math.max(0, spentMs) * (1 / share - 1));
  return setTimeout(step, rest);
}

module.exports = { SLICE_MS, schedule };
