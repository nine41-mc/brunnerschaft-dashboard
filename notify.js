// Vergleicht den Push-Zustand vor dem Deploy (old-state.json, vom Live-Stand geholt)
// mit dem frischen Build (dist/push-state.json) und schickt Ereignis-Pushes an den Worker.
// Aufruf in der Action: node notify.js old-state.json
import fs from 'node:fs';

const PUSH_URL = process.env.PUSH_URL;
const SECRET = process.env.NOTIFY_SECRET;
if (!PUSH_URL || !SECRET) { console.log('Push nicht konfiguriert — übersprungen.'); process.exit(0); }

const NFULL = { 'CH7': 'Claus', 'Manurinho': 'Manu', 'Lutz_Brunner7b': 'Lutz', 'Tobias': 'Tobi', 'Maxsen': 'MaxSen', 'Maxjun.': 'MaxJun', 'BigBen': 'Ben', 'Messi': 'Elias', 'LuLu': 'Luisa' };
const nm = n => NFULL[n] || n;
const SITE = 'https://nine41-mc.github.io/brunnerschaft-dashboard/';

const load = f => { try { const t = fs.readFileSync(f, 'utf8').trim(); return t && t !== 'null' ? JSON.parse(t) : null; } catch (e) { return null; } };
const oldSt = load(process.argv[2] || 'old-state.json');
const neu = load('dist/push-state.json');
if (!oldSt || !neu || oldSt.id !== neu.id) { console.log('Kein vergleichbarer Zustand — keine Pushes.'); process.exit(0); }

const events = [];

// 🎯 Neue Volltreffer (nur während Live-Spielen desselben Spieltags)
if (neu.anyLive && oldSt.md === neu.md) {
  const hits = Object.keys(neu.p4).filter(n => (neu.p4[n] || 0) > (oldSt.p4?.[n] || 0)).map(nm);
  if (hits.length === 1) events.push({ title: '🎯 Volltreffer!', body: `${hits[0]} trifft ein Ergebnis exakt — +4 Punkte`, tag: 'brun-p4', channel: 'p4' });
  else if (hits.length > 1) events.push({ title: `🎯 ${hits.length}× Volltreffer!`, body: `${hits.join(', ')} treffen exakt — je +4 Punkte`, tag: 'brun-p4', channel: 'p4' });
}

// 👑 Führungswechsel
if (oldSt.leader && neu.leader && oldSt.leader !== neu.leader) {
  events.push({ title: '👑 Führungswechsel!', body: `${nm(neu.leader)} überholt ${nm(oldSt.leader)} — ${neu.leaderPts}:${neu.secondPts}`, tag: 'brun-lead', channel: 'lead' });
}

// 🏁 Spieltag beendet
if (oldSt.md === neu.md && !oldSt.mdDone && neu.mdDone) {
  events.push({ title: `🏁 ${neu.md}. Spieltag ist durch!`, body: `Sieger: ${nm(neu.winner)} (${neu.winnerPts} P) 🎉\nZwischenstand: ${neu.top3.replace(/([A-Za-z_.7]+)/g, m => nm(m))}`, tag: 'brun-done', channel: 'done' });
}

// ⭐ Bonusfrage aufgelöst
if ((neu.bonusSolved || 0) > (oldSt.bonusSolved || 0)) {
  events.push({ title: '⭐ Bonusfrage entschieden!', body: 'Kicktipp hat eine Saisonfrage aufgelöst — schau ins Dashboard.', tag: 'brun-bonus', channel: 'bonus' });
}

if (!events.length) { console.log('Keine Ereignisse.'); process.exit(0); }
for (const ev of events.slice(0, 3)) {
  const r = await fetch(PUSH_URL.replace(/\/$/, '') + '/notify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SECRET}` },
    body: JSON.stringify({ ...ev, url: SITE }),
  }).catch(e => ({ ok: false, statusText: e.message }));
  console.log('Push:', ev.title, '→', r.ok ? await r.text() : 'FEHLER ' + (r.status || r.statusText));
}
