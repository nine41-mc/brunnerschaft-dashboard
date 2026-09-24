// Brunnerschaft Push-Worker (Cloudflare)
// Speichert Web-Push-Abos in KV und verschickt Benachrichtigungen (RFC 8291 aes128gcm + RFC 8292 VAPID),
// komplett mit WebCrypto — keine Abhängigkeiten. Freitags-Tipp-Erinnerung via Cron-Trigger.

const corsFor = req => {
  const o = req.headers.get('Origin') || '';
  const allow = (o === 'https://nine41-mc.github.io' || /^http:\/\/localhost(:\d+)?$/.test(o)) ? o : 'https://nine41-mc.github.io';
  return { 'Access-Control-Allow-Origin': allow, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
};
let CORS = corsFor({ headers: { get: () => '' } }); // wird je Request gesetzt
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
    const rec = JSON.parse(raw);
    const sub = rec.subscription || rec;            // alte Einträge = rohes Abo
    const cats = rec.cats || {};
    if (msg.channel && cats[msg.channel] === false) continue; // Kanal abbestellt
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

// ---------- Mini-Analytics: anonyme Tageszähler in KV ----------
const dayKey = () => 'an_' + new Date().toISOString().slice(0, 10);
const bump = (d, k, key, max) => { if (!key || String(key).length > max) return; d[k] = d[k] || {}; d[k][key] = (d[k][key] || 0) + 1; };
async function trackHit(env, body, req) {
  const k = dayKey();
  let d = {}; try { d = JSON.parse(await env.SUBS.get(k) || '{}'); } catch (e) {}
  d.views = (d.views || 0) + (body.e === 'view' ? 1 : 0);
  if (body.e === 'view') {
    if (body.m) d.mobile = (d.mobile || 0) + 1;
    if (body.s) d.standalone = (d.standalone || 0) + 1;
    if (body.v) { d.vids = d.vids || {}; if (String(body.v).length <= 24) d.vids[body.v] = (d.vids[body.v] || 0) + 1; }
    bump(d, 'dev', body.d, 24); // grobes Geräte-Token (z. B. "iOS-Safari"), kein UA-String
    const hr = parseInt(new Intl.DateTimeFormat('de-DE', { hour: 'numeric', hour12: false, timeZone: 'Europe/Berlin' }).format(new Date()), 10);
    if (hr >= 0 && hr < 24) bump(d, 'hrs', hr, 2);
    const cc = (req && req.cf && req.cf.country) || ''; // nur Länderkürzel von Cloudflare — die IP wird nie gespeichert
    if (/^[A-Z]{2}$/.test(cc)) bump(d, 'geo', cc, 2);
  } else if (typeof body.e === 'string' && body.e.startsWith('tab:')) {
    const t = body.e.slice(4, 24); d.tabs = d.tabs || {}; d.tabs[t] = (d.tabs[t] || 0) + 1;
  } else if (typeof body.e === 'string' && body.e.startsWith('f:')) {
    bump(d, 'feat', body.e.slice(2, 26), 24);
  }
  await env.SUBS.put(k, JSON.stringify(d));
}
async function statsOut(env, days) {
  const out = [], w7 = new Set(), m30 = new Set();
  for (let i = 0; i < days; i++) {
    const dt = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    let d = {}; try { d = JSON.parse(await env.SUBS.get('an_' + dt) || '{}'); } catch (e) {}
    Object.keys(d.vids || {}).forEach(v => { if (i < 7) w7.add(v); m30.add(v); });
    out.push({ day: dt, views: d.views || 0, uniq: Object.keys(d.vids || {}).length,
      mobile: d.mobile || 0, standalone: d.standalone || 0, tabs: d.tabs || {},
      dev: d.dev || {}, hrs: d.hrs || {}, geo: d.geo || {}, feat: d.feat || {} });
  }
  return { days: out, wau: w7.size, mau: m30.size }; // WAU/MAU = Geräte-Vereinigung über 7/30 Tage
}
async function pushStats(env) {
  const list = await env.SUBS.list();
  const CH = ['p4', 'lead', 'done', 'bonus', 'remind'];
  const channels = {}; CH.forEach(c => channels[c] = 0);
  let total = 0;
  for (const k of list.keys) {
    if (k.name.startsWith('an_')) continue; // Analytics-Tageszähler überspringen
    const raw = await env.SUBS.get(k.name); if (!raw) continue;
    let rec; try { rec = JSON.parse(raw); } catch (e) { continue; }
    if (!((rec.subscription && rec.subscription.endpoint) || rec.endpoint)) continue;
    total++;
    const cats = rec.cats || {};
    CH.forEach(c => { if (cats[c] !== false) channels[c]++; }); // fehlend = abonniert
  }
  return { total, channels };
}

// ---------- 🤖 RoboSepp-Live-Kommentare: 1 Haiku-Batch-Call je Poll, KV-Cache je Tor ----------
async function quips(env, body) {
  const evs = Array.isArray(body.events) ? body.events.slice(0, 40) : [];
  const out = {};
  const missing = [];
  for (const e of evs) {
    if (!e || typeof e.id !== 'string' || !/^[\w:-]{4,60}$/.test(e.id)) continue;
    const hit = await env.SUBS.get('q_' + e.id);
    if (hit) out[e.id] = hit;
    else if (typeof e.ctx === 'string' && e.ctx.length <= 400) missing.push({ id: e.id, ctx: e.ctx });
  }
  if (missing.length && env.ANTHROPIC_API_KEY) {
    // Tagesdeckel gegen Missbrauch (die Seite ist öffentlich erreichbar)
    const capK = 'qcap_' + new Date().toISOString().slice(0, 10);
    const used = +(await env.SUBS.get(capK) || 0);
    if (used < 150) {
      const profiles = await env.SUBS.get('profiles') || '';
      const prompt = `Du bist RoboSepp, der KI-Tipper und Live-Tickerer der bayerisch angehauchten Kicktipp-Männerrunde "Brunnerschaft". Zu jedem der folgenden Tor-Ereignisse schreibst du GENAU EINEN frechen Ticker-Satz auf Deutsch (max. 110 Zeichen, Augenzwinkern, gern kleine Spitzen gegen die genannten Tipper, nie beleidigend, keine Emojis).${profiles ? `\n\nWas du über die Tipper weißt (nur nutzen, wenn es passt):\n${profiles.slice(0, 1500)}` : ''}\n\nEreignisse:\n${missing.map(m => m.id + ' | ' + m.ctx).join('\n')}\n\nAntworte NUR mit einem JSON-Array: [{"id":"...","q":"..."}]`;
      try {
        const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST',
          headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 1200, temperature: 0.8,
            messages: [{ role: 'user', content: prompt }] }) });
        if (r.ok) {
          const txt = (await r.json()).content?.[0]?.text || '';
          const arr = JSON.parse(txt.slice(txt.indexOf('['), txt.lastIndexOf(']') + 1));
          for (const it of arr) {
            const id = String(it.id || ''), q = String(it.q || '').slice(0, 160);
            if (missing.find(m => m.id === id) && q) { out[id] = q; await env.SUBS.put('q_' + id, q); }
          }
          await env.SUBS.put(capK, String(used + missing.length), { expirationTtl: 172800 });
        }
      } catch (e) {}
    }
  }
  return out;
}

// ---------- 🟨🔁 Karten & Wechsel via football-data.org (optionaler Token) ----------
async function fdEvents(env, season, md) {
  if (!env.FOOTBALL_DATA_TOKEN) return { events: [], enabled: false };
  const H = { 'X-Auth-Token': env.FOOTBALL_DATA_TOKEN };
  const lk = `fdl_${season}_${md}`;
  let list = null; try { list = JSON.parse(await env.SUBS.get(lk)); } catch (e) {}
  if (!list) {
    const r = await fetch(`https://api.football-data.org/v4/competitions/BL1/matches?season=${season}&matchday=${md}`, { headers: H });
    if (!r.ok) return { events: [], enabled: true, error: r.status };
    list = await r.json();
    await env.SUBS.put(lk, JSON.stringify(list), { expirationTtl: 300 });
  }
  const events = [];
  for (const m of (list.matches || [])) {
    if (!['IN_PLAY', 'PAUSED', 'FINISHED'].includes(m.status)) continue;
    const mk = 'fdm_' + m.id;
    let d = null; try { d = JSON.parse(await env.SUBS.get(mk)); } catch (e) {}
    if (!d) {
      const r = await fetch('https://api.football-data.org/v4/matches/' + m.id, { headers: H });
      if (!r.ok) continue; // Ratenlimit (10/min) — Rest kommt beim nächsten Poll
      d = await r.json();
      // fertige Spiele quasi für immer cachen, laufende nur kurz
      await env.SUBS.put(mk, JSON.stringify(d), { expirationTtl: m.status === 'FINISHED' ? 604800 : 90 });
    }
    const base = { h: m.homeTeam?.name, a: m.awayTeam?.name };
    (d.bookings || []).forEach(b => events.push({ ...base, t: b.card === 'RED_CARD' ? 'red' : 'yellow', min: b.minute, pl: b.player?.name || '' }));
    (d.substitutions || []).forEach(s => events.push({ ...base, t: 'sub', min: s.minute, plIn: s.playerIn?.name || '', plOut: s.playerOut?.name || '' }));
  }
  return { events, enabled: true };
}

export default {
  async fetch(req, env) {
    CORS = corsFor(req);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const url = new URL(req.url);
    if (req.method === 'GET' && url.pathname === '/events') {
      const season = Math.min(2099, Math.max(2020, +(url.searchParams.get('season') || 0)));
      const md = Math.min(34, Math.max(1, +(url.searchParams.get('md') || 0)));
      if (!season || !md) return json({ error: 'season+md?' }, 400);
      try { return json(await fdEvents(env, season, md)); } catch (e) { return json({ events: [], enabled: true, error: 'fetch' }); }
    }
    if (req.method === 'GET' && url.pathname === '/stats') {
      const days = Math.min(60, Math.max(1, +(url.searchParams.get('days') || 30)));
      const out = await statsOut(env, days); // nur anonyme Aggregate — keine IDs, keine Namen
      out.push = await pushStats(env);       // Abo-Gesamtzahl + aktive Kanäle, keine Endpoints
      return json(out);
    }
    if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
    if (url.pathname === '/hit') {
      const body = await req.json().catch(() => ({}));
      await trackHit(env, body || {}, req);
      return json({ ok: true });
    }

    if (url.pathname === '/subscribe') {
      const body = await req.json().catch(() => null);
      const sub = body && body.subscription;
      if (!sub || !sub.endpoint || !sub.keys) return json({ error: 'bad subscription' }, 400);
      const cats = (body.cats && typeof body.cats === 'object') ? body.cats : {};
      await env.SUBS.put(await subKey(sub.endpoint), JSON.stringify({ subscription: sub, cats }));
      return json({ ok: true });
    }
    if (url.pathname === '/unsubscribe') {
      const body = await req.json().catch(() => null);
      if (!body || !body.endpoint) return json({ error: 'bad request' }, 400);
      await env.SUBS.delete(await subKey(body.endpoint));
      return json({ ok: true });
    }
    if (url.pathname === '/quips') {
      const body = await req.json().catch(() => ({}));
      return json(await quips(env, body || {}));
    }
    if (url.pathname === '/profiles') { // Tipper-Profile (Bullets) — nur der Kassenwart schreibt, gelesen wird nur intern für Prompts
      if (req.headers.get('Authorization') !== `Bearer ${env.NOTIFY_SECRET}`) return json({ error: 'unauthorized' }, 401);
      const txt = await req.text();
      if (txt.length > 8000) return json({ error: 'too long' }, 400);
      await env.SUBS.put('profiles', txt);
      return json({ ok: true, chars: txt.length });
    }
    if (url.pathname === '/notify') {
      if (req.headers.get('Authorization') !== `Bearer ${env.NOTIFY_SECRET}`) return json({ error: 'unauthorized' }, 401);
      const msg = await req.json().catch(() => null);
      if (!msg || !msg.title) return json({ error: 'bad message' }, 400);
      return json(await broadcast(env, { title: msg.title, body: msg.body || '', tag: msg.tag || 'brun', channel: msg.channel || null, url: msg.url || 'https://nine41-mc.github.io/brunnerschaft-dashboard/' }));
    }
    return json({ error: 'not found' }, 404);
  },

  // Tipp-Erinnerung: Cron läuft täglich — gesendet wird NUR, wenn der nächste Spieltag
  // heute startet und noch kein Spiel angepfiffen wurde (Quelle: OpenLigaDB, aktueller Spieltag).
  async scheduled(event, env) {
    try {
      const md = await (await fetch('https://api.openligadb.de/getmatchdata/bl1')).json();
      const kos = (md || []).map(m => new Date(m.matchDateTimeUTC || m.matchDateTime || 0).getTime()).filter(Boolean);
      if (!kos.length) return;
      const first = Math.min(...kos);
      if (first <= Date.now()) return; // Spieltag läuft schon oder ist durch → nichts nerven
      const day = t => new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit' }).format(new Date(t));
      if (day(first) !== day(Date.now())) return; // erster Anstoß ist nicht heute → kein Reminder
      await broadcast(env, {
        title: '🖊️ Bald rollt der Ball!',
        body: 'Heute Abend startet der Spieltag. Schon getippt?',
        tag: 'brun-remind', channel: 'remind',
        url: 'https://www.kicktipp.de/brunnerschaft/tippabgabe',
      });
    } catch (e) {}
  },
};
