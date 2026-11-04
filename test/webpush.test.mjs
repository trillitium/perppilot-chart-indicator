import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createECDH, createDecipheriv, hkdfSync, randomBytes, createPublicKey, verify } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { encrypt, loadVapid, b64u, unb64u } from '../lib/webpush.mjs';

// Independent receiver-side decryption, written straight from RFC 8291 §3.4 / RFC 8188.
function decrypt(buf, uaECDH, authSecret) {
  const salt = buf.subarray(0, 16), rs = buf.readUInt32BE(16), idlen = buf[20], asPublic = buf.subarray(21, 21 + idlen), ct = buf.subarray(21 + idlen);
  assert.equal(rs, 4096);
  const uaPublic = uaECDH.getPublicKey(), shared = uaECDH.computeSecret(asPublic);
  const ikm = Buffer.from(hkdfSync('sha256', shared, authSecret, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const d = createDecipheriv('aes-128-gcm', cek, nonce); d.setAuthTag(ct.subarray(ct.length - 16));
  const pt = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  assert.equal(pt[pt.length - 1], 2, 'last-record delimiter');
  return pt.subarray(0, pt.length - 1).toString();
}

test('payload round-trips through RFC 8291 encryption', () => {
  const ua = createECDH('prime256v1'); ua.generateKeys(); const auth = randomBytes(16);
  const msg = JSON.stringify({ title: 'HL:SOL · RANGE EXIT', body: 'Bot-Heiko · 92.10 ✓ ümlaut' });
  const out = encrypt(msg, { p256dh: b64u(ua.getPublicKey()), auth: b64u(auth) });
  assert.equal(decrypt(out, ua, auth), msg);
});

test('VAPID key is a valid P-256 key and persists', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cs-'));
  const a = await loadVapid(dir, 'mailto:test@example.com'), b = await loadVapid(dir, 'mailto:test@example.com');
  assert.equal(a.publicKey, b.publicKey);
  assert.equal(unb64u(a.publicKey).length, 65);
  // signature made with the stored private key verifies against the advertised public key
  const raw = unb64u(a.publicKey);
  const pub = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(raw.subarray(1, 33)), y: b64u(raw.subarray(33)) }, format: 'jwk' });
  const { sign } = await import('node:crypto');
  const sig = sign('sha256', Buffer.from('x'), { key: a.key, dsaEncoding: 'ieee-p1363' });
  assert.ok(verify('sha256', Buffer.from('x'), { key: pub, dsaEncoding: 'ieee-p1363' }, sig));
});
