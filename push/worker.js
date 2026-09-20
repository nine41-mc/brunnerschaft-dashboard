// Brunnerschaft Push-Worker (Cloudflare)
// Speichert Web-Push-Abos in KV und verschickt Benachrichtigungen (RFC 8291 aes128gcm + RFC 8292 VAPID),
// komplett mit WebCrypto — keine Abhängigkeiten. Freitags-Tipp-Erinnerung via Cron-Trigger.

const CORS = {
  'Access-Control-Allow-Origin': 'https://nine41-mc.github.io',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...CORS } });

// ---------- Base64url ----------
const b64uToBytes = s => { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; return Uint8Array.from(atob(s), c => c.charCodeAt(0)); };
const bytesToB64u = b => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const concat = (...arrs) => { const t = new Uint8Array(arrs.reduce((a, x) => a + x.length, 0)); let o = 0; for (const a of arrs) { t.set(a, o); o += a.length; } return t; };
const te = new TextEncoder();

// ---------- VAPID (RFC 8292): ES256-JWT ----------
async function vapidHeaders(endpoint, env) {
  const aud = new URL(endpoint).origin;
  const exp = Math.floor(Date.now() / 1000) + 12 * 3600;
  const pubBytes = b64uToBytes(env.VAPID_PUBLIC); // 65 Byte uncompressed point
  const d = env.VAPID_PRIVATE;                    // 32-Byte-Skalar, base64url
  const x = bytesToB64u(pubBytes.slice(1, 33)), y = bytesToB64u(pubBytes.slice(33, 65));
  const key = await crypto.subtle.importKey('jwk',
    { kty: 'EC', crv: 'P-256', d, x, y, ext: true, key_ops: ['sign'] },
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const enc = o => bytesToB64u(te.encode(JSON.stringify(o)));
  const input = enc({ typ: 'JWT', alg: 'ES256' }) + '.' + enc({ aud, exp, sub: 'mailto:manuel.cramer@nine41.io' /* VAPID-Betreiberkontakt — geht nur an die Push-Dienste */ });
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, te.encode(input)); // WebCrypto liefert r||s (raw) — genau was JWS braucht
  const jwt = input + '.' + bytesToB64u(sig);
  return { Authorization: `vapid t=${jwt}, k=${env.VAPID_PUBLIC}` };
}

// ---------- Payload-Verschlüsselung (RFC 8291, aes128gcm) ----------
async function hkdf(salt, ikm, info, len) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, len * 8));
}
async function encryptPayload(sub, payload) {
  const uaPub = b64uToBytes(sub.keys.p256dh);      // 65 Byte
  const authSecret = b64uToBytes(sub.keys.auth);   // 16 Byte
  const asKeys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPub = new Uint8Array(await crypto.subtle.exportKey('raw', asKeys.publicKey)); // 65 Byte
  const uaKey = await crypto.subtle.importKey('raw', uaPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, asKeys.privateKey, 256));
  const prk = await hkdf(authSecret, shared, concat(te.encode('WebPush: info\0'), uaPub, asPub), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, prk, te.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, prk, te.encode('Content-Encoding: nonce\0'), 12);
  const record = concat(te.encode(payload), new Uint8Array([2])); // 0x02 = letzter Record
  const gcmKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, gcmKey, record));
  // Header: salt(16) | rs(4) | idlen(1) | keyid(asPub, 65)
  const rs = new Uint8Array(4); new DataView(rs.buffer).setUint32(0, 4096);
  return concat(salt, rs, new Uint8Array([asPub.length]), asPub, ct);
}

async function sendPush(sub, payload, env) {
  const body = await encryptPayload(sub, payload);
  const headers = {
    ...(await vapidHeaders(sub.endpoint, env)),
    'Content-Encoding': 'aes128gcm',
    'Content-Type': 'application/octet-stream',
    'TTL': '3600',
    'Urgency': 'normal',
  };
  return fetch(sub.endpoint, { method: 'POST', headers, body });
}

// ---------- Versand an alle Abos ----------
async function broadcast(env, msg) {
  const list = await env.SUBS.list();
  let ok = 0, gone = 0, fail = 0;
  for (const k of list.keys) {
    const raw = await env.SUBS.get(k.name); if (!raw) continue;
    const sub = JSON.parse(raw);
    try {
      const r = await sendPush(sub, JSON.stringify(msg), env);
      if (r.status === 404 || r.status === 410) { await env.SUBS.delete(k.name); gone++; }
      else if (r.ok || r.status === 201) ok++;
      else fail++;
    } catch (e) { fail++; }
  }
  return { ok, gone, fail, total: list.keys.length };
}

async function subKey(endpoint) {
  const h = await crypto.subtle.digest('SHA-256', te.encode(endpoint));
  return bytesToB64u(h).slice(0, 32);
}

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const url = new URL(req.url);
    if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

    if (url.pathname === '/subscribe') {
      const body = await req.json().catch(() => null);
      const sub = body && body.subscription;
      if (!sub || !sub.endpoint || !sub.keys) return json({ error: 'bad subscription' }, 400);
      await env.SUBS.put(await subKey(sub.endpoint), JSON.stringify(sub));
      return json({ ok: true });
    }
    if (url.pathname === '/unsubscribe') {
      const body = await req.json().catch(() => null);
      if (!body || !body.endpoint) return json({ error: 'bad request' }, 400);
      await env.SUBS.delete(await subKey(body.endpoint));
      return json({ ok: true });
    }
    if (url.pathname === '/notify') {
      if (req.headers.get('Authorization') !== `Bearer ${env.NOTIFY_SECRET}`) return json({ error: 'unauthorized' }, 401);
      const msg = await req.json().catch(() => null);
      if (!msg || !msg.title) return json({ error: 'bad message' }, 400);
      return json(await broadcast(env, { title: msg.title, body: msg.body || '', tag: msg.tag || 'brun', url: msg.url || 'https://nine41-mc.github.io/brunnerschaft-dashboard/' }));
    }
    return json({ error: 'not found' }, 404);
  },

  // Freitags-Tipp-Erinnerung (Cron in wrangler.toml, UTC)
  async scheduled(event, env) {
    await broadcast(env, {
      title: '🖊️ Bald rollt der Ball!',
      body: 'Heute Abend startet der Spieltag. Schon getippt?',
      tag: 'brun-remind',
      url: 'https://www.kicktipp.de/brunnerschaft/tippabgabe',
    });
  },
};
