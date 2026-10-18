#!/bin/bash
# Full local check: the API suite, then the browser suites, against `wrangler dev` (:8787) and a
# static server (:8765) standing in for the old URL (forwarding page + the board app as it shipped
# before the move). Chrome + puppeteer-core; screenshots land in $MP_WORK/shots.
# Order matters: t1 creates the account, t4 changes its password, t5/t6 log in with the new one.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(dirname "$HERE")"
export MP_WORK="${MP_WORK:-${TMPDIR:-/tmp}/mypager-tests}"
mkdir -p "$MP_WORK/site"
[ -f "$ROOT/worker/.dev.vars" ] || printf 'INVITE_CODE=dev-invite\n' > "$ROOT/worker/.dev.vars"
cp "$ROOT/index.html" "$MP_WORK/site/index.html"
git -C "$ROOT" show cee34e7:index.html > "$MP_WORK/site/old.html"
restart_worker() {
  pkill -f "wrangler dev --port 8787"; sleep 1
  rm -rf "$ROOT/worker/.wrangler/state"
  (cd "$ROOT/worker" && npx --yes wrangler dev --port 8787 --local > "$MP_WORK/wrangler.log" 2>&1 &)
  for i in $(seq 1 60); do curl -s -o /dev/null http://localhost:8787/api/me && return; sleep 1; done
  echo "wrangler dev did not start"; exit 1
}
pkill -f "http.server 8765"; (cd "$MP_WORK/site" && python3 -m http.server 8765 --bind 127.0.0.1 > "$MP_WORK/http.log" 2>&1 &)
restart_worker
echo "== api"; node "$HERE/api.test.mjs" | grep -E "^FAIL|failure|passed"
restart_worker
pkill -f "user-data-dir=$MP_WORK"; rm -rf "$MP_WORK"/prof-*
for t in t1_migrate t2_notes t3_pictures t4_import_conflict t5_mobile t6_export_unlock; do
  echo "== $t"
  node "$HERE/$t.cjs" 2>&1 | grep -E "^(FAIL|fails)|Error|passed"
done
pkill -f "wrangler dev --port 8787"; pkill -f "http.server 8765"
