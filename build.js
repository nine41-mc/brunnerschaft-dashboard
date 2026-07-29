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
  console.log(`▶ Geschrieben: dist/index.html (${(html.length/1024).toFixed(0)} KB) · Stand ${data.DATA.generated}`);
})().catch(e=>{ console.error('BUILD FEHLER:', e); process.exit(1); });
