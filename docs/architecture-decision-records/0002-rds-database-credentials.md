# RDS Database Credential Strategy

* Status: Accepted
* Date: 2026-06-26

## Context and Problem Statement

The Fargate production stack ([cheap-prod-fargate.md](../architecture/cheap-prod-fargate.md))
runs the server against a managed RDS PostgreSQL instance in a private subnet, reachable only
from the task security group. The server uses Prisma. We need to decide **how the task
authenticates to the database**: a long-lived password, an auto-rotated secret, or keyless IAM
database authentication — balancing security posture, cost, and application complexity.

The rest of the stack is deliberately **keyless** (S3 via IRSA, Google Cloud via Workload
Identity Federation — no static keys anywhere), so a standing database password is the one
remaining long-lived secret and is worth scrutinising.

## Decision Drivers

* **Keyless aesthetic:** the stack avoids long-lived credentials elsewhere; a static DB password
  is the odd one out.
* **Cost:** the whole point of the Fargate rebuild is low always-on cost. RDS Proxy (~$15/mo) and
  Secrets Manager (~$0.40/secret/mo + rotation Lambda) are non-trivial against that baseline.
* **Application complexity:** Prisma's connection string is static by default. Anything that
  rotates credentials must hook into connection creation.
* **Time-to-working-stack:** the hand-build needs to reach a deployable end-to-end state
  (Objectives 6–9) before polishing auth.

## Considered Options

* **A — Static password in SSM Parameter Store (`SecureString`).** Master password set at DB
  creation, stored KMS-encrypted in SSM, assembled into `DATABASE_URL`, injected into the task.
  Zero application code. The password is long-lived but never in the image or git; only the task
  role can read it.
* **B — AWS Secrets Manager with rotation.** Managed rotation Lambda rotates the password on a
  schedule; the app fetches the current secret per new connection. Auto-rotating, but adds
  ~$0.40/secret/mo plus the rotation Lambda, and still stores a password.
* **C — RDS IAM database authentication.** No stored DB password at all. The app mints a
  short-lived (15 min) IAM auth token per new connection; the DB user is granted `rds_iam`; TLS
  is mandatory. Most keyless, $0 extra, but requires application code.
* **C-via-RDS-Proxy.** IAM auth fronted by RDS Proxy so the app needs no token logic — rejected
  on cost (~$15/mo defeats the cheap-prod goal).

### The mechanism that makes B and C feasible with Prisma

Originally we believed Prisma could not handle rotating credentials without RDS Proxy, because its
pool uses a static connection string. This is **no longer true**. Two pieces solve it:

1. **node-postgres `pg.Pool` accepts an async `password` callback**, invoked on every *new
   physical connection* (not per query):
   ```js
   const pool = new Pool({ host, user, database, port: 5432, password: async () => getToken() });
   ```
2. **Prisma's driver adapter (`@prisma/adapter-pg` / `PrismaPg`, now GA)** delegates connection
   management to that `pg.Pool`, so the callback actually runs.

For Secrets Manager (B) the callback returns the current secret. For IAM auth (C) it mints a fresh
token (`new Signer({...}).getAuthToken()` — a *local signing* operation, no network round-trip).
This aligns with Postgres semantics: a credential only needs to be valid at connection
*establishment*; an authenticated session survives the token's expiry. Only new connections need
fresh credentials — exactly when the callback fires. No mid-session refresh, no RDS Proxy.

## Decision Outcome

**Ship A (SSM `SecureString` password) for the initial build; adopt C (IAM auth + driver-adapter
callback) as an isolated follow-up once the stack runs end-to-end.**

Rationale: A is zero application code and unblocks the deployable milestone fastest. Because the
driver-adapter change is self-contained (only the Prisma client init changes), C can be adopted
later without touching the rest of the system. We therefore **enable the IAM DB authentication
toggle on the instance now** — it is a no-reboot modify and coexists with password auth — so the
door to C stays open for free. B is not chosen: it keeps a stored password *and* adds cost, giving
the worst of both relative to A (simplicity) and C (no secret, no cost).

> **Update (Session 15):** the `@prisma/adapter-pg` driver adapter (`src/db.ts`) is already wired in
> interim state A — so the TLS half of C is decoupled and **done now**, ahead of the credential
> migration. The pg pool verifies the RDS server cert against the RDS CA bundle shipped in the image
> with `rejectUnauthorized: true` (`configs/databaseConfig.ts`, gated by the required `DB_SSL` env:
> `disabled` locally, `verify-full` on RDS). This was forced by a real bug, not foresight: pg ≥ 8.22
> treats the URL's `sslmode=require` as `verify-full` against the *default* trust store (which lacks
> the RDS CA), aborting the handshake at query time. When C lands, only the `password` callback is
> added — the CA-bundle TLS is already in place.

### Positive Consequences

* Fastest path to a working, deployable stack — no auth code on the critical path.
* No new always-on cost (no RDS Proxy, no Secrets Manager) in either the interim or target state.
* The target state (C) removes the last long-lived secret, matching the keyless IRSA/WIF posture.
* The migration is a localised, low-risk change (Prisma client init only).

### Negative Consequences

* The interim state keeps one long-lived DB password (mitigated: KMS-encrypted in SSM, readable
  only by the task role, never in image/git).
* C is deferred application work that must be implemented and tested (driver adapter + token
  callback + RDS CA-bundle TLS with `rejectUnauthorized: true` — *not* the lax `false` seen in
  some blog examples).
* For B/C the callback must cache results to avoid hammering the credential source on connection
  storms (cheap for IAM token signing; billed for Secrets Manager).

## References

* node-postgres `Pool` password callback + Prisma `@prisma/adapter-pg` pattern:
  [Handling Dynamic Database Credential Rotation in Prisma with AWS Secrets Manager](https://medium.com/tales-from-nimilandia/title-handling-dynamic-database-credential-rotation-in-prisma-with-aws-secrets-manager-b9c8cd418b9b)
* Runbook step that applies this: [fargate-handbuild.md](../architecture/fargate-handbuild.md) —
  Objective 3 (credentials) and the post-build adaptation note.