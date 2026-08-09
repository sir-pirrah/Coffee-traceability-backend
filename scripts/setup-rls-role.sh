#!/usr/bin/env bash
#
# Provisions the restricted database role that row-level security depends on.
#
# The RLS policies are only load-bearing if the application connects as a role
# that is neither a superuser nor the owner of the tables — Postgres exempts both
# from policies (the owner unless the table is FORCEd, which ours are, but the
# superuser exemption has no override at all). The migration creates `app_user`
# with no password, because a credential written into a migration is a credential
# in everyone's git history. This script sets that password locally and points
# APP_DATABASE_URL at it.
#
# Run once after `prisma migrate deploy`, from the backend directory:
#   ./scripts/setup-rls-role.sh
#
# It is idempotent: re-running rotates the password and rewrites the .env line.

set -euo pipefail

cd "$(dirname "$0")/.."
ENV_FILE=".env"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "error: $ENV_FILE not found — run this from the backend project." >&2
  exit 1
fi

# Parse the admin connection out of DATABASE_URL. The password may contain '@'
# and ':', so split on the LAST '@' rather than the first.
ADMIN_URL=$(grep -E '^DATABASE_URL=' "$ENV_FILE" | head -1 | sed -E 's/^DATABASE_URL=//; s/^"//; s/"$//')
if [[ -z "$ADMIN_URL" ]]; then
  echo "error: DATABASE_URL is not set in $ENV_FILE" >&2
  exit 1
fi

no_scheme="${ADMIN_URL#postgresql://}"
no_scheme="${no_scheme#postgres://}"
creds="${no_scheme%@*}"          # everything before the last '@'
hostpart="${no_scheme##*@}"      # host:port/db?params
ADMIN_USER="${creds%%:*}"
ADMIN_PASS="${creds#*:}"
hostport="${hostpart%%/*}"
dbandparams="${hostpart#*/}"
DB_NAME="${dbandparams%%\?*}"
DB_PARAMS=""
[[ "$dbandparams" == *"?"* ]] && DB_PARAMS="?${dbandparams#*\?}"
DB_HOST="${hostport%%:*}"
DB_PORT="${hostport##*:}"
[[ "$DB_PORT" == "$DB_HOST" ]] && DB_PORT=5432

# A generated password keeps it out of shell history and out of this file.
APP_PASS="$(head -c 32 /dev/urandom | base64 | tr -d '/+=' | head -c 32)"

echo "Setting password for app_user on ${DB_HOST}:${DB_PORT}/${DB_NAME}…"
PGPASSWORD="$ADMIN_PASS" psql -v ON_ERROR_STOP=1 -h "$DB_HOST" -p "$DB_PORT" -U "$ADMIN_USER" -d "$DB_NAME" -q <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    RAISE EXCEPTION 'app_user does not exist — run "npx prisma migrate deploy" first';
  END IF;
END \$\$;

ALTER ROLE app_user WITH LOGIN PASSWORD '${APP_PASS}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
SQL

# URL-encode the few characters that would otherwise break the connection string.
ENCODED_PASS=$(printf '%s' "$APP_PASS" | sed -e 's/%/%25/g' -e 's/@/%40/g' -e 's/:/%3A/g' -e 's|/|%2F|g' -e 's/?/%3F/g' -e 's/#/%23/g')
APP_URL="postgresql://app_user:${ENCODED_PASS}@${DB_HOST}:${DB_PORT}/${DB_NAME}${DB_PARAMS}"

# Replace the existing line if there is one, otherwise append.
if grep -qE '^APP_DATABASE_URL=' "$ENV_FILE"; then
  tmp=$(mktemp)
  grep -vE '^APP_DATABASE_URL=' "$ENV_FILE" > "$tmp"
  mv "$tmp" "$ENV_FILE"
fi
printf '\n# Restricted runtime role that RLS policies apply to (see scripts/setup-rls-role.sh).\nAPP_DATABASE_URL="%s"\n' "$APP_URL" >> "$ENV_FILE"
chmod 600 "$ENV_FILE"

echo "Verifying the role is genuinely restricted…"
PGPASSWORD="$APP_PASS" psql -v ON_ERROR_STOP=1 -h "$DB_HOST" -p "$DB_PORT" -U app_user -d "$DB_NAME" -tAc \
  "SELECT 'superuser=' || rolsuper || ' bypassrls=' || rolbypassrls FROM pg_roles WHERE rolname = current_user;"

echo
echo "Done. APP_DATABASE_URL written to $ENV_FILE."
echo "Restart the backend so it picks up the new connection."
