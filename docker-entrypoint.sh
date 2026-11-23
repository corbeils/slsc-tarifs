#!/bin/sh
set -e
# Premier démarrage : copier les règles par défaut dans le volume (sans écraser vos modifications)
for f in /app/rules.default/*.yaml; do
  name=$(basename "$f")
  [ -f "/app/rules/$name" ] || cp "$f" "/app/rules/$name"
done
exec "$@"
