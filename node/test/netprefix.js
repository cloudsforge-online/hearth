'use strict';
/* A peer address never reaches a log line whole. Run: node test/netprefix.js
 *
 * cloudsforge-online/micro-org#163. This node logged whole IP addresses — src/p2p.js's `peerName`
 * fed ten log statements and src/ws.js's upgrade refusal fed another — into a Docker log that had
 * no size cap, no rotation and no age limit. Behind the tunnel the address in question is the true
 * client's, taken from `Cf-Connecting-Ip`, and an IP address is personal data.
 *
 * The compose files now bound the log. THAT IS NOT WHAT THESE CASES ARE ABOUT. Rotation bounds how
 * long the exposure lasts; these assert that there is no exposure to bound — that what src/p2p.js
 * and src/ws.js write is a /24 or a /48 and never the address it came from.
 *
 * THE VECTORS ARE ANCHORED OUTSIDE THIS REPOSITORY, for the reason test/ws.js gives about the
 * accept-key vector: a check whose expected values all came from the implementation under test
 * agrees with that implementation about a bug. The eleven cases in the first group are the ones
 * `@cloudsforge/contracts-auth`'s own suite asserts about `truncateIp`
 * (contracts/packages/auth/src/index.test.ts), which micro-identity's session prefixes are
 * stored by. If this file and that one ever disagree, the estate has two definitions of "a network
 * prefix" and one of them is wrong.
 *
 * Every address here is from a range reserved for documentation — 192.0.2.0/24, 198.51.100.0/24
 * and 203.0.113.0/24 (RFC 5737), 2001:db8::/32 (RFC 3849). None is a real one.
 */

const { networkPrefix, peerLabel } = require('../src/netprefix');

let checks = 0, failed = 0;
function assert(cond, msg) {
  checks++;
  if (cond) console.log('  ✓ ' + msg);
  else { failed++; console.log('  ✗ ' + msg); }
}
const group = name => console.log('\n• ' + name);

// ---- the estate's shared definition of a prefix ----------------------------

group('the same truncation micro-identity stores session prefixes with');

assert(networkPrefix('203.0.113.57') === '203.0.113.0/24', 'IPv4 truncates to a /24');
assert(!networkPrefix('203.0.113.57').includes('57'), 'and the host octet is gone, not zeroed in place');
assert(networkPrefix('2001:db8:1234:5678:9abc:def0:1234:5678') === '2001:db8:1234::/48',
  'IPv6 truncates to a /48');
assert(networkPrefix('2001:db8::1') === '2001:db8:0::/48', 'a compressed IPv6 address expands first');
assert(networkPrefix('::1') === '0:0:0::/48', 'loopback is not a special case');
assert(networkPrefix('[2001:db8:1234::1]') === '2001:db8:1234::/48', 'brackets are stripped');
assert(networkPrefix('fe80::1%eth0') === 'fe80:0:0::/48', 'a zone index is stripped');

// The case most likely to be reached here: Node behind a proxy hands back `::ffff:a.b.c.d`.
// Truncating that as IPv6 would keep all thirty-two IPv4 bits inside the /48.
{
  const mapped = networkPrefix('::ffff:203.0.113.57');
  assert(mapped === '203.0.113.0/24', 'an IPv4-mapped IPv6 address truncates as IPv4');
  assert(!mapped.includes('57'), 'so the mapped form does not smuggle the whole IPv4 address through');
}

for (const bad of ['', '   ', 'not-an-address', '203.0.113', '203.0.113.999', '[2001:db8::1', 'x'.repeat(200)]) {
  assert(networkPrefix(bad) === null, `${JSON.stringify(bad.slice(0, 20))} does not truncate`);
}
assert(networkPrefix('203.0.113.010') === null, 'a leading zero is refused rather than guessed at');
assert(networkPrefix(undefined) === null && networkPrefix(null) === null && networkPrefix(7) === null,
  'a non-string is refused rather than coerced');

// ---- what actually reaches a log line --------------------------------------

group('what src/p2p.js and src/ws.js put in a log line');

{
  // The two shapes the old code produced: `<address>:<port>` and 'closed'.
  const label = peerLabel('203.0.113.57', 51234);
  assert(label === '203.0.113.0/24:51234', 'a peer is named by its network and its port');
  assert(!label.includes('203.0.113.57'), 'and the address it came from is not in the label');
  assert(!label.includes('.57'), 'not even as a fragment');
  assert(label.includes('51234'), 'the port is kept — it is what still tells two peers apart');
}

assert(peerLabel('2001:db8:1234:5678::1', 51234) === '2001:db8:1234::/48:51234',
  'an IPv6 peer is named by its /48');

assert(peerLabel(undefined) === 'closed' && peerLabel(null) === 'closed',
  "a destroyed socket still answers 'closed', as it did before");

assert(peerLabel('not-an-address', 1) === 'unknown',
  "a malformed header is 'unknown' rather than a fragment that looks like a network");

{
  // The whole point of a shared helper: a fix applied to one call site cannot leave the other
  // logging addresses, because there is only one call site.
  const noPort = peerLabel('203.0.113.57');
  assert(noPort === '203.0.113.0/24', 'the refusal path, which passes no port, truncates too');
  assert(!noPort.includes('203.0.113.57'), 'and carries no address either');
}

{
  // Two hosts in one /24 collapse. That is the cost, stated: an operator can no longer tell them
  // apart by prefix alone — the port is what does that — and it is the reason the value is not
  // personal data any more.
  assert(peerLabel('203.0.113.1', 1) !== peerLabel('203.0.113.1', 2), 'two connections stay distinct');
  assert(peerLabel('203.0.113.1', 1).split(':')[0] === peerLabel('203.0.113.9', 2).split(':')[0],
    'but two hosts in one /24 share a prefix, which is what makes it a prefix');
  assert(peerLabel('203.0.113.1', 1).split(':')[0] !== peerLabel('198.51.100.1', 1).split(':')[0],
    'and two different networks do not');
}

// ---- the sources, read as text ---------------------------------------------

group('no call site builds a peer name out of a raw address any more');

{
  const fs = require('fs');
  const path = require('path');
  /* The regression this catches is somebody re-introducing the old expression — it is the obvious
   * thing to write, it was here until #163, and every behavioural case above would still pass if
   * it were added at an eleventh log site. So the sources are read. */
  const OLD = /\$\{\s*(?:this\.|sock\.)?remoteAddress\s*\}\s*:/;
  /* Comments are stripped first, and that is not a convenience: both files now QUOTE the old
   * expression in the note explaining why it is gone, and a grep that matched prose would have to
   * be weakened until it stopped matching the code too. Crude but sufficient — these two files
   * contain no string literal holding a `/*` or a `//`. */
  const code = name => fs.readFileSync(path.join(__dirname, '..', 'src', name), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  for (const name of ['p2p.js', 'ws.js']) {
    assert(!OLD.test(code(name)), `src/${name} does not interpolate a raw remoteAddress into a name`);
  }
  assert(!/onRefused\(why,\s*\{\s*peer:\s*peerAddress\(/.test(code('ws.js')),
    'src/ws.js does not hand a raw address to the refusal log, which anything on the internet can trigger');
  assert(/peerLabel/.test(code('p2p.js')) && /peerLabel/.test(code('ws.js')),
    'and both go through the one shared helper, so a fix to one cannot miss the other');
}

console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} — ${checks - failed}/${checks} checks\n`);
process.exit(failed === 0 ? 0 : 1);
