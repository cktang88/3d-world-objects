#!/usr/bin/env bash
# Check whether URLs can be fetched cross-origin from a browser (prints status + ACAO header).
#   bash scripts/libraries/cors-check.sh URL...
for u in "$@"; do
  echo "== $u"
  curl -sS -o /dev/null -D - -m 25 -L -H "Origin: https://example.com" -r 0-0 "$u" | grep -iE "^HTTP|access-control-allow-origin|content-range|content-type"
done
