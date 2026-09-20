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
  // Liga-Basiswerte an den langjährigen Bundesliga-Schnitt ankern (~1,65 heim / ~1,30 auswärts):
  // die torreiche Frühsaison (Ø 2,44 Heimtore nach 4 Spieltagen!) hatte den Bot zu 3:1-Serien verführt.
  const PW = 30, PH = 1.65, PA = 1.30;
  const avgH = (gh + PH * PW) / (n + PW), avgA = (ga + PA * PW) / (n + PW), avg = (avgH + avgA) / 2;
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

// ---------- LLM-Veredelung: Claude justiert die Modell-Tipps und liefert freche Begründungen ----------
import fs from 'node:fs';
const TIPS_FILE = new URL('./robo-tips.json', import.meta.url).pathname;
async function llmRefine(tips, model, mdNo) {
  if (process.argv.includes('--mock')) return tips.map(t => ({ ...t, grund: `Mock-Weisheit zu ${t.h}.` }));
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) { console.log('Kein ANTHROPIC_API_KEY — reines Statistik-Modell.'); return tips; }
  const lines = tips.map(t => `${t.h} – ${t.a} | Modell-Tipp ${t.th}:${t.ta} | erwartete Tore ${ (model.avgH*model.att(t.h)*model.def(t.a)).toFixed(2) }:${ (model.avgA*model.att(t.a)*model.def(t.h)).toFixed(2) }`).join('\n');
  const prompt = `Du bist RoboSepp, der KI-Tipper der bayerisch angehauchten Kicktipp-Männerrunde "Brunnerschaft". Hier der ${mdNo}. Bundesliga-Spieltag mit den Tipps meines Statistik-Modells:\n\n${lines}\n\nDeine Aufgabe: Prüfe jeden Tipp mit deinem Fußballwissen. Du darfst das Ergebnis anpassen, wenn du gute Gründe hast (Form, Kader, Derby-Logik) — realistisch bleiben (0-5 Tore). Zu JEDEM Spiel schreibst du GENAU EINEN frechen, kurzen Satz auf Deutsch als Begründung (max. 90 Zeichen, gern mit Augenzwinkern zu den Vereinen, nie beleidigend).\n\nAntworte NUR mit einem JSON-Array, exakt ein Objekt pro Spiel in derselben Reihenfolge:\n[{"tipp":"2:1","grund":"..."}]`;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 1500, temperature: 0.7,
        messages: [{ role: 'user', content: prompt }] }),
    });
    if (!r.ok) throw new Error('API ' + r.status);
    const txt = (await r.json()).content?.[0]?.text || '';
    const arr = JSON.parse(txt.slice(txt.indexOf('['), txt.lastIndexOf(']') + 1));
    if (!Array.isArray(arr) || arr.length !== tips.length) throw new Error('unerwartetes Format');
    return tips.map((t, i) => {
      const m = String(arr[i]?.tipp || '').match(/^(\d):(\d)$/);
      return { ...t, th: m ? +m[1] : t.th, ta: m ? +m[2] : t.ta,
        grund: String(arr[i]?.grund || '').slice(0, 120) || null };
    });
  } catch (e) { console.warn('LLM-Veredelung fehlgeschlagen (' + e.message + ') — Statistik-Tipps bleiben.'); return tips; }
}
function loadStoredTips(mdNo) {
  try { const j = JSON.parse(fs.readFileSync(TIPS_FILE, 'utf8'));
    if (j.season === SEASON && j.md === mdNo && Array.isArray(j.tips) && j.tips.length) return j.tips; } catch (e) {}
  return null;
}
function storeTips(mdNo, tips) {
  try { fs.writeFileSync(TIPS_FILE, JSON.stringify({ season: SEASON, md: mdNo, generatedAt: new Date().toISOString(),
    tips: tips.map(t => ({ h: t.h, a: t.a, tipp: t.th + ':' + t.ta, grund: t.grund || null })) }, null, 1)); } catch (e) {}
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
  // Diagnose (ohne Geheimnisse): was schicken wir wohin?
  const tipFields = [...params.keys()].filter(k => /heimTipp|gastTipp/.test(k));
  console.log(`Formular: action=${action} · ${rows.length} Spielzeilen · ${tipFields.length} Tippfelder (z. B. ${tipFields[0] || '—'})`);
  const r3 = await fetch(action, { method: 'POST', redirect: 'manual',
    headers: { ...UA, Cookie: cook(), 'Content-Type': 'application/x-www-form-urlencoded' }, body: params });
  grab(r3);
  console.log('Abgabe-Antwort:', r3.status, '→', r3.headers.get('location') || '(kein Redirect)');
  // Echte Verifikation: Formular neu laden und prüfen, ob die Werte gespeichert wurden
  const r4 = await fetch(`${BASE}tippabgabe?tippsaisonId=${SEASON}`, { headers: { ...UA, Cookie: cook() } });
  const doc2 = new JSDOM(await r4.text()).window.document;
  const saved = [...doc2.querySelectorAll('input[name$="heimTipp"]')].map((inp, i) => {
    const gast = doc2.querySelector(`input[name="${inp.name.replace('heimTipp', 'gastTipp')}"]`);
    return `${inp.value || '–'}:${gast ? gast.value || '–' : '–'}`;
  });
  console.log('Gespeicherte Tipps laut Formular:', saved.join('  ') || '(keine Felder gefunden)');
  const want = tips.map(t => `${t.th}:${t.ta}`);
  const ok = want.every(w => saved.includes(w));
  console.log(ok ? '✅ Verifikation OK — Tipps sind gespeichert.' : '❌ Verifikation FEHLGESCHLAGEN — Tipps nicht (vollständig) gespeichert!');
  return ok;
}

// ---------- Hauptlauf ----------
(async () => {
  // Zeitmaschine: --md N tippt Spieltag N nur mit dem Wissen VOR diesem Spieltag (für faire Nachträge)
  const mdArg = process.argv.indexOf('--md');
  const forceMd = mdArg > -1 ? +process.argv[mdArg + 1] : 0;
  const results = []; let next = null, nextNo = 0;
  for (let mi = 1; mi <= 34; mi++) {
    const g = await matchday(mi); if (!g || !g.length) break;
    if (forceMd && mi === forceMd) { next = g; nextNo = mi; break; } // Modell kennt nur mi < N
    const done = g.filter(x => x.rh != null);
    results.push(...done);
    if (!forceMd && done.length < g.length) { next = g; nextNo = mi; break; }
  }
  if (!next) { console.log('Kein offener Spieltag gefunden.'); process.exit(0); }
  const model = buildModel(results);
  const rng = rngFor(SEASON + '-' + nextNo);
  let tips = (forceMd ? next : next.filter(g => g.rh == null)).map(g => { const [th, ta] = predict(model, g, rng); return { ...g, th, ta }; });
  const stored = forceMd ? null : loadStoredTips(nextNo);
  if (stored && stored.length === tips.length) { // Spieltag schon getippt: identisch wiederholen (Fr-Sicherheitslauf)
    tips = tips.map((t, i) => { const m = String(stored[i].tipp).match(/^(\d+):(\d+)$/);
      return m ? { ...t, th: +m[1], ta: +m[2], grund: stored[i].grund } : t; });
    console.log('Nutze gespeicherte Tipps vom ersten Lauf dieses Spieltags.');
  } else if (!forceMd) {
    tips = await llmRefine(tips, model, nextNo);
    storeTips(nextNo, tips);
  }
  console.log(`🤖 RoboSepp tippt den ${nextNo}. Spieltag (Modell aus ${results.length} Ergebnissen${process.env.ANTHROPIC_API_KEY||process.argv.includes('--mock')?' + KI-Veredelung':''}):`);
  for (const t of tips) console.log(`   ${t.h} – ${t.a}:  ${t.th}:${t.ta}${t.grund?'  — „'+t.grund+'“':''}`);
  if (DRY) { console.log('(Dry-Run — nichts abgegeben)'); process.exit(0); }
  const ok = await submit(tips);
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error('ROBO FEHLER:', e.message); process.exit(1); });
