#!/bin/sh
set -e

# ECS entrypoint: run migrations then start the server.
# When DB_AUTH=iam, mint a short-lived IAM token and inject it into DATABASE_URL
# for the Prisma migration engine (which reads the URL directly and cannot use
# the pg.Pool async password callback that the runtime uses).

if [ "$DB_AUTH" = "iam" ]; then
  TOKEN=$(node scripts/rds-token.mjs)
  export DATABASE_URL="postgresql://${DB_USER}:${TOKEN}@${DB_HOST}:${DB_PORT:-5432}/${DB_NAME:-breadsheet}?sslmode=require"
fi

npm run db:deploy
exec node dist/server.js
