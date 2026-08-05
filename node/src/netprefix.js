'use strict';
/* Reduce a peer address to the network it came from, so a log line never carries a whole one.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * An IP address is personal data (GDPR Art. 4(1); Breyer C-582/14 for the dynamic case). This node
 * put whole ones into its p2p log lines — `peerName()` in src/p2p.js built `<address>:<port>` and
 * ten log statements carried it, and src/ws.js did the same for its refusals and notices. Behind
 * the tunnel that address is whatever `Cf-Connecting-Ip` says, which is the true client. There was
 * no size cap, no rotation and no age limit on the log those lines went into, so the retention
 * period was "until the disk fills". cloudsforge-online/micro-org#163.
 *
 * docker-compose.yml now caps and rotates the log, but ROTATION ONLY BOUNDS HOW LONG THE EXPOSURE
 * LASTS. This is the half that stops it happening: a whole address never reaches a log line at
 * all, so there is nothing for a rotation policy, a log shipper, a `docker logs` in somebody's
 * terminal or a support bundle to leak.
 *
 * WHAT IS KEPT, AND WHY IT IS ENOUGH
 * ----------------------------------
 * The reason to log any of it is stated in src/ws.js: behind a tunnel every peer shares the
 * tunnel's socket address, "so without this every log line names the same host and an operator
 * cannot tell two peers apart". A /24 or /48 plus the source port still tells two peers apart —
 * every connection has its own port — and it still answers the operational question a peer name is
 * for, which is "is this one host flooding me or is it the whole internet". What it stops
 * answering is "which house was that", which is the question nobody here needs answered.
 *
 * /24 AND /48, THE SAME SPLIT THE REST OF THE ESTATE USES. `micro-identity` stores session
 * prefixes truncated by `@cloudsforge/contracts-auth`'s `truncateIp`, at exactly these widths and
 * with exactly the IPv4-mapped special case below. This node is a standalone zero-dependency
 * CommonJS package and cannot import that module, so the algorithm is restated here rather than
 * approximated — test/netprefix.js asserts the same vectors that package's own tests do.
 *
 * NULL RATHER THAN A GUESS. Anything that is not an address returns null and the caller logs
 * `unknown`. A parser that "did its best" on a malformed forwarded header would emit a fragment
 * that looks like a network, which is worse than emitting nothing: it is untrue and it still
 * carries whatever the attacker put in the header.
 */

/** Strict dotted-quad. Returns four octets, or null. */
function parseIpv4(text) {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  const octets = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    /* A leading zero is rejected rather than tolerated: parsers disagree about whether `010` is
     * ten or eight, and an address that means two things is a bug in whatever compares them. */
    if (part.length > 1 && part.startsWith('0')) return null;
    const value = Number(part);
    if (value > 255) return null;
    octets.push(value);
  }
  return octets;
}

/** Eight 16-bit groups, `::` expanded and a trailing dotted-quad folded in. Or null. */
function parseIpv6(text) {
  let body = text;
  if (body.includes('.')) {
    const lastColon = body.lastIndexOf(':');
    if (lastColon < 0) return null;
    const embedded = parseIpv4(body.slice(lastColon + 1));
    if (!embedded) return null;
    const high = ((embedded[0] << 8) | embedded[1]).toString(16);
    const low = ((embedded[2] << 8) | embedded[3]).toString(16);
    body = body.slice(0, lastColon + 1) + high + ':' + low;
  }
  const halves = body.split('::');
  if (halves.length > 2) return null;
  const headText = halves[0] || '';
  const head = headText === '' ? [] : headText.split(':');
  const tailText = halves.length === 2 ? (halves[1] || '') : null;
  const tail = tailText === null ? null : tailText === '' ? [] : tailText.split(':');

  for (const group of head.concat(tail || [])) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
  }
  let groups;
  if (tail === null) {
    if (head.length !== 8) return null;
    groups = head;
  } else {
    const zeros = 8 - head.length - tail.length;
    if (zeros < 1) return null;
    groups = head.concat(new Array(zeros).fill('0'), tail);
  }
  return groups.map(g => parseInt(g, 16));
}

/**
 * `203.0.113.57` -> `203.0.113.0/24`, `2001:db8:1234:5678::1` -> `2001:db8:1234::/48`, and
 * anything that is not an address -> null.
 */
function networkPrefix(address) {
  if (typeof address !== 'string') return null;
  /* Bounded before it is parsed. The value can come from a header, so its length is a stranger's
   * choice; 64 is longer than the longest legal address form by a wide margin. */
  let text = address.trim().slice(0, 64);
  if (text.startsWith('[')) {
    const close = text.indexOf(']');
    if (close < 0) return null;
    text = text.slice(1, close);
  }
  const zone = text.indexOf('%');
  if (zone >= 0) text = text.slice(0, zone);
  if (text === '') return null;

  const v4 = parseIpv4(text);
  if (v4) return v4[0] + '.' + v4[1] + '.' + v4[2] + '.0/24';

  const v6 = parseIpv6(text);
  if (!v6) return null;
  /* Node behind a proxy hands back IPv4-mapped addresses — `::ffff:a.b.c.d`. Truncating one as
   * though it were IPv6 would keep all THIRTY-TWO IPv4 bits inside the /48, which is the exact
   * opposite of the intent and is the case most likely to be reached in this deployment. */
  if (v6[0] === 0 && v6[1] === 0 && v6[2] === 0 && v6[3] === 0 && v6[4] === 0 && v6[5] === 0xffff) {
    return (v6[6] >> 8) + '.' + (v6[6] & 0xff) + '.' + (v6[7] >> 8) + '.0/24';
  }
  return v6[0].toString(16) + ':' + v6[1].toString(16) + ':' + v6[2].toString(16) + '::/48';
}

/**
 * The single form a peer is named by in EVERY log line this node writes.
 *
 * One function so there is one answer. The previous code had the same expression written twice —
 * `peerName` in src/p2p.js and the `name` getter in src/ws.js — which is how a fix applied to one
 * of them would have left whole addresses in the other's refusals for ever.
 *
 * The port is kept. It is not personal data on its own, it is what still distinguishes two peers
 * inside one prefix, and it is the field an operator correlates against a connection.
 */
function peerLabel(address, port) {
  if (address === undefined || address === null) return 'closed';
  const prefix = networkPrefix(address);
  if (prefix === null) return 'unknown';
  return port === undefined || port === null ? prefix : prefix + ':' + port;
}

module.exports = { networkPrefix, peerLabel };
