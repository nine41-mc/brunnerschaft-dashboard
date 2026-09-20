// 🤖 RoboBrunner — der 13. Tipper.
// Baut aus den bisherigen Saisonergebnissen ein kleines Tor-Modell (Angriff/Abwehr je Team,
// Heimvorteil, Shrinkage zum Ligaschnitt) und tippt den nächsten Spieltag deterministisch.
// Dry-Run:  node robo.js --dry          (zeigt nur die Tipps)
// Ernst:    KICKTIPP_BOT_EMAIL/KICKTIPP_BOT_PASSWORD gesetzt -> loggt ein und gibt ab.
import { JSDOM } from 'jsdom';

const SEASON = '5422358';
const BASE = 'https://www.kicktipp.de/brunnerschaft/';
const UA = { 'User-Agent': 'RoboBrunner/1.0 (Brunnerschaft-Tipprunde)' };
const DRY = process.argv.includes('--dry');

const fetchDoc = async (url, opts = {}) => {
  const r = await fetch(url, { headers: { ...UA, ...(opts.headers || {}) }, ...opts });
  return { doc: new JSDOM(await r.text()).window.document, res: r };
};

// ---------- Spielplan + Ergebnisse ----------
async function matchday(mi) {
  const { doc } = await fetchDoc(`${BASE}tippuebersicht?tippsaisonId=${SEASON}&spieltagIndex=${mi}`);
  const sp = doc.querySelector('#spielplanSpiele'); if (!sp) return null;
  const games = [];
  for (const tr of [...sp.rows].slice(1)) {
    const c = [...tr.cells]; if (c.length < 3) continue;
    const rm = (c[3]?.textContent.trim() || '').match(/^(\d+):(\d+)$/);
    games.push({ h: c[1].textContent.trim(), a: c[2].textContent.trim(), rh: rm ? +rm[1] : null, ra: rm ? +rm[2] : null });
  }
  return games;
}

// ---------- Modell ----------
function buildModel(results) {
  const teams = {}; let gh = 0, ga = 0, n = 0;
  const T = t => teams[t] || (teams[t] = { gf: 0, gc: 0, gfH: 0, gaH: 0, n: 0 });
  for (const g of results) { T(g.h); T(g.a);
    teams[g.h].gf += g.rh; teams[g.h].gc += g.ra; teams[g.h].n++;
    teams[g.a].gf += g.ra; teams[g.a].gc += g.rh; teams[g.a].n++;
    gh += g.rh; ga += g.ra; n++;
  }
  const avgH = n ? gh / n : 1.6, avgA = n ? ga / n : 1.3, avg = (avgH + avgA) / 2;
  const K = 4; // Shrinkage: frühe Saison nicht überinterpretieren
  const att = t => { const x = teams[t]; return x ? ((x.gf / Math.max(1, x.n)) * x.n + avg * K) / (x.n + K) / avg : 1; };
  const def = t => { const x = teams[t]; return x ? ((x.gc / Math.max(1, x.n)) * x.n + avg * K) / (x.n + K) / avg : 1; };
  return { avgH, avgA, att, def };
}

// deterministischer Zufall je Spieltag (gleiche Tipps bei jedem Lauf)
function rngFor(seedStr) {
  let seed = 0; for (const ch of seedStr) seed = (seed * 31 + ch.charCodeAt(0)) | 0;
  return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function predict(model, g, rng) {
  const xh = model.avgH * model.att(g.h) * model.def(g.a);
  const xa = model.avgA * model.att(g.a) * model.def(g.h);
  // Erwartung in einen knackigen Tipp übersetzen (leichtes Würfeln um die Erwartung, klassiker-freundlich)
  const draw = v => { const f = Math.floor(v); return f + (rng() < (v - f) ? 1 : 0); };
  let th = Math.max(0, Math.min(5, draw(xh)));
  let ta = Math.max(0, Math.min(5, draw(xa)));
  if (th === ta && Math.abs(xh - xa) > 0.45) (xh > xa) ? th++ : ta++; // klare Favoriten nicht ins Remis würfeln
  return [th, ta];
}

// ---------- Kicktipp-Login + Abgabe ----------
async function submit(tips) {
  const email = process.env.KICKTIPP_BOT_EMAIL, pass = process.env.KICKTIPP_BOT_PASSWORD;
  if (!email || !pass) { console.log('Keine Bot-Zugangsdaten — nichts abgegeben.'); return false; }
  const jar = {};
  const cook = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
  const grab = r => { for (const c of (r.headers.getSetCookie?.() || [])) { const m = c.match(/^([^=]+)=([^;]+)/); if (m) jar[m[1]] = m[2]; } };
  // Login
  const r1 = await fetch('https://www.kicktipp.de/info/profil/loginaction', {
    method: 'POST', redirect: 'manual',
    headers: { ...UA, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ kennung: email, passwort: pass, submitbutton: 'Anmelden' }),
  });
  grab(r1);
  if (!jar.login) { console.error('Login fehlgeschlagen (kein Login-Cookie).'); return false; }
  // Tippabgabe-Formular laden
  const r2 = await fetch(`${BASE}tippabgabe?tippsaisonId=${SEASON}`, { headers: { ...UA, Cookie: cook() } });
  grab(r2);
  const doc = new JSDOM(await r2.text()).window.document;
  const form = doc.querySelector('form#tippabgabeForm, form[action*="tippabgabe"]');
  if (!form) { console.error('Tippabgabe-Formular nicht gefunden.'); return false; }
  const params = new URLSearchParams();
  for (const inp of form.querySelectorAll('input[type=hidden]')) params.set(inp.name, inp.value);
  // Felder je Spiel: die Reihen enthalten Heim/Gast-Inputs (Namen enden auf heimTipp/gastTipp)
  const rows = [...form.querySelectorAll('tr')].filter(tr => tr.querySelector('input[name$="heimTipp"]'));
  if (rows.length !== tips.length) console.warn(`Formular hat ${rows.length} Spiele, Modell ${tips.length} — fülle der Reihe nach.`);
  rows.forEach((tr, i) => {
    const hi = tr.querySelector('input[name$="heimTipp"]'), ai = tr.querySelector('input[name$="gastTipp"]');
    if (hi && ai && tips[i]) { params.set(hi.name, String(tips[i].th)); params.set(ai.name, String(tips[i].ta)); }
  });
  params.set('submitbutton', 'Tipps speichern');
  const action = new URL(form.getAttribute('action') || `${BASE}tippabgabe`, BASE).href;
  const r3 = await fetch(action, { method: 'POST', redirect: 'manual',
    headers: { ...UA, Cookie: cook(), 'Content-Type': 'application/x-www-form-urlencoded' }, body: params });
  console.log('Abgabe-Antwort:', r3.status);
  return r3.status < 400;
}

// ---------- Hauptlauf ----------
(async () => {
  // gespielte Spieltage sammeln + nächsten (ohne Ergebnisse) finden
  const results = []; let next = null, nextNo = 0;
  for (let mi = 1; mi <= 34; mi++) {
    const g = await matchday(mi); if (!g || !g.length) break;
    const done = g.filter(x => x.rh != null);
    results.push(...done);
    if (done.length < g.length) { next = g; nextNo = mi; break; }
  }
  if (!next) { console.log('Kein offener Spieltag gefunden.'); process.exit(0); }
  const model = buildModel(results);
  const rng = rngFor(SEASON + '-' + nextNo);
  const tips = next.filter(g => g.rh == null).map(g => { const [th, ta] = predict(model, g, rng); return { ...g, th, ta }; });
  console.log(`🤖 RoboBrunner tippt den ${nextNo}. Spieltag (Modell aus ${results.length} Ergebnissen):`);
  for (const t of tips) console.log(`   ${t.h} – ${t.a}:  ${t.th}:${t.ta}`);
  if (DRY) { console.log('(Dry-Run — nichts abgegeben)'); process.exit(0); }
  const ok = await submit(tips);
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error('ROBO FEHLER:', e.message); process.exit(1); });
