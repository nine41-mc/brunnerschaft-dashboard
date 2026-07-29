// Scrapt die (öffentlichen) Kicktipp-Daten der Brunnerschaft und berechnet alle Statistiken.
// Portierung der im Browser erprobten Logik nach Node (fetch + jsdom).
import { JSDOM } from 'jsdom';

const UA = { headers: { 'User-Agent': 'BrunnerschaftDashboard/1.0 (+github pages build)' } };
const NAME_MAP = { 'Toblerone': 'Tobias' };
const norm = n => NAME_MAP[n] || n;
const CORE = new Set(['CH7','Maxsen','Manurinho','Tobias','Billy','Matthew','Lutz_Brunner7b','BigBen','Maxjun.']);
const r2 = x => Math.round(x*100)/100;
const toInt = t => { const m=(t||'').replace(/[^\d-]/g,''); return m===''||m==='-'?null:parseInt(m,10); };

const sleep = ms => new Promise(r=>setTimeout(r,ms));
async function fetchText(url, tries=3){
  for(let i=0;i<tries;i++){
    try{ const r=await fetch(url, UA); if(r.ok) return await r.text(); }catch(e){}
    await sleep(400*(i+1));
  }
  throw new Error('fetch failed: '+url);
}
async function fetchDoc(url){ return new JSDOM(await fetchText(url)).window.document; }
const base = s => `https://www.kicktipp.de/${s.community}/`;
const q = s => `tippsaisonId=${s.id}`;

// ---------- Saison-Discovery ----------
function deriveType(name){ if(/Bundesliga/i.test(name))return'BL'; if(/Weltmeister/i.test(name))return'WM'; if(/Europameister/i.test(name))return'EM'; return'BL'; }
function deriveShort(name){
  let m=name.match(/Bundesliga\s+20(\d\d)\/(\d\d)/i); if(m)return`BL ${m[1]}/${m[2]}`;
  m=name.match(/(Welt|Europa)meisterschaft\s+(\d{4})/i); if(m)return`${/Welt/i.test(m[1])?'WM':'EM'} ${m[2]}`;
  return name;
}
export async function discoverSeasons(config){
  const byId = new Map();
  // 1) explizit deklarierte Saisons (aktive/live + separate Community)
  for(const s of config.seasons){ byId.set(s.id, {...s, type:s.type||deriveType(s.name), short:s.short||deriveShort(s.name), community:s.community||'brunnerschaft'}); }
  // 2) archivierte Saisons der Hauptcommunity automatisch entdecken
  try{
    const plain = await fetchDoc(`https://www.kicktipp.de/${config.mainCommunity}/tippuebersicht`);
    const archLink = [...plain.querySelectorAll('a')].find(a=>/[Aa]rchiv/.test(a.textContent) && /tippsaisonId=/.test(a.getAttribute('href')||''));
    if(archLink){
      const doc = await fetchDoc('https://www.kicktipp.de'+archLink.getAttribute('href'));
      doc.querySelectorAll('a[href*="tippsaisonId="]').forEach(a=>{
        const m=a.getAttribute('href').match(/tippsaisonId=(\d+)/);
        const name=a.textContent.replace(/\s+/g,' ').trim();
        if(m && /Bundesliga 20|Weltmeisterschaft 20|Europameisterschaft 20/.test(name) && !byId.has(m[1])){
          byId.set(m[1], {id:m[1], name:name.replace(/^1\.\s*/,''), short:deriveShort(name), type:deriveType(name), community:config.mainCommunity});
        }
      });
    }
  }catch(e){ console.warn('Archiv-Discovery fehlgeschlagen:', e.message); }
  return [...byId.values()];
}

// ---------- Gesamtübersicht (Endstand + Spieltags-Matrix + Bonus) ----------
async function scrapeGesamt(s){
  const doc = await fetchDoc(base(s)+'gesamtuebersicht?'+q(s));
  const tb = doc.querySelector('#ranking');
  if(!tb) return { numMd:0, players:[], bonus:{} };
  const header=[...tb.rows[0].cells].map(c=>c.textContent.trim());
  const bIdx=header.indexOf('B'); const gIdx=header.lastIndexOf('G'); const nameIdx=header.indexOf('Name');
  const mdCount=(bIdx>nameIdx?bIdx:header.length-3)-(nameIdx+1);
  const players=[]; const bonus={};
  for(const tr of [...tb.rows].slice(1)){
    const c=[...tr.cells]; if(c.length<3) continue;
    const pos=toInt(c[0].textContent); const name=norm(c[nameIdx].textContent.trim());
    if(pos===null||!name) continue;
    const gi=(gIdx>=0&&gIdx<c.length)?gIdx:c.length-1;
    const md=[]; for(let i=nameIdx+1;i<nameIdx+1+mdCount && i<c.length-3;i++){ const v=toInt(c[i].textContent); md.push(v); }
    const total=toInt(c[gi].textContent)||0;
    players.push({pos,name,total,md});
    if(CORE.has(name)){ const b=toInt(c[bIdx]?.textContent)||0; bonus[name]=b; }
  }
  return { numMd:mdCount, players, bonus };
}

// ---------- Ein Spieltag (Fixtures + Tipps + Punkte) ----------
async function scrapeMatchday(s, mi){
  const doc = await fetchDoc(base(s)+`tippuebersicht?${q(s)}&spieltagIndex=${mi}`);
  const sp=doc.querySelector('#spielplanSpiele'); const fixtures=[]; const results=[];
  if(sp) for(const tr of [...sp.rows].slice(1)){ const c=[...tr.cells]; if(c.length>=3){ fixtures.push([c[1].textContent.trim(), c[2].textContent.trim()]);
    const rm=(c[3]?.textContent.trim()||'').match(/^(\d+):(\d+)$/); results.push(rm?{rh:+rm[1],ra:+rm[2]}:null); } }
  const bayern=fixtures.map(f=>/Bayern München/.test(f[0])?'H':(/Bayern München/.test(f[1])?'A':null));
  const tb=doc.querySelector('#ranking'); if(!tb) return null;
  const rows=[];
  for(const tr of [...tb.rows].slice(1)){
    const c=[...tr.cells]; const nm=c[2]?.textContent.trim(); if(!nm) continue;
    const name=norm(nm); if(!CORE.has(name)) continue;
    let mdTot=0; const tips=[];
    [...tr.querySelectorAll('td.ereignis')].forEach((cell,idx)=>{
      const cl=cell.cloneNode(true); cl.querySelectorAll('sub').forEach(x=>x.remove());
      const m=cl.textContent.trim().match(/^(\d+):(\d+)$/);
      const sub=cell.querySelector('sub.p'); const pts=sub?parseInt(sub.textContent,10):0; mdTot+=pts;
      tips.push(m?{h:+m[1],a:+m[2],pts,bay:bayern[idx],fx:fixtures[idx],res:results[idx]}:{empty:true,pts});
    });
    rows.push({name, mdTot, tips});
  }
  return { fixtures, results, rows };
}

// ---------- Bonus-Seite (Kategorien + Champion-Treffer) ----------
function bonusCat(code){
  if(/^HM/.test(code)) return 'Herbstmeister';
  if(/^DM/.test(code)) return 'Meister';
  if(/^(WM|EM)[A-Z]/.test(code)) return 'Turniersieger';
  if(/^Tor/.test(code)) return 'Torschützenkönig';
  return 'Sonstige';
}
async function scrapeBonus(s){
  const doc = await fetchDoc(base(s)+`tippuebersicht?${q(s)}&bonus=true`);
  const tb=doc.querySelector('#ranking'); if(!tb) return { cats:{}, champCorrect:{}, hmCorrect:{}, bayernTitle:{} };
  const header=[...tb.rows[0].cells].map(c=>c.textContent.trim());
  const bIdx=header.indexOf('B'); const nameIdx=header.indexOf('Name');
  const cats={}, champCorrect={}, hmCorrect={}, bayernTitle={};
  const champCols=[], hmCols=[], dmCols=[];
  for(let i=nameIdx+1;i<bIdx;i++){ const h=header[i]; if(/^DM/.test(h)){champCols.push(i);dmCols.push(i);} if(/^(WM|EM)[A-Z]/.test(h))champCols.push(i); if(/^HM/.test(h))hmCols.push(i); }
  const ansText=cell=>{ const cl=cell.cloneNode(true); cl.querySelectorAll('sub').forEach(x=>x.remove()); return cl.textContent.trim(); };
  for(const tr of [...tb.rows].slice(1)){
    const c=[...tr.cells]; if(c.length<5) continue; const name=norm(c[nameIdx].textContent.trim()); if(!CORE.has(name)) continue;
    const cp=cats[name]||(cats[name]={Meister:0,Herbstmeister:0,Turniersieger:0,'Torschützenkönig':0,Sonstige:0});
    for(let i=nameIdx+1;i<bIdx;i++){ const sub=c[i].querySelector('sub.p'); const pts=sub?parseInt(sub.textContent,10):0; if(pts) cp[bonusCat(header[i])]+=pts; }
    const any=cols=>cols.some(i=>{const sub=c[i].querySelector('sub.p');return sub&&parseInt(sub.textContent,10)>0;});
    if(champCols.length&&any(champCols)) champCorrect[name]=(champCorrect[name]||0)+1;
    if(hmCols.length&&any(hmCols)) hmCorrect[name]=(hmCorrect[name]||0)+1;
    // Wurde Bayern (Kürzel FCB) als Meister / Herbstmeister getippt?
    const bt=bayernTitle[name]||(bayernTitle[name]={m:0,h:0});
    if(dmCols.some(i=>c[i]&&/^FCB$/i.test(ansText(c[i])))) bt.m++;
    if(hmCols.some(i=>c[i]&&/^FCB$/i.test(ansText(c[i])))) bt.h++;
  }
  return { cats, champCorrect, hmCorrect, bayernTitle };
}

async function batched(items, fn, size=6){
  const out=[]; for(let i=0;i<items.length;i+=size){ out.push(...await Promise.all(items.slice(i,i+size).map(fn))); } return out;
}

// ---------- Hauptfunktion ----------
export async function buildData(config){
  const seasons = await discoverSeasons(config);
  // Reihenfolge: neueste zuerst (nach config.order, sonst wie deklariert)
  const orderIdx = id => { const i=config.displayOrder.indexOf(id); return i<0?999:i; };
  seasons.sort((a,b)=>orderIdx(a.id)-orderIdx(b.id));

  const raw = {}; // id -> {season, gesamt}
  for(const s of seasons){
    const g = await scrapeGesamt(s);
    raw[s.id] = { s, g };
  }

  // played-Erkennung: Anzahl Spieltage mit irgendeinem Punkt
  function playedCount(g){
    let cnt=0; const n=g.numMd;
    for(let mi=0;mi<n;mi++){ if(g.players.some(p=>(p.md[mi]||0)>0)) cnt++; }
    return cnt;
  }
  for(const id in raw){ const {s,g}=raw[id]; const played=playedCount(g);
    s.numMd=g.numMd; s.started=played>0; s.running = played < g.numMd; s.playedMd=played;
  }

  // ---- DATA.seasons + DATA.players ----
  const DATA={ generated:config.generated, seasons:[], players:[] };
  for(const s of seasons){
    const g=raw[s.id].g;
    const standings=g.players.map(p=>({pos:p.pos,name:p.name,total:p.total,active:p.total>0}));
    DATA.seasons.push({ id:s.id, name:s.name, short:s.short, type:s.type, numMd:s.numMd, running:s.running||undefined, standings });
  }
  const names=new Set(); DATA.seasons.forEach(s=>s.standings.forEach(p=>{if(p.active)names.add(p.name);}));
  for(const name of names){
    let played=0,totalPts=0,champ=0,champBL=0,lastCnt=0,podium=0,bestFinish=99; const positions={};
    DATA.seasons.forEach(s=>{
      if(s.running){ positions[s.id]=null; return; }
      const active=s.standings.filter(p=>p.active); const idx=active.findIndex(p=>p.name===name);
      if(idx>=0){ played++; const r=idx+1; totalPts+=active[idx].total; positions[s.id]=r;
        if(r===1){champ++; if(s.type==='BL')champBL++;} if(r<=3)podium++; if(r===active.length)lastCnt++; bestFinish=Math.min(bestFinish,r);
      } else positions[s.id]=null;
    });
    DATA.players.push({ name, played, totalPts, champ, champBL, lastCnt, podium, positions, bestFinish, avgPts: played?Math.round(totalPts/played):0 });
  }
  DATA.players.sort((a,b)=>b.totalPts-a.totalPts);

  // ---- BONUS (gesamt) + BONUS_SEASON ----
  const BONUS={}; const BONUS_SEASON={};
  for(const s of seasons){ const g=raw[s.id].g; BONUS_SEASON[s.id]={};
    for(const [n,b] of Object.entries(g.bonus)){ if(b>0){ BONUS[n]=(BONUS[n]||0)+b; BONUS_SEASON[s.id][n]=b; } }
  }

  // ---- METRICS (gesamt + perSeason): mdWins, avgMd via Gesamt-Matrix ----
  const METRICS={ perSeason:{}, gesamt:{} };
  const gEnsure=n=>METRICS.gesamt[n]||(METRICS.gesamt[n]={placed:0,missing:0,p4:0,p3:0,p2:0,antiBayern:0,bayernTipped:0,mdSum:0,mdCount:0,mdWins:0});
  for(const s of seasons){
    if(s.running) continue;
    const g=raw[s.id].g; const active=g.players.filter(p=>p.total>0); const ps={}; METRICS.perSeason[s.id]=ps;
    const mdWins={};
    for(let mi=0;mi<s.numMd;mi++){ let max=-1,w=[]; active.forEach(p=>{const v=p.md[mi]; if(v==null)return; if(v>max){max=v;w=[p.name];}else if(v===max)w.push(p.name);}); if(max>0)w.forEach(x=>mdWins[x]=(mdWins[x]||0)+1); }
    active.forEach(p=>{ if(!CORE.has(p.name))return; const mdVals=p.md.filter(v=>v!=null); const mdSum=mdVals.reduce((a,b)=>a+b,0), mdCount=mdVals.length;
      ps[p.name]={mdSum,mdCount,mdWins:mdWins[p.name]||0,avgMd:mdCount?r2(mdSum/mdCount):0};
      const G=gEnsure(p.name); G.mdSum+=mdSum; G.mdCount+=mdCount; G.mdWins+=(mdWins[p.name]||0);
    });
  }

  // ---- Detail-Scrape aller gespielten Spieltage ----
  const P={}; const ensureP=n=>P[n]||(P[n]={tips:0,goals:0,draws:0,homeWin:0,hit:0,exact:0,mpts:0,res:{},backT:{},backC:{}});
  const pair={}; const pk=(a,b)=>a<b?a+'|'+b:b+'|'+a;
  const teamPts={}, countryPts={}, wonDayPts={}, groupRes={}, groupResWho={};
  const zero={}, loser={};
  const abOpp={}, abOppAll={}; // gegen welche Gegner auf Bayern-Pleite getippt wurde
  const proBayTips={}, proBayPts={}, proBayFail={}, bayWinAct={}; // Tipps auf Bayern-Sieg, Punkte, Nieten, echte Bayern-Siege
  const record=[]; const winStreakBest={};
  const worstDays=[], bestDays=[];
  const outcome={}; // name -> {H:{tot,ok},D:{},A:{}} Treffsicherheit nach echtem Ausgang
  const underdog={}; // name -> richtige Tipps gegen die Mehrheit der Runde
  const underdogOpp={}; // Summe der Gegenstimmen bei diesen mutigen Treffern
  const crazy=[]; // exakt getroffene, verrückte Ergebnisse
  const leaderMd={}, leadStreak={}; // Spieltage als Tabellenführer + längste Führung am Stück
  const worstTip=[]; // größte Abweichung Tipp <-> Ergebnis
  const megalo={}; // Größenwahn: hohe Tipps (>=5 Tore) ohne Punkte
  const beton={}; // 0:0 getippt: gesamt + wie oft mind. 1 Tor fiel (daneben)
  const pannen={}, pannenMd={}; // Pannenkönig: BL-Spieltage <5 Pkt (nur mit abgegebenen Tipps)
  // Bayern-Fan & Anti-Dortmund
  const klassikerPts={}, klassikerN={}; // Punkte/Spiele in Bayern-Dortmund-Duellen
  const bayGoalPred={}; // Summe getippter Bayern-Tore (für Schützenfest-Optimist)
  const bayExact={}; // exakte Bayern-Ergebnisse (4 Punkte)
  const antiBVB={}, bvbOpp={}, bvbOppAll={}; // auf Dortmund-Pleite getippt (+ Gegner)
  const proBVB={}; // auf Dortmund-Sieg getippt (heimlicher BVB-Fan)
  const schadenPts={}; // Punkte aus korrekt getippten Dortmund-Niederlagen
  const doppelmoral={}; // Spieltage mit Bayern-Sieg UND Dortmund-Pleite getippt
  const bayMarginSum={}, bayMaxMargin={}; // Arroganz: getippte Bayern-Tordifferenz (Ø + Maximum)
  const judasPts={}; // Punkte aus Tipps GEGEN Bayern
  const zauderer={}; // Remis-Tipps im Klassiker
  const goretzka={}; // stur 2:1-Auswärtssieg für Bayern getippt
  const tend=t=>t.h>t.a?'H':(t.h<t.a?'A':'D');
  // perSeason placed/missing/p4/p3/p2/antiBayern
  for(const s of seasons){
    if(!s.started) continue;
    const idxs=[]; for(let i=1;i<=s.numMd;i++) idxs.push(i);
    const mds = await batched(idxs, mi=>scrapeMatchday(s, mi), 6);
    const ps = METRICS.perSeason[s.id] || (METRICS.perSeason[s.id]={});
    const activeNames = new Set(raw[s.id].g.players.filter(p=>p.total>0).map(p=>p.name));
    const seasonMd=[]; // md -> {name:tot}
    mds.forEach((md,k)=>{
      if(!md) return; const mi=idxs[k];
      const totalPtsMd = md.rows.reduce((a,r)=>a+r.mdTot,0);
      if(totalPtsMd<=0) return; // Spieltag (noch) nicht gespielt -> überspringen
      const pmap={}; const dayTips=md.fixtures.map(()=>[]);
      // Gruppen-Konsens je Spiel (Mehrheits-Tendenz der Runde) für "Außenseiter"
      const matchTend=md.fixtures.map(()=>({H:0,D:0,A:0}));
      md.rows.forEach(r=>{ if(!activeNames.has(r.name)) return; r.tips.forEach((t,idx)=>{ if(!t.empty&&idx<matchTend.length) matchTend[idx][tend(t)]++; }); });
      const consensus=matchTend.map(m=>{ const e=Object.entries(m).sort((a,b)=>b[1]-a[1]); return e[0][1]>e[1][1]?e[0][0]:null; });
      md.rows.forEach(r=>{
        const name=r.name; if(!activeNames.has(name)) return; // nur tatsächlich teilnehmende Tipper dieser Saison
        pmap[name]=r.mdTot;
        const pp=ps[name]||(ps[name]={});
        if(pp.placed===undefined){ pp.placed=0; pp.missing=0; pp.p4=0; pp.p3=0; pp.p2=0; pp.antiBayern=0; pp.bayernTipped=0; }
        const gp=gEnsure(name);
        if(s.type==='BL'){ const placedMd=r.tips.filter(t=>!t.empty).length; // Pannenkönig: nur Spieltage mit ≥1 Tipp
          if(placedMd>0){ pannenMd[name]=(pannenMd[name]||0)+1; if(r.mdTot<5) pannen[name]=(pannen[name]||0)+1; } }
        let mdBayWin=false, mdBvbLoss=false; // für Doppelmoral-Index (pro Spieltag)
        r.tips.forEach((t,idx)=>{
          if(t.empty){ pp.missing++; gp.missing++; return; }
          pp.placed++; gp.placed++;
          const per=ensureP(name); per.tips++; per.goals+=t.h+t.a; if(t.h===t.a)per.draws++; if(t.h>t.a)per.homeWin++; if(t.pts>0)per.hit++; if(t.pts===4)per.exact++; per.mpts+=t.pts;
          const str=t.h+':'+t.a; per.res[str]=(per.res[str]||0)+1; groupRes[str]=(groupRes[str]||0)+1;
          (groupResWho[str]||(groupResWho[str]={}))[name]=((groupResWho[str]||{})[name]||0)+1;
          if(t.pts===4){pp.p4++;gp.p4++;} else if(t.pts===3){pp.p3++;gp.p3++;} else if(t.pts===2){pp.p2++;gp.p2++;}
          if(t.bay){ pp.bayernTipped++; gp.bayernTipped++;
            if(t.res&&((t.bay==='H'&&t.res.rh>t.res.ra)||(t.bay==='A'&&t.res.ra>t.res.rh))) bayWinAct[name]=(bayWinAct[name]||0)+1;
            if((t.bay==='H'&&t.h>t.a)||(t.bay==='A'&&t.a>t.h)){ proBayTips[name]=(proBayTips[name]||0)+1; proBayPts[name]=(proBayPts[name]||0)+t.pts; if(t.pts===0) proBayFail[name]=(proBayFail[name]||0)+1; }
            if((t.bay==='H'&&t.h<t.a)||(t.bay==='A'&&t.a<t.h)){pp.antiBayern++;gp.antiBayern++;
            if(t.pts>0) judasPts[name]=(judasPts[name]||0)+t.pts;
            const opp=t.bay==='H'?(t.fx&&t.fx[1]):(t.fx&&t.fx[0]); if(opp){ (abOpp[name]||(abOpp[name]={}))[opp]=((abOpp[name]||{})[opp]||0)+1; abOppAll[opp]=(abOppAll[opp]||0)+1; } } }
          if(t.fx){ const win=t.h>t.a?t.fx[0]:(t.a>t.h?t.fx[1]:null);
            if(win){ if(s.type==='BL'){per.backT[win]=(per.backT[win]||0)+1;} else {per.backC[win]=(per.backC[win]||0)+1;} } }
          if(t.fx){ const tgt=s.type==='BL'?teamPts:countryPts; const tp=tgt[name]||(tgt[name]={});
            if(t.pts){ tp[t.fx[0]]=(tp[t.fx[0]]||0)+t.pts; tp[t.fx[1]]=(tp[t.fx[1]]||0)+t.pts; } }
          if(t.fx){ // Bayern-Fan & Anti-Dortmund
            const bvb=/Dortmund/.test(t.fx[0])?'H':(/Dortmund/.test(t.fx[1])?'A':null);
            if(t.bay){ bayGoalPred[name]=(bayGoalPred[name]||0)+(t.bay==='H'?t.h:t.a); if(t.pts===4)bayExact[name]=(bayExact[name]||0)+1;
              if((t.bay==='H'&&t.h>t.a)||(t.bay==='A'&&t.a>t.h)) mdBayWin=true;
              const margin=t.bay==='H'?(t.h-t.a):(t.a-t.h); bayMarginSum[name]=(bayMarginSum[name]||0)+margin;
              const cur=bayMaxMargin[name]; if(!cur||margin>cur.margin) bayMaxMargin[name]={margin,tip:t.h+':'+t.a,fx:t.fx,season:s.short,md:mi};
              if(t.bay==='A'&&t.a===2&&t.h===1) goretzka[name]=(goretzka[name]||0)+1; }
            if(t.bay&&bvb){ klassikerPts[name]=(klassikerPts[name]||0)+t.pts; klassikerN[name]=(klassikerN[name]||0)+1; if(t.h===t.a) zauderer[name]=(zauderer[name]||0)+1; }
            if(bvb){
              if((bvb==='H'&&t.h>t.a)||(bvb==='A'&&t.a>t.h)) proBVB[name]=(proBVB[name]||0)+1;
              if((bvb==='H'&&t.h<t.a)||(bvb==='A'&&t.a<t.h)){ antiBVB[name]=(antiBVB[name]||0)+1; mdBvbLoss=true;
                const opp=bvb==='H'?t.fx[1]:t.fx[0]; if(opp){ (bvbOpp[name]||(bvbOpp[name]={}))[opp]=((bvbOpp[name]||{})[opp]||0)+1; bvbOppAll[opp]=(bvbOppAll[opp]||0)+1; }
                if(t.pts>0) schadenPts[name]=(schadenPts[name]||0)+t.pts; }
            }
          }
          if(t.res){ const act=t.res.rh>t.res.ra?'H':(t.res.rh<t.res.ra?'A':'D'); const pred=tend(t);
            const os=outcome[name]||(outcome[name]={H:{tot:0,ok:0},D:{tot:0,ok:0},A:{tot:0,ok:0}});
            os[act].tot++; if(pred===act) os[act].ok++;
            if(consensus[idx] && pred!==consensus[idx] && pred===act){ underdog[name]=(underdog[name]||0)+1;
              const mt=matchTend[idx]; underdogOpp[name]=(underdogOpp[name]||0)+((mt.H+mt.D+mt.A)-(mt[pred]||0)); }
            if(t.pts===4) crazy.push({name,res:t.h+':'+t.a,tot:t.h+t.a,diff:Math.abs(t.h-t.a),fx:t.fx||null,season:s.short,md:mi,type:s.type==='BL'?'BL':'CUP'});
            const dist=Math.abs(t.h-t.res.rh)+Math.abs(t.a-t.res.ra);
            if(dist>=6) worstTip.push({name,tip:t.h+':'+t.a,res:t.res.rh+':'+t.res.ra,dist,fx:t.fx||null,season:s.short,md:mi});
            if(t.h+t.a>=5){ const m=megalo[name]||(megalo[name]={try:0,fail:0}); m.try++; if(t.pts===0)m.fail++; }
            if(t.h===0&&t.a===0){ const b=beton[name]||(beton[name]={tot:0,fail:0}); b.tot++; if((t.res.rh+t.res.ra)>=1)b.fail++; }
          }
          if(idx<dayTips.length) dayTips[idx].push({name,str});
        });
        if(mdBayWin&&mdBvbLoss) doppelmoral[name]=(doppelmoral[name]||0)+1;
      });
      // Zwillinge
      dayTips.forEach(arr=>{ for(let i=0;i<arr.length;i++)for(let j=i+1;j<arr.length;j++){ const key=pk(arr[i].name,arr[j].name); const o=pair[key]||(pair[key]={shared:0,same:0}); o.shared++; if(arr[i].str===arr[j].str)o.same++; } });
      // Spieltagsieg-Punkte + Rekord + zero/loser + collective
      const present = Object.entries(pmap).filter(([n])=>activeNames.has(n));
      if(present.length){
        const max=Math.max(...present.map(e=>e[1])); const min=Math.min(...present.map(e=>e[1]));
        const mdMax=md.fixtures.length*4; // maximal mögliche Punkte an diesem Spieltag
        present.forEach(([n,v])=>{ record.push({n,pts:v,max:mdMax,season:s.short,md:mi,type:s.type==='BL'?'BL':'CUP'}); if(v===max&&v>0){wonDayPts[n]=(wonDayPts[n]||0)+v;} if(v===0)zero[n]=(zero[n]||0)+1; if(v===min)loser[n]=(loser[n]||0)+1; });
      }
      seasonMd[mi]=pmap;
    });
    // Serie: längste Spieltagsieg-Serie in dieser Saison
    const activeArr=[...activeNames];
    activeArr.forEach(n=>{ let ws=0,wsMax=0;
      for(let mi=1;mi<=s.numMd;mi++){ const pm=seasonMd[mi]; if(!pm||!(n in pm)){ws=0;continue;} const v=pm[n]; const vals=Object.entries(pm).filter(([x])=>activeNames.has(x)).map(e=>e[1]); const max=Math.max(...vals); if(v===max&&v>0){ws++;wsMax=Math.max(wsMax,ws);}else ws=0; }
      winStreakBest[n]=Math.max(winStreakBest[n]||0,wsMax);
    });
    // Führungs-Historie: kumulierte Punkte je Spieltag -> Tabellenführer nach jedem Spieltag
    { const cum={}; activeArr.forEach(n=>cum[n]=0); const streakCur={};
      for(let mi=1;mi<=s.numMd;mi++){ const pm=seasonMd[mi]; if(!pm)continue;
        let any=false; activeArr.forEach(n=>{ if(n in pm){ cum[n]+=pm[n]; any=true; } });
        if(!any)continue;
        const max=Math.max(...activeArr.map(n=>cum[n]));
        activeArr.forEach(n=>{ if(cum[n]===max&&max>0){ leaderMd[n]=(leaderMd[n]||0)+1; streakCur[n]=(streakCur[n]||0)+1; leadStreak[n]=Math.max(leadStreak[n]||0,streakCur[n]); } else streakCur[n]=0; });
      }
    }
    // collective days (BL only)
    if(s.type==='BL'){
      for(let mi=1;mi<=s.numMd;mi++){ const pm=seasonMd[mi]; if(!pm)continue; const present=Object.entries(pm).filter(([n])=>activeNames.has(n)); if(!present.length)continue; const avg=r2(present.reduce((a,e)=>a+e[1],0)/present.length); worstDays.push({season:s.short,md:mi,avg}); }
    }
  }
  // gesamt avgMd
  Object.values(METRICS.gesamt).forEach(G=>{ G.avgMd=G.mdCount?r2(G.mdSum/G.mdCount):0; });

  // Konstanz: Standardabweichung der Spieltagspunkte (alle gespielten Spieltage, aktive Saisons)
  const mdVals={};
  for(const s of seasons){ if(!s.started) continue; const active=raw[s.id].g.players.filter(p=>p.total>0);
    active.forEach(p=>{ if(!CORE.has(p.name))return; p.md.forEach(v=>{ if(v!=null) (mdVals[p.name]||(mdVals[p.name]=[])).push(v); }); }); }
  const konstanz={};
  for(const[n,arr]of Object.entries(mdVals)){ if(arr.length<5)continue; const m=arr.reduce((a,b)=>a+b,0)/arr.length;
    const v=arr.reduce((a,b)=>a+(b-m)*(b-m),0)/arr.length; konstanz[n]={sd:r2(Math.sqrt(v)),avg:r2(m),n:arr.length}; }

  // ---- ADV ----
  const bestOf=map=>{const o={};for(const[n,t]of Object.entries(map)){const e=Object.entries(t).sort((a,b)=>b[1]-a[1]);if(e[0])o[n]=e[0];}return o;};
  const bonusCatAll={}; const prophetChamp={}, prophetHerbst={}, bayernTitleAll={};
  for(const s of seasons){ if(!s.started||s.running) continue; const b=await scrapeBonus(s);
    for(const[n,c]of Object.entries(b.cats)){ const cc=bonusCatAll[n]||(bonusCatAll[n]={Meister:0,Herbstmeister:0,Turniersieger:0,'Torschützenkönig':0,Sonstige:0}); for(const k in c)cc[k]+=c[k]; }
    for(const[n,v]of Object.entries(b.champCorrect)) prophetChamp[n]=(prophetChamp[n]||0)+v;
    for(const[n,v]of Object.entries(b.hmCorrect)) prophetHerbst[n]=(prophetHerbst[n]||0)+v;
    for(const[n,v]of Object.entries(b.bayernTitle||{})){ const t=bayernTitleAll[n]||(bayernTitleAll[n]={m:0,h:0}); t.m+=v.m; t.h+=v.h; }
  }
  const shortTeam=t=>String(t).replace(/^1\.\s*FC\s+/,'').replace(/^(FC|VfL|VfB|SV|SC|TSG|SpVgg|Bor\.|Borussia|Eintracht)\s+/,'').replace(' München','').replace('erkusen','.').trim()||t;
  const abOppTop=Object.entries(abOppAll).sort((a,b)=>b[1]-a[1]).slice(0,8).map(([o,c])=>[shortTeam(o),c]);
  const abOppByPlayer=Object.fromEntries(Object.entries(abOpp).map(([n,m])=>[n,Object.entries(m).sort((a,b)=>b[1]-a[1]).map(([o,c])=>[shortTeam(o),c])]));
  // Team-Matrix (BL): Punkte je Tipper je Team, Kurznamen; Teamspalten nach Gesamtpunkten sortiert
  const teamTotals={}; for(const t of Object.values(teamPts)) for(const[team,v]of Object.entries(t)) teamTotals[team]=(teamTotals[team]||0)+v;
  const teamList=Object.entries(teamTotals).sort((a,b)=>b[1]-a[1]).map(([t])=>t);
  const teamMatrix=Object.fromEntries(Object.entries(teamPts).map(([n,t])=>[n, teamList.map(team=>t[team]||0)]));
  const teamCols=teamList.map(shortTeam);
  const bestOf3=(map,short)=>{const o={};for(const[n,t]of Object.entries(map)){o[n]=Object.entries(t).sort((a,b)=>b[1]-a[1]).slice(0,3).map(([tm,v])=>[short?shortTeam(tm):tm,v]);}return o;};
  const bvbOppByPlayer=Object.fromEntries(Object.entries(bvbOpp).map(([n,m])=>[n,Object.entries(m).sort((a,b)=>b[1]-a[1]).map(([o,c])=>[shortTeam(o),c])]));
  const ADV={ wonDay:wonDayPts, bayern:Object.fromEntries(Object.entries(teamPts).map(([n,t])=>[n,t['FC Bayern München']||0])), bestTeam:bestOf(teamPts), bestCountry:bestOf(countryPts), bestTeam3:bestOf3(teamPts,true), bestCountry3:bestOf3(countryPts,false), bonusCat:bonusCatAll, abOppTop, abOppByPlayer, proBayTips, proBayPts, proBayFail, bayWinAct, teamCols, teamMatrix,
    klassikerPts, klassikerN, bayGoalPred, bayExact, bayernTitle:bayernTitleAll, antiBVB, bvbOppByPlayer, proBVB, schadenPts, doppelmoral,
    bayMarginSum, judasPts, zauderer, goretzka,
    bayMaxMargin:Object.fromEntries(Object.entries(bayMaxMargin).map(([n,o])=>[n,{margin:o.margin,tip:o.tip,match:o.fx?shortTeam(o.fx[0])+' – '+shortTeam(o.fx[1]):null,season:o.season}])) };

  // ---- LZ ----
  const LZ={ zero, loser };

  // ---- STATS18 ----
  const pers={};
  for(const[n,p]of Object.entries(P)){ const top=o=>{const e=Object.entries(o).sort((a,b)=>b[1]-a[1]);return e[0]||[null,0];};
    const fav=top(p.res);
    pers[n]={avgGoals:r2(p.goals/p.tips),drawPct:r2(100*p.draws/p.tips),homeWinPct:r2(100*p.homeWin/p.tips),awayWinPct:r2(100*(p.tips-p.homeWin-p.draws)/p.tips),hitRate:r2(100*p.hit/p.tips),exactPct:r2(100*p.exact/p.tips),ptsPerTip:r2(p.mpts/p.tips),ptsPerHit:p.hit?r2(p.mpts/p.hit):0,favResult:fav,habitPct:r2(100*(fav[1]||0)/p.tips),favTeam:top(p.backT),favCountry:top(p.backC),tips:p.tips}; }
  const twins=Object.entries(pair).map(([k,o])=>({pair:k.split('|'),pct:r2(100*o.same/o.shared),shared:o.shared,same:o.same})).sort((a,b)=>b.pct-a.pct);
  record.sort((a,b)=>b.pts-a.pts); const recTop=record.slice(0,6);
  const recTopBL=record.filter(r=>r.type==='BL').slice(0,6);
  const recTopCup=record.filter(r=>r.type==='CUP').slice(0,6);
  // dedupe collective (BL days pushed once above)
  const collDays={}; worstDays.forEach(d=>{collDays[d.season+'#'+d.md]=d;});
  const allDays=Object.values(collDays).sort((a,b)=>a.avg-b.avg);
  // Verrückteste exakt getroffene Ergebnisse: nach Toranzahl, dann Tordifferenz
  const crazyTop=[...crazy].sort((a,b)=> b.tot-a.tot || b.diff-a.diff).slice(0,10)
    .map(c=>({...c, match:c.fx?shortTeam(c.fx[0])+' – '+shortTeam(c.fx[1]):null, fx:undefined}));
  // Ergebnistyp-Treffsicherheit: Quote je echtem Ausgang (H/D/A)
  const outcomeType=Object.fromEntries(Object.entries(outcome).map(([n,o])=>[n,{
    H:{tot:o.H.tot,ok:o.H.ok,pct:o.H.tot?r2(100*o.H.ok/o.H.tot):null},
    D:{tot:o.D.tot,ok:o.D.ok,pct:o.D.tot?r2(100*o.D.ok/o.D.tot):null},
    A:{tot:o.A.tot,ok:o.A.ok,pct:o.A.tot?r2(100*o.A.ok/o.A.tot):null} }]));
  const STATS18={ pers, twins, recTop, recTopBL, recTopCup, worstDays:allDays.slice(0,5), bestDays:[...allDays].reverse().slice(0,5),
    winStreak:Object.entries(winStreakBest).sort((a,b)=>b[1]-a[1]), groupFav:Object.entries(groupRes).sort((a,b)=>b[1]-a[1]).slice(0,6),
    groupUnpop:(()=>{const gt=s=>s.split(':').reduce((a,b)=>a+(+b||0),0);
      return Object.entries(groupRes).sort((a,b)=> a[1]-b[1] || gt(b[0])-gt(a[0])).slice(0,6)
        .map(([r,c])=>[r,c,Object.entries(groupResWho[r]||{}).sort((x,y)=>y[1]-x[1]).map(e=>e[0])]);})(),
    prophetChamp, prophetHerbst,
    konstanz, leaderMd, leadStreak, underdog, underdogOpp, crazy:crazyTop, outcomeType,
    worstTip:[...worstTip].sort((a,b)=>b.dist-a.dist).slice(0,8).map(w=>({...w,match:w.fx?shortTeam(w.fx[0])+' – '+shortTeam(w.fx[1]):null,fx:undefined})),
    megalo, beton, pannen, pannenMd };

  return { DATA, BONUS, BONUS_SEASON, METRICS, ADV, LZ, STATS18, seasons: DATA.seasons };
}
