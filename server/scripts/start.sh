#!/bin/sh
set -e

# ECS entrypoint: run migrations then start the server.
# When DB_AUTH=iam, mint a short-lived IAM token and inject it into DATABASE_URL
# for the Prisma migration engine (which reads the URL directly and cannot use
# the pg.Pool async password callback that the runtime uses).

if [ "$DB_AUTH" = "iam" ]; then
  # The script assembles the URL itself: the token has to be percent-encoded
  # before it can sit in the password slot (it contains `/`, `?`, `&` and `=`),
  # which is not something POSIX sh can do cleanly.
  #
  # Scoped to this one command on purpose — NOT exported. A token lives 15 minutes;
  # leaking it into the server's environment gives the runtime a connection string
  # that still carries a password, and `pg` prefers that over the async signer
  # callback (see db.ts). Every connection after the first 15 minutes then fails
  # with `PAM authentication failed`.
  DATABASE_URL=$(node scripts/rds-token.mjs --database-url) npm run db:deploy
else
  npm run db:deploy
fi
exec node dist/server.js
