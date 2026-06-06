# Server — Production Checklist

## Environment Variables

- [ ] `DATABASE_URL` — points to production RDS instance, not localhost
- [ ] `SUPABASE_URL` — production Supabase project URL
- [ ] `SUPABASE_PUBLISHABLE_DEFAULT_KEY` — production Supabase anon key
- [ ] `ALLOWED_ORIGINS` — comma-separated list of production frontend origins (e.g. `https://app.breadsheet.com`). Currently defaults to `http://localhost:8081` which must not reach production
- [ ] `NODE_ENV=production`
- [ ] `PORT` — set if different from 3000
- [ ] `APP_DEEP_LINK_SCHEME=breadsheet` — use the bare scheme for production builds (not `exp+breadsheet`, which is Expo Go only)

## Supabase

- [ ] Settings → Authentication → URL Configuration → Redirect URLs — add `https://api.breadsheet.com/auth/callback` (the server's `/auth/callback` endpoint, not a custom scheme URL — Supabase rejects non-HTTP schemes)

## Database

- [ ] Run migrations before deploying: `npm run db:deploy`
- [ ] Confirm RDS security group only accepts connections from EKS node group, not public internet
- [ ] Enable RDS automated backups and set retention period

## Email (SMTP)

- [ ] Configure a custom SMTP provider in Supabase dashboard (Settings → Auth → SMTP). The free tier caps outbound auth emails at 3 per hour — this will break the signup and account upgrade flows under any real usage
- [ ] Recommended providers: Resend, Mailgun, or AWS SES (already in the stack)
- [ ] Configure auth email templates (verification, password reset) with production branding and a `Reply-To` address
- [ ] Confirm the `From` address matches a domain with valid SPF/DKIM records to avoid spam filtering

## Security

- [ ] Verify `ALLOWED_ORIGINS` is set — the CORS default allows localhost only, production will block the app otherwise
- [ ] Review rate limit thresholds (`apiLimiter`, `userLimiter`, `syncLimiter`) against expected production traffic
- [ ] Ensure error responses never leak stack traces — `errorHandler` should not forward `err.stack` in `NODE_ENV=production`
- [ ] Put WAF rules (AWS WAF or Cloudflare) in front of the ALB for network-layer DDoS protection
- [ ] Set anonymous user cap in Supabase project settings

## Infrastructure

- [ ] Confirm Docker image builds cleanly: `docker compose build`
- [ ] ArgoCD sync policy configured for the production cluster
- [ ] Kubernetes liveness/readiness probes point to `GET /` health check
- [ ] Resource requests/limits set on the server pod
- [ ] HorizontalPodAutoscaler configured if traffic is variable

## Observability

- [ ] Winston log level set to `warn` or `error` in production (not `info`)
- [ ] Logs shipped to CloudWatch or equivalent
- [ ] Uptime monitoring on `GET /` health check endpoint

## Before Each Release

- [ ] `npm run typecheck` passes with no errors
- [ ] `npm run build` succeeds locally before pushing
- [ ] Database migrations reviewed — no destructive column drops without a rollback plan
