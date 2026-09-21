import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { buildData } from './scrape.js';
import { config } from './config.js';

// Finanz-Config: aus Secret (BRUN_FINANCE_JSON) ODER lokaler finance.config.js (nur lokal, gitignored).
async function loadFinance(){
  if(process.env.BRUN_FINANCE_JSON){ try{ return JSON.parse(process.env.BRUN_FINANCE_JSON); }catch(e){ console.error('BRUN_FINANCE_JSON ungültig:', e.message); } }
  try{ return (await import('./finance.config.js')).finance; }catch(e){ return null; }
}

const __dir = path.dirname(fileURLToPath(import.meta.url));
const p = (...x) => path.join(__dir, ...x);

function encryptFinance(obj, password){
  const salt=crypto.randomBytes(16), iv=crypto.randomBytes(12), iter=250000;
  const key=crypto.pbkdf2Sync(password, salt, iter, 32, 'sha256');
  const c=crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct=Buffer.concat([c.update(Buffer.from(JSON.stringify(obj),'utf8')), c.final()]);
  const tag=c.getAuthTag();
  const b64=b=>b.toString('base64');
  return { salt:b64(salt), iv:b64(iv), iter, ct:b64(Buffer.concat([ct,tag])) };
}
function replaceConst(html, name, valueLiteral){
  const anchor = new RegExp('const '+name.replace(/[.*+?^${}()|[\\]\\\\]/g,'\\$&')+'\\s*=\\s*');
  const m = anchor.exec(html);
  if(!m) throw new Error('const nicht gefunden: '+name);
  let i = m.index + m[0].length, depth=0, inStr=false, strCh='', end=-1;
  for(; i<html.length; i++){
    const c=html[i];
    if(inStr){ if(c==='\\'){i++;continue;} if(c===strCh)inStr=false; continue; }
    if(c==='"'||c==="'"||c==='`'){ inStr=true; strCh=c; continue; }
    if(c==='{'||c==='[') depth++;
    else if(c==='}'||c===']') depth--;
    else if(c===';'&&depth===0){ end=i; break; }
  }
  if(end<0) throw new Error('Statement-Ende nicht gefunden: '+name);
  return html.slice(0,m.index) + `const ${name} = ${valueLiteral};` + html.slice(end+1);
}

(async () => {
  console.log('▶ Scrape + Berechnung …');
  const t0=Date.now();
  const data = await buildData(config);
  // RoboSepps aktuelle Tipps + Begründungen (aus dem Robo-Workflow committet) — vor der Serialisierung anhängen
  try{ data.ADV.roboTips = JSON.parse(fs.readFileSync(p('robo-tips.json'),'utf8')); }catch(e){ data.ADV.roboTips=null; }
  console.log(`  ✓ ${((Date.now()-t0)/1000).toFixed(1)}s · ${data.DATA.seasons.length} Wettbewerbe · ${data.DATA.players.length} Tipper`);

  let html = fs.readFileSync(p('template.html'), 'utf8');
  for(const [name,obj] of [['DATA',data.DATA],['BONUS',data.BONUS],['BONUS_SEASON',data.BONUS_SEASON],
      ['METRICS',data.METRICS],['ADV',data.ADV],['STATS18',data.STATS18],['LZ',data.LZ]]){
    html = replaceConst(html, name, JSON.stringify(obj));
  }
  html = replaceConst(html, 'DISPLAY_ORDER', JSON.stringify(config.displayOrder));

  // Finanzen verschlüsseln
  const pw = process.env.BRUN_FIN_PASSWORD;
  const finance = await loadFinance();
  if(pw && pw.length>=4 && finance){
    const enc = encryptFinance(finance, pw);
    html = html.replace('__FIN_ENC__', JSON.stringify(enc));
    console.log('  ✓ Finanzen verschlüsselt (AES-GCM, passwortgeschützt)');
  } else {
    html = html.replace('__FIN_ENC__', 'null');
    console.warn('  ⚠ Kein Passwort/Finanzdaten → öffentliche Seite OHNE Finanz-Tab-Inhalt'
      + (finance?' (BRUN_FIN_PASSWORD fehlt)':' (keine Finanz-Config)'));
  }

  const outDir = p('dist'); fs.mkdirSync(outDir, {recursive:true});
  fs.writeFileSync(path.join(outDir,'index.html'), html);
  // Artifact-Variante: claude.ai wickelt selbst in <!doctype html>-Skelett -> eigene Doctype/HTML-Tags entfernen
  fs.writeFileSync(path.join(outDir,'artifact.html'), html.replace(/^<!doctype html>\s*<html[^>]*>\s*/i,''));
  fs.writeFileSync(path.join(outDir,'.nojekyll'), '');
  try{ fs.copyFileSync(p('sw.js'), path.join(outDir,'sw.js')); }catch(e){} // Service Worker mit ausliefern
  // Push-Ereignis-Zustand: wird vom Vor-Deploy geholt und mit dem neuen Build verglichen (notify.js)
  try{
    const live=data.ADV.liveMd||{}; const rid=Object.keys(live)[0]; let st=null;
    if(rid){ const lm=live[rid]; const md=lm.mds.find(m=>m.md===lm.cur);
      const season=data.DATA.seasons.find(x=>x.id===rid); const act=season.standings.filter(x=>x.active);
      const now=Date.now(); const anyLive=(md.ko||[]).some(k=>k&&now>=k&&now<k+125*60000);
      const p4={}; md.rows.forEach(r=>{p4[r.n]=r.tips.filter((t,i)=>t&&md.results[i]&&t[2]>=4).length;});
      const mdDone=md.results.length>0&&md.results.every(Boolean);
      const win=[...md.rows].sort((a,b)=>b.t-a.t)[0];
      const tipped=md.rows.filter(r=>r.tips.some(t=>t));
      const last=tipped.length?[...tipped].sort((a,b)=>a.t-b.t)[0]:null;
      const solved=((data.ADV.bonusTips||{})[rid]||{cols:[]}).cols.filter(h=>!/-{3}$/.test(h)).length;
      st={ id:rid, md:lm.cur, anyLive, p4, mdDone,
        winner:win?win.n:null, winnerPts:win?win.t:0,
        last:last?last.n:null, lastPts:last?last.t:0,
        leader:act[0].name, leaderPts:act[0].total, second:act[1]?act[1].name:null, secondPts:act[1]?act[1].total:0,
        top3:act.slice(0,3).map(x=>x.pos+'. '+x.name+' '+x.total).join(' · '), bonusSolved:solved };
    }
    fs.writeFileSync(path.join(outDir,'push-state.json'), JSON.stringify(st));
  }catch(e){ console.warn('push-state:', e.message); }
  // App-Icon als Datei (für Push-Notifications): aus dem eingebetteten apple-touch-icon extrahieren
  try{
    const m=html.match(/rel="apple-touch-icon" href="data:image\/png;base64,([^"]+)"/);
    if(m) fs.writeFileSync(path.join(outDir,'icon.png'), Buffer.from(m[1],'base64'));
  }catch(e){}
  console.log(`▶ Geschrieben: dist/index.html (${(html.length/1024).toFixed(0)} KB) · Stand ${data.DATA.generated}`);
})().catch(e=>{ console.error('BUILD FEHLER:', e); process.exit(1); });
