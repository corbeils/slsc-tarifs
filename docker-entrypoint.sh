#!/bin/sh
set -e
# Rules (YAML) live in a volume so they can be edited from the Admin panel.
#  - missing file            -> copy the default
#  - file identical to a previously shipped default (never edited)
#                            -> upgrade to the new default (backup kept as .bak)
#  - file edited by the user -> left untouched
for f in /app/rules.default/*.yaml; do
  name=$(basename "$f")
  dest="/app/rules/$name"
  if [ ! -f "$dest" ]; then
    cp "$f" "$dest"
    echo "[rules] $name installed"
    continue
  fi
  cur=$(sha256sum "$dest" | cut -d' ' -f1)
  new=$(sha256sum "$f" | cut -d' ' -f1)
  if [ "$cur" != "$new" ] && grep -q "$cur" /app/rules-history.sha256; then
    cp "$dest" "$dest.bak"
    cp "$f" "$dest"
    echo "[rules] $name upgraded to the new default version"
  fi
done
exec "$@"
