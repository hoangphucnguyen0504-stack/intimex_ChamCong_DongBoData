#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
umask 077
mkdir -p backups
target="backups/datadongbo-$(date -u +%Y%m%dT%H%M%SZ).sql.gz"
temporary="${target}.partial"
trap 'rm -f -- "$temporary"' EXIT
docker compose exec -T mysql sh -c 'MYSQL_PWD="$MYSQL_PASSWORD" exec mysqldump --single-transaction --no-tablespaces --routines --triggers -u"$MYSQL_USER" "$MYSQL_DATABASE"' | gzip > "$temporary"
gzip -t "$temporary"
mv -- "$temporary" "$target"
printf 'Backup created: %s\n' "$target"
