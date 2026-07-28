'use strict';
/* Chat — messages that live in blocks.
 *
 * This is an application, not a protocol change: it is entirely built out of
 * `records` (node/src/tx.js) and sealed boxes (node/src/box.js), and the node
 * has no idea it exists. Anything else can be built the same way.
 *
 * Two record kinds, both in the `chat` namespace:
 *
 *   announce   key = your address        data = 0x01 | x25519 reading key
 *   message    key = recipient address   data = sealed box
 *
 * You have to announce before anyone can write to you, because there is nothing
 * else on the chain that maps an address to a key you can encrypt to. The
 * announcement is signed by the tx that carries it, so an address's reading key
 * can only be set by whoever controls that address's coins.
 *
 * The plaintext inside the box is JSON: { v, body, sentAt, replyTo? }. The
 * sender is NOT in it — it is read off the transaction's inputs, where it is
 * signed, rather than trusted from a field the sender fills in.
 */

const BOX = require('../box');
const C = require('../crypto');

const APP = 'chat';
const KIND_ANNOUNCE = 0x01;
const KIND_MESSAGE = 0x02;
/** Leaves room for the sealed-box overhead and the JSON envelope inside 4 KiB. */
const MAX_BODY_BYTES = 3_500;

// ---- announcements ---------------------------------------------------------

/** The record that publishes your reading key, so others can write to you. */
function announceRecord(address, readingPubHex) {
  if (!C.isValidAddress(address)) throw new Error('invalid address');
  const raw = Buffer.from(readingPubHex, 'hex');
  if (raw.length !== 32) throw new Error('reading key must be 32 bytes');
  return {
    app: APP,
    key: address,
    data: Buffer.concat([Buffer.from([KIND_ANNOUNCE]), raw]).toString('hex'),
  };
}

/** The reading key an announcement carries, or null if this is not one. */
function readAnnounce(record) {
  const buf = Buffer.from(record.data, 'hex');
  if (buf.length !== 33 || buf[0] !== KIND_ANNOUNCE) return null;
  return buf.subarray(1).toString('hex');
}

/**
 * The current reading key for an address: the most recent announcement that the
 * address itself signed. Announcements by anyone else are ignored, which is what
 * stops a third party from publishing a key they hold and reading your mail.
 */
function resolveReadingKey(records, address) {
  let found = null;
  for (const r of records) {
    if (r.key !== address || r.from !== address) continue;
    const pub = readAnnounce(r);
    if (pub) found = pub;   // later announcements supersede — this is key rotation
  }
  return found;
}

// ---- messages --------------------------------------------------------------

/** Seal a message to a recipient's reading key and wrap it as a record. */
function messageRecord(toAddress, readingPubHex, body, { replyTo, sentAt } = {}) {
  if (!C.isValidAddress(toAddress)) throw new Error('invalid recipient address');
  const text = String(body);
  if (!text.length) throw new Error('empty message');
  if (Buffer.byteLength(text) > MAX_BODY_BYTES)
    throw new Error(`message too long: ${Buffer.byteLength(text)} > ${MAX_BODY_BYTES} bytes`);
  const envelope = JSON.stringify({
    v: 1,
    body: text,
    sentAt: sentAt || Math.floor(Date.now() / 1000),
    ...(replyTo ? { replyTo } : {}),
  });
  const sealed = BOX.seal(readingPubHex, envelope);
  return {
    app: APP,
    key: toAddress,
    data: Buffer.concat([Buffer.from([KIND_MESSAGE]), sealed]).toString('hex'),
  };
}

/**
 * Open one record with your reading key.
 * Returns null when it is not a message or is not addressed to this key —
 * an inbox is a filter over public records, so most of what it sees is not
 * openable and that is not an error.
 */
function openMessage(record, readingPrivPem) {
  let buf;
  try { buf = Buffer.from(record.data, 'hex'); } catch { return null; }
  if (buf.length < 2 || buf[0] !== KIND_MESSAGE) return null;
  let plain;
  try { plain = BOX.open(readingPrivPem, buf.subarray(1)); } catch { return null; }
  let env;
  try { env = JSON.parse(plain.toString('utf8')); } catch { return null; }
  if (!env || typeof env.body !== 'string') return null;
  return {
    body: env.body,
    sentAt: env.sentAt || null,
    replyTo: env.replyTo || null,
    // The signed truth about who sent it, not a field they filled in.
    from: record.from,
    to: record.key,
    txid: record.txid,
    height: record.height,
    minedAt: record.timestamp,
  };
}

/** Open everything openable in a list of records, oldest first. */
function readInbox(records, readingPrivPem) {
  return records.map(r => openMessage(r, readingPrivPem)).filter(Boolean);
}

module.exports = {
  APP, KIND_ANNOUNCE, KIND_MESSAGE, MAX_BODY_BYTES,
  announceRecord, readAnnounce, resolveReadingKey,
  messageRecord, openMessage, readInbox,
};
