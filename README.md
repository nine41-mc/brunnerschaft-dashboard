# ⚽🍺 Brunnerschaft-Dashboard — Build-Pipeline

Baut das öffentliche Statistik-Dashboard aus den (öffentlichen) Kicktipp-Daten der
Community **brunnerschaft** und veröffentlicht es automatisch auf **GitHub Pages**.
Der Kassenwart-/Finanzteil ist **passwortverschlüsselt** (AES-GCM), Klarnamen liegen
nie im Klartext im öffentlichen Repo.

## Wie es funktioniert
`node build.js` →
1. **Scrape** aller Saisons/Spieltage/Bonusfragen von kicktipp.de (öffentlich, kein Login),
2. **Berechnung** aller Statistiken (`scrape.js`),
3. **Rendern** in `template.html` (Daten werden eingespielt),
4. **Finanzen verschlüsseln** (aus dem Secret) und einbetten,
5. Ergebnis: `dist/index.html` (eine einzige, selbst-enthaltene Datei).

Ein GitHub-Actions-Cron baut das täglich neu und deployt es → nach jedem Spieltag ist
die Seite spätestens am nächsten Morgen aktuell.

## Einmalige Einrichtung (GitHub Pages)
1. **Neues GitHub-Repo** anlegen (z. B. `brunnerschaft-dashboard`) und den Inhalt dieses
   `pipeline/`-Ordners hineinlegen (Branch `main`). `finance.config.js` wird **nicht**
   mit hochgeladen (steht in `.gitignore`).
2. **Repo → Settings → Pages → Build and deployment → Source: „GitHub Actions".**
3. **Repo → Settings → Secrets and variables → Actions → New repository secret:**
   - `BRUN_FIN_PASSWORD` = das Passwort, mit dem die Runde die Finanzen entsperrt.
   - `BRUN_FINANCE_JSON` = die Finanz-Config als JSON (siehe unten „Finanzen pflegen").
4. **Actions → „Build & Deploy" → Run workflow** (oder bis zum nächsten Cron warten).
5. Fertig: Seite liegt unter `https://<dein-github-name>.github.io/<repo>/`.
   Statistiken sind offen, „Auswertungen" fragt nach dem Passwort.

## Laufender Betrieb
- **Nichts tun.** Der tägliche Cron (05:00 UTC) hält alle Statistiken aktuell — inkl.
  der laufenden Saison nach jedem Spieltag.
- **Neuer Mitspieler:** Sobald er in Kicktipp tippt, taucht er automatisch in allen
  Statistiken auf. Für die Finanzen: seinen Kicktipp-Handle in `paypal` ergänzen
  (siehe „Finanzen pflegen"). Avatar: siehe unten.

## Finanzen pflegen (`finance.config.js` → Secret)
Die Finanzdaten liegen aus Datenschutzgründen **nicht im Repo**, sondern im Secret
`BRUN_FINANCE_JSON`. Zum Ändern (z. B. „X hat eingezahlt", neuer Auszahlungsmodus,
neues Mitglied):
1. `finance.config.js` lokal anpassen.
2. Neuen JSON-Wert erzeugen:
   ```bash
   node --input-type=module -e 'import {finance} from "./finance.config.js";console.log(JSON.stringify(finance))'
   ```
3. Ausgabe kopieren → GitHub → Secret `BRUN_FINANCE_JSON` aktualisieren.
4. Actions → Run workflow (oder Cron abwarten).

Felder in `finance.config.js`:
- `settle[id] = {in, out}` — `in`: **alle** Einzahlungen erfolgt, `out`: ausgezahlt.
- `paidIn[id] = [Handles]` — wer bereits eingezahlt hat (wird im PayPal-Abgleich vorab abgehakt), solange `in:false`.
- `payoutMode[id]` — `'p532'` (50/30/20) · `'firstlast'` (Erster & Letzter je 50 %) · `'split3'` (Top 3 je ⅓) · `'winner'` (Sieger alles).
- `paypal[handle] = 'Klarname'` · `ownerHandle` = Kontoinhaber (kein Eingang nötig) · `fees = {BL, CUP}`.

## Neue Saison
Archivierte Saisons werden **automatisch** erkannt. Nur die **aktive/laufende** Saison
(und Saisons in einer separaten Community) müssen in `config.js → seasons` deklariert
werden (ID, Name, Typ, Community) — die ID steht in der Kicktipp-URL (`tippsaisonId=…`).
In `config.js → displayOrder` die neue ID vorne einsortieren, in `finance.config.js`
Modus/Status ergänzen.

## Avatare
Die Mitglieder-Avatare sind als Base64 direkt in `template.html` eingebettet (`const MEMOJI`).
Neues Avatar: Bild lokal auf ~150 px verkleinern, Base64 erzeugen und unter dem
Kicktipp-Handle in `MEMOJI` eintragen.

## Lokal testen
```bash
npm install
BRUN_FIN_PASSWORD='test' node build.js   # nutzt lokale finance.config.js
open dist/index.html
```
