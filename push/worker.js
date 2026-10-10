// Brunnerschaft Push-Worker (Cloudflare)
// Speichert Web-Push-Abos in KV und verschickt Benachrichtigungen (RFC 8291 aes128gcm + RFC 8292 VAPID),
// komplett mit WebCrypto — keine Abhängigkeiten. Freitags-Tipp-Erinnerung via Cron-Trigger.

const corsFor = req => {
  const o = req.headers.get('Origin') || '';
  const allow = (o === 'https://nine41-mc.github.io' || /^http:\/\/localhost(:\d+)?$/.test(o)) ? o : 'https://nine41-mc.github.io';
  return { 'Access-Control-Allow-Origin': allow, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
};
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
const withCors = (res, req) => { const h = new Headers(res.headers); for (const [k, v] of Object.entries(corsFor(req))) h.set(k, v); return new Response(res.body, { status: res.status, headers: h }); };
// Kurzlebiger Speicher je Worker-Instanz — spart KV-Lese-/Schreibkontingent (Free Tier: 1000 Writes/Tag)
const MEM = new Map();
const memGet = k => { const e = MEM.get(k); return e && e.exp > Date.now() ? e.v : undefined; };
const memSet = (k, v, ms) => { MEM.set(k, { v, exp: Date.now() + ms }); if (MEM.size > 200) MEM.delete(MEM.keys().next().value); return v; };

// ---------- Base64url ----------
const b64uToBytes = s => { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; return Uint8Array.from(atob(s), c => c.charCodeAt(0)); };
const bytesToB64u = b => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const concat = (...arrs) => { const t = new Uint8Array(arrs.reduce((a, x) => a + x.length, 0)); let o = 0; for (const a of arrs) { t.set(a, o); o += a.length; } return t; };
const te = new TextEncoder();

// ---------- VAPID (RFC 8292): ES256-JWT ----------
async function vapidHeaders(endpoint, env) {
  const aud = new URL(endpoint).origin;
  const cached = memGet('vapid_' + aud); if (cached) return cached;
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
  return memSet('vapid_' + aud, { Authorization: `vapid t=${jwt}, k=${env.VAPID_PUBLIC}` }, 3600 * 1000);
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
// Abos liegen unter "sub_<hash>" — getrennt von Analytics, Sprüchen & Caches im selben Namespace.
const SUB_PREFIX = 'sub_';
async function listNames(env, prefix) { // KV liefert max. 1000 Keys pro Seite → Cursor durchblättern
  const names = []; let cursor;
  do {
    const r = await env.SUBS.list(prefix ? { prefix, cursor } : { cursor });
    for (const k of r.keys) names.push(k.name);
    cursor = r.list_complete ? null : r.cursor;
  } while (cursor);
  return names;
}
async function subNames(env) {
  const names = await listNames(env, SUB_PREFIX);
  // Einmal-Umzug: Abos von vor 10/2026 lagen ohne Präfix (32-Zeichen-Hash) im Namespace
  if (!(await env.SUBS.get('meta_subs_v2'))) {
    const legacy = (await listNames(env)).filter(n => /^[\w-]{32}$/.test(n));
    for (const n of legacy) {
      const raw = await env.SUBS.get(n);
      try { const rec = JSON.parse(raw); if (!((rec.subscription || rec).endpoint)) continue; } catch (e) { continue; }
      await env.SUBS.put(SUB_PREFIX + n, raw);
      await env.SUBS.delete(n);
      if (!names.includes(SUB_PREFIX + n)) names.push(SUB_PREFIX + n);
    }
    await env.SUBS.put('meta_subs_v2', '1');
  }
  return names;
}
async function readSub(env, name) { // null bei allem, was kein gültiges Abo ist — wirft nie
  try {
    const rec = JSON.parse(await env.SUBS.get(name));
    const sub = rec && (rec.subscription || rec); // alte Einträge = rohes Abo
    return sub && sub.endpoint && sub.keys ? { sub, cats: rec.cats || {} } : null;
  } catch (e) { return null; }
}
async function broadcast(env, msg) {
  const names = await subNames(env);
  let ok = 0, gone = 0, fail = 0, skipped = 0;
  for (const name of names) {
    const s = await readSub(env, name); if (!s) { skipped++; continue; }
    if (msg.channel && s.cats[msg.channel] === false) continue; // Kanal abbestellt
    try {
      const r = await sendPush(s.sub, JSON.stringify(msg), env);
      if (r.status === 404 || r.status === 410) { await env.SUBS.delete(name); gone++; }
      else if (r.ok || r.status === 201) ok++;
      else fail++;
    } catch (e) { fail++; }
  }
  return { ok, gone, fail, skipped, total: names.length };
}

async function subKey(endpoint) {
  const h = await crypto.subtle.digest('SHA-256', te.encode(endpoint));
  return bytesToB64u(h).slice(0, 32);
}

// ---------- Mini-Analytics: anonyme Tageszähler in KV ----------
const dayKey = () => 'an_' + new Date().toISOString().slice(0, 10);
const bump = (d, k, key, max) => { if (!key || String(key).length > max) return; d[k] = d[k] || {}; d[k][key] = (d[k][key] || 0) + 1; };
const TABS = new Set(['stats', 'kessel', 'bayern', 'fin', 'analytics', 'settings']);
const FEATS = new Set(['share', 'racefull', 'robo', 'en', 'mdsel']);
const HIT_BUDGET = 300; // max. KV-Writes/Tag für Analytics — der Rest des Kontingents bleibt für Abos & Co.
async function trackHit(env, body, req) {
  const k = dayKey();
  let d = {}; try { d = JSON.parse(await env.SUBS.get(k) || '{}'); } catch (e) {}
  if ((d._w || 0) >= HIT_BUDGET) return; // Budget erschöpft → heute nicht mehr zählen
  d._w = (d._w || 0) + 1;
  d.views = (d.views || 0) + (body.e === 'view' ? 1 : 0);
  if (body.e === 'view') {
    if (body.m) d.mobile = (d.mobile || 0) + 1;
    if (body.s) d.standalone = (d.standalone || 0) + 1;
    if (typeof body.v === 'string' && /^[a-z0-9]{6,16}$/.test(body.v)) { d.vids = d.vids || {}; if (d.vids[body.v] || Object.keys(d.vids).length < 200) d.vids[body.v] = (d.vids[body.v] || 0) + 1; }
    if (typeof body.d === 'string' && /^[A-Za-z?]{1,8}-[A-Za-z?]{1,8}$/.test(body.d)) bump(d, 'dev', body.d, 24); // grobes Geräte-Token (z. B. "iOS-Safari"), kein UA-String
    const hr = parseInt(new Intl.DateTimeFormat('de-DE', { hour: 'numeric', hour12: false, timeZone: 'Europe/Berlin' }).format(new Date()), 10);
    if (hr >= 0 && hr < 24) bump(d, 'hrs', hr, 2);
    const cc = (req && req.cf && req.cf.country) || ''; // nur Länderkürzel von Cloudflare — die IP wird nie gespeichert
    if (/^[A-Z]{2}$/.test(cc)) bump(d, 'geo', cc, 2);
  } else if (typeof body.e === 'string' && body.e.startsWith('tab:')) {
    const t = body.e.slice(4); if (!TABS.has(t)) return; d.tabs = d.tabs || {}; d.tabs[t] = (d.tabs[t] || 0) + 1;
  } else if (typeof body.e === 'string' && body.e.startsWith('f:')) {
    const f = body.e.slice(2); if (!FEATS.has(f)) return; bump(d, 'feat', f, 24);
  } else return;
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
  const CH = ['p4', 'lead', 'done', 'bonus', 'remind'];
  const channels = {}; CH.forEach(c => channels[c] = 0);
  let total = 0;
  for (const name of await subNames(env)) {
    const s = await readSub(env, name); if (!s) continue;
    total++;
    CH.forEach(c => { if (s.cats[c] !== false) channels[c]++; }); // fehlend = abonniert
  }
  return { total, channels };
}

// ---------- 🤖 RoboSepp-Live-Kommentare ----------
// Der Client schickt nur Tor-IDs (+ welche Tipper betroffen sind, aus fester Namensliste). Spielstand, Minute
// und Torschütze holt der Worker selbst von OpenLigaDB — so landet kein fremder Text im Prompt oder im Cache.
const TIPPER = new Set(['Claus', 'Manu', 'Lutz', 'Tobi', 'MaxSen', 'MaxJun', 'Ben', 'Elias', 'Luisa', 'Marie', 'Billy', 'Matthew']);
const QUIP_CAP = 120; // LLM-Tore pro Tag (ein Spieltag hat ~30)
async function olMatchday(yr, md) {
  const k = `ol_${yr}_${md}`; const c = memGet(k); if (c) return c;
  const r = await fetch(`https://api.openligadb.de/getmatchdata/bl1/${yr}/${md}`);
  return memSet(k, r.ok ? await r.json() : [], 45 * 1000);
}
async function quips(env, body) {
  const yr = +body.yr, md = +body.md;
  if (!(yr >= 2024 && yr <= 2040 && md >= 1 && md <= 34)) return {};
  const qk = `qm_${yr}_${md}`; // alle Sprüche eines Spieltags in EINEM Key → 1 Read pro Poll statt 1 pro Tor
  let map = memGet(qk);
  if (!map) { try { map = JSON.parse(await env.SUBS.get(qk)) || {}; } catch (e) { map = {}; } memSet(qk, map, 30 * 1000); }
  const evs = Array.isArray(body.events) ? body.events.slice(0, 60) : [];
  const out = {}, want = [];
  for (const e of evs) {
    const gid = String(e && e.gid || ''); if (!/^\d{1,9}$/.test(gid)) continue;
    if (map[gid]) out[gid] = map[gid];
    else want.push({ gid, exact: (e.exact || []).filter(n => TIPPER.has(n)).slice(0, 6), gegen: (e.gegen || []).filter(n => TIPPER.has(n)).slice(0, 4) });
  }
  if (!want.length || !env.ANTHROPIC_API_KEY) return out;
  // Fakten nur aus OpenLigaDB — unbekannte Tor-IDs werden verworfen
  const goals = {};
  for (const m of await olMatchday(yr, md)) for (const g of (m.goals || []))
    goals[g.goalID] = { min: g.matchMinute, st: g.scoreTeam1 + ':' + g.scoreTeam2, who: (g.goalGetterName || '').slice(0, 40),
      game: (m.team1?.shortName || m.team1?.teamName) + ' – ' + (m.team2?.shortName || m.team2?.teamName), pen: g.isPenalty, og: g.isOwnGoal };
  const missing = want.filter(w => goals[w.gid]).slice(0, 12);
  if (!missing.length || memGet('llm_off')) return out; // Key ungültig → 10 Min Pause statt Limit zu verbrennen
  // Tagesdeckel VOR dem Call hochzählen — parallele Anfragen können ihn so nicht umgehen
  const capK = 'qcap_' + new Date().toISOString().slice(0, 10);
  const used = +(await env.SUBS.get(capK) || 0);
  if (used >= QUIP_CAP) return out;
  await env.SUBS.put(capK, String(used + missing.length), { expirationTtl: 172800 });
  const ctx = w => { const g = goals[w.gid];
    return `${w.gid} | ${g.min || '?'}. Min, ${g.st} ${g.game}, Tor: ${g.who || '?'}${g.pen ? ' (Elfmeter)' : ''}${g.og ? ' (Eigentor)' : ''}.`
      + (w.exact.length ? ` Tipp steht jetzt exakt bei: ${w.exact.join(', ')}.` : '') + (w.gegen.length ? ` Aufs Gegenteil getippt: ${w.gegen.join(', ')}.` : ''); };
  const profiles = await env.SUBS.get('profiles') || '';
  const prompt = `Du bist RoboSepp, der KI-Tipper und Live-Tickerer der bayerisch angehauchten Kicktipp-Männerrunde "Brunnerschaft". Zu jedem der folgenden Tor-Ereignisse schreibst du GENAU EINEN frechen Ticker-Satz auf Deutsch (max. 110 Zeichen, Augenzwinkern, gern kleine Spitzen gegen die genannten Tipper, nie beleidigend, keine Emojis). WICHTIG: Elias, Luisa und Marie sind Kinder — bei ihnen nie Alkohol-, Kneipen- oder Kater-Anspielungen; wenn ein Getränk, dann Apfelschorle oder Robby Bubble, und der Spott bleibt lieb. Erwähne nie Modelle, Statistiken oder Berechnungen.${profiles ? `\n\nHintergrundwissen über die Tipper (nur für Anspielungen, nie wörtlich zitieren oder auflisten):\n${profiles.slice(0, 1500)}` : ''}\n\nEreignisse:\n${missing.map(ctx).join('\n')}\n\nAntworte NUR mit einem JSON-Array: [{"id":"<Zahl vor dem |>","q":"..."}]`;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST',
      headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json',
        // Keys ohne Workspace-Bindung verlangen die Workspace-ID je Anfrage (optionales Secret)
        ...(env.ANTHROPIC_WORKSPACE_ID ? { 'anthropic-workspace-id': env.ANTHROPIC_WORKSPACE_ID } : {}) },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 1200, temperature: 0.8, messages: [{ role: 'user', content: prompt }] }) });
    if (!r.ok) {
      const errTxt = r.status === 400 ? await r.text().catch(() => '') : '';
      if (r.status === 401 || r.status === 403 || /api key|workspace/i.test(errTxt)) memSet('llm_off', 1, 10 * 60 * 1000); // Key-Problem → Pause
      await env.SUBS.put(capK, String(used), { expirationTtl: 172800 }); // Fehlversuch zählt nicht ins Tageslimit
      return out;
    }
    const txt = (await r.json()).content?.[0]?.text || '';
    const arr = JSON.parse(txt.slice(txt.indexOf('['), txt.lastIndexOf(']') + 1));
    let added = 0;
    for (const it of arr) {
      const gid = String(it.id || ''), q = String(it.q || '').replace(/\s+/g, ' ').trim().slice(0, 160);
      if (q && missing.find(m => m.gid === gid) && !map[gid]) { map[gid] = q; out[gid] = q; added++; }
    }
    if (added) { await env.SUBS.put(qk, JSON.stringify(map), { expirationTtl: 90 * 86400 }); memSet(qk, map, 30 * 1000); }
  } catch (e) {}
  return out;
}

// ---------- 🟨🔁 Karten & Wechsel via football-data.org (optionaler Token) ----------
const curSeason = () => { const d = new Date(); return d.getUTCMonth() >= 6 ? d.getUTCFullYear() : d.getUTCFullYear() - 1; };
async function fdEvents(env, season, md) {
  if (!env.FOOTBALL_DATA_TOKEN) return { events: [], enabled: false };
  const H = { 'X-Auth-Token': env.FOOTBALL_DATA_TOKEN };
  const lk = `fdl_${season}_${md}`;
  let list = memGet(lk);
  if (!list) {
    const r = await fetch(`https://api.football-data.org/v4/competitions/BL1/matches?season=${season}&matchday=${md}`, { headers: H });
    if (!r.ok) return { events: [], enabled: true, error: r.status };
    list = memSet(lk, await r.json(), 60 * 1000);
  }
  const events = []; let fetched = 0;
  for (const m of (list.matches || [])) {
    if (!['IN_PLAY', 'PAUSED', 'FINISHED'].includes(m.status)) continue;
    const mk = 'fdm_' + m.id, done = m.status === 'FINISHED';
    let d = memGet(mk);
    if (!d && done) { try { d = JSON.parse(await env.SUBS.get(mk)); } catch (e) {} if (d) memSet(mk, d, 3600 * 1000); }
    if (!d && fetched < 8) { // football-data erlaubt 10 Calls/Minute
      fetched++;
      const r = await fetch('https://api.football-data.org/v4/matches/' + m.id, { headers: H });
      if (!r.ok) continue;
      d = memSet(mk, await r.json(), done ? 3600 * 1000 : 75 * 1000);
      if (done) await env.SUBS.put(mk, JSON.stringify(d), { expirationTtl: 30 * 86400 }); // KV-Write nur 1× pro Spiel
    }
    if (!d) continue;
    const base = { h: m.homeTeam?.name, a: m.awayTeam?.name };
    (d.bookings || []).forEach(b => events.push({ ...base, t: b.card === 'RED_CARD' ? 'red' : 'yellow', min: b.minute, pl: b.player?.name || '' }));
    (d.substitutions || []).forEach(x => events.push({ ...base, t: 'sub', min: x.minute, plIn: x.playerIn?.name || '', plOut: x.playerOut?.name || '' }));
  }
  return { events, enabled: true };
}

// Nur echte Web-Push-Dienste als Ziel — sonst ließe sich der Worker als Request-Schleuder missbrauchen
const PUSH_HOSTS = /^(fcm\.googleapis\.com|[\w.-]+\.push\.apple\.com|updates\.push\.services\.mozilla\.com|[\w.-]+\.notify\.windows\.com|[\w.-]+\.push\.services\.mozilla\.com)$/;
const MAX_SUBS = 150;

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsFor(req) });
    return withCors(await route(req, env), req);
  },
  scheduled: (event, env) => event.cron === '*/5 * * * *' ? liveKick(env) : remind(event, env),
};

async function route(req, env) {
    const url = new URL(req.url);
    if (req.method === 'GET' && url.pathname === '/events') {
      const season = +url.searchParams.get('season'), md = +url.searchParams.get('md');
      if (season !== curSeason() || !(md >= 1 && md <= 34)) return json({ events: [], enabled: true, error: 'season' }, 400);
      try { return json(await fdEvents(env, season, md)); } catch (e) { return json({ events: [], enabled: true, error: 'fetch' }); }
    }
    if (req.method === 'GET' && url.pathname === '/stats') {
      const days = Math.min(60, Math.max(1, +(url.searchParams.get('days') || 30)));
      const ck = 'stats_' + days; let out = memGet(ck);
      if (!out) {
        out = await statsOut(env, days);       // nur anonyme Aggregate — keine IDs, keine Namen
        out.push = await pushStats(env);       // Abo-Gesamtzahl + aktive Kanäle, keine Endpoints
        memSet(ck, out, 60 * 1000);
      }
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
      if (!sub || typeof sub.endpoint !== 'string' || !sub.keys || typeof sub.keys.p256dh !== 'string' || typeof sub.keys.auth !== 'string') return json({ error: 'bad subscription' }, 400);
      let host = ''; try { const u = new URL(sub.endpoint); if (u.protocol === 'https:') host = u.hostname; } catch (e) {}
      if (!PUSH_HOSTS.test(host)) return json({ error: 'unsupported push service' }, 400);
      const key = SUB_PREFIX + await subKey(sub.endpoint);
      if (!(await env.SUBS.get(key)) && (await listNames(env, SUB_PREFIX)).length >= MAX_SUBS) return json({ error: 'full' }, 429);
      const cats = {}; if (body.cats && typeof body.cats === 'object') for (const c of ['p4', 'lead', 'done', 'bonus', 'remind']) if (body.cats[c] === false) cats[c] = false;
      const clean = { endpoint: sub.endpoint, expirationTime: null, keys: { p256dh: sub.keys.p256dh.slice(0, 200), auth: sub.keys.auth.slice(0, 64) } };
      await env.SUBS.put(key, JSON.stringify({ subscription: clean, cats }));
      return json({ ok: true });
    }
    if (url.pathname === '/unsubscribe') {
      const body = await req.json().catch(() => null);
      if (!body || !body.endpoint) return json({ error: 'bad request' }, 400);
      const k = await subKey(body.endpoint);
      await env.SUBS.delete(SUB_PREFIX + k);
      await env.SUBS.delete(k); // Altbestand ohne Präfix
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
}

// ⚡ Live-Anstoß: GitHub verschluckt geplante Workflows an Spieltagen gern komplett (z. B. 09.10.2026).
// Cloudflare-Crons laufen zuverlässig — darum stößt der Worker alle 5 Min den Deploy an, solange ein Spiel läuft.
// Braucht das Secret GH_DISPATCH_TOKEN (Fine-grained PAT, nur dieses Repo, „Actions: Read and write").
async function liveKick(env) {
  if (!env.GH_DISPATCH_TOKEN) return;
  try {
    const md = await (await fetch('https://api.openligadb.de/getmatchdata/bl1')).json();
    const now = Date.now();
    const live = (md || []).some(m => { const k = new Date(m.matchDateTimeUTC || m.matchDateTime || 0).getTime();
      return k && now >= k - 5 * 60000 && now <= k + 135 * 60000; }); // Anpfiff −5 bis +135 Min (inkl. Nachspielzeit + Endstand)
    if (!live) return;
    await fetch('https://api.github.com/repos/nine41-mc/brunnerschaft-dashboard/actions/workflows/deploy.yml/dispatches', {
      method: 'POST', body: JSON.stringify({ ref: 'main' }),
      headers: { Authorization: `Bearer ${env.GH_DISPATCH_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'brunnerschaft-worker' } });
  } catch (e) {}
}

// Tipp-Erinnerung: zwei Crons (08:00 + 15:00 UTC). Gesendet wird nur am Tag des ersten Anstoßes:
// frühe Spieltage (erster Anpfiff bis 16:00 UTC, z. B. Sa 15:30) vom Morgen-Lauf, alle anderen vom Nachmittags-Lauf.
async function remind(event, env) {
    try {
      const md = await (await fetch('https://api.openligadb.de/getmatchdata/bl1')).json();
      const kos = (md || []).map(m => new Date(m.matchDateTimeUTC || m.matchDateTime || 0).getTime()).filter(Boolean);
      if (!kos.length) return;
      const first = Math.min(...kos);
      if (first <= Date.now()) return; // Spieltag läuft schon oder ist durch → nichts nerven
      const day = t => new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit' }).format(new Date(t));
      if (day(first) !== day(Date.now())) return; // erster Anstoß ist nicht heute → kein Reminder
      const early = new Date(first).getUTCHours() < 16;
      const morningRun = new Date().getUTCHours() < 12;
      if (early !== morningRun) return; // den jeweils passenden Lauf nehmen — nie doppelt
      const hm = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit' }).format(new Date(first));
      await broadcast(env, {
        title: '🖊️ Bald rollt der Ball!',
        body: `Heute um ${hm} Uhr startet der Spieltag. Schon getippt?`,
        tag: 'brun-remind', channel: 'remind',
        url: 'https://www.kicktipp.de/brunnerschaft/tippabgabe',
      });
    } catch (e) {}
}
