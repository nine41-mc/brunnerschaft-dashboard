#!/bin/bash
# Einmalige Einrichtung des Brunnerschaft-Push-Workers auf Cloudflare.
# Ausführen aus diesem Ordner:  cd pipeline/push && ./setup-push.sh
set -e
cd "$(dirname "$0")"

echo "▶ 1/5 Cloudflare-Login (öffnet den Browser) …"
npx -y wrangler@latest login

echo "▶ 2/5 KV-Namespace für die Abos anlegen …"
OUT=$(npx -y wrangler@latest kv namespace create SUBS 2>&1) || true
echo "$OUT"
KV_ID=$(echo "$OUT" | grep -oE '[0-9a-f]{32}' | head -1)
if [ -z "$KV_ID" ]; then
  # existiert evtl. schon — aus der Liste holen
  KV_ID=$(npx -y wrangler@latest kv namespace list | grep -B2 -A2 brunnerschaft-push-SUBS | grep -oE '[0-9a-f]{32}' | head -1)
fi
[ -z "$KV_ID" ] && { echo "❌ Konnte KV-ID nicht ermitteln — bitte Ausgabe oben prüfen."; exit 1; }
sed -i '' "s/KV_ID_PLACEHOLDER/$KV_ID/" wrangler.toml
echo "   KV-ID: $KV_ID"

echo "▶ 3/5 Geheimnisse setzen (VAPID + Notify) …"
npx -y wrangler@latest secret put VAPID_PRIVATE < .vapid-private
npx -y wrangler@latest secret put VAPID_PUBLIC  < .vapid-public
npx -y wrangler@latest secret put NOTIFY_SECRET < .notify-secret

echo "▶ 4/5 Worker deployen …"
npx -y wrangler@latest deploy

echo "▶ 5/5 Fertig! Die Worker-URL steht oben (…workers.dev)."
echo "   Bitte die URL an Claude geben — sie wird dann in Seite + GitHub Action eingetragen."
