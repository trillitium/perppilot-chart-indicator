// Web Push with zero dependencies: VAPID (RFC 8292) + aes128gcm payload encryption (RFC 8291).
// Lets the installed app show real notifications on iPhone (16.4+, added to Home Screen), Android and desktop.
import { createECDH, createCipheriv, createPrivateKey, generateKeyPairSync, hkdfSync, randomBytes, sign } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const b64u = buf => Buffer.from(buf).toString('base64url');
export const unb64u = s => Buffer.from(s, 'base64url');

/** Load or create this server's VAPID key pair. */
export async function loadVapid(dir, subject) {
  const f = path.join(dir, 'vapid.json');
  let k;
  try { k = JSON.parse(await readFile(f, 'utf8')); }
  catch {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const jwk = privateKey.export({ format: 'jwk' }), pub = publicKey.export({ format: 'jwk' });
    k = { jwk, publicKey: b64u(Buffer.concat([Buffer.from([4]), unb64u(pub.x), unb64u(pub.y)])) };
    await writeFile(f, JSON.stringify(k), { mode: 0o600 });
  }
  return { publicKey: k.publicKey, key: createPrivateKey({ key: k.jwk, format: 'jwk' }), subject };
}

function vapidHeader(vapid, endpoint) {
  const aud = new URL(endpoint).origin;
  const header = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64u(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: vapid.subject }));
  const sig = sign('sha256', Buffer.from(`${header}.${claims}`), { key: vapid.key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${header}.${claims}.${b64u(sig)}, k=${vapid.publicKey}`;
}

/** Encrypt a payload for one subscription (RFC 8291, single record). */
export function encrypt(payload, keys, { salt = randomBytes(16), ecdh = null } = {}) {
  const uaPublic = unb64u(keys.p256dh), authSecret = unb64u(keys.auth);
  const as = ecdh || createECDH('prime256v1'); if (!ecdh) as.generateKeys();
  const asPublic = as.getPublicKey(), shared = as.computeSecret(uaPublic);
  const ikm = Buffer.from(hkdfSync('sha256', shared, authSecret, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const c = createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([c.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), c.final(), c.getAuthTag()]);
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body]);
}

/** Send one notification. Returns { ok, gone } — gone=true means the subscription is dead and should be deleted. */
export async function send(vapid, sub, data, { ttl = 86400, urgency = 'high' } = {}) {
  const body = encrypt(JSON.stringify(data), sub.keys);
  const r = await fetch(sub.endpoint, {
    method: 'POST', body, signal: AbortSignal.timeout(10000),
    headers: { Authorization: vapidHeader(vapid, sub.endpoint), 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: String(ttl), Urgency: urgency },
  });
  return { ok: r.ok, status: r.status, gone: r.status === 404 || r.status === 410 };
}
