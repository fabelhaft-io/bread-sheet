# Architecture Overview

System-wide architecture of BreadSheet — a social food rating mobile app.
For component deep-dives see the sibling documents in this directory.

---

## 1. High-Level Structure

BreadSheet is built on a **client-server model** with three pillars:

| Pillar | Technology | Purpose |
|--------|-----------|---------|
| **Frontend** (`bread-sheet-app/`) | Expo (React Native) | Cross-platform mobile UI |
| **Backend** (`server/`) | Node.js / Express / Prisma | Business logic, API, database |
| **Infrastructure** (`terraform/`, `docker/`) | Terraform + Docker Compose | Cloud provisioning + local dev |

---

## 2. Component Map

```
┌─────────────────────────────────────────────────────────┐
│                    Mobile App (Expo)                     │
│         iOS / Android / Web (React Native)               │
└──────────────────────┬──────────────────────────────────┘
                       │ HTTPS (Bearer JWT)
┌──────────────────────▼──────────────────────────────────┐
│               Node.js / Express API                      │
│   Routes → Controllers → Services → Prisma ORM          │
└──────┬───────────────┬──────────────────────┬───────────┘
       │               │                      │
┌──────▼──────┐ ┌──────▼──────┐  ┌────────────▼──────────┐
│ PostgreSQL  │ │  Amazon S3  │  │   External Services   │
│  (RDS/     │ │  (images)   │  │  Open Food Facts API  │
│  local PG) │ │             │  │  Supabase Auth        │
└─────────────┘ └─────────────┘  │  Google Cloud Vision  │
                                  │  Google Gemini/Vertex │
                                  └───────────────────────┘
```

---

## 3. Request / Data Flow

1. **User action** — performed in the React Native app.
2. **API request** — app sends HTTPS request with a Supabase Bearer JWT.
3. **Auth middleware** — `authMiddleware.ts` validates the JWT via Supabase; injects `req.user`.
4. **Business logic** — controller delegates to a service; service applies rules and calls Prisma.
5. **Database** — Prisma executes queries against PostgreSQL.
6. **External calls (conditional)**
   - Barcode lookup → Open Food Facts API
   - Image upload → S3 (LocalStack in dev)
   - Label OCR (`VISION_MODE=live`) → Google Cloud Vision
   - Label structuring (`VISION_MODE=llm`) and image plausibility / abuse gating (`PLAUSIBILITY_MODE=gemini`) → Google Gemini (Developer API locally, Vertex AI in prod)
7. **Response** — server returns JSON; client updates state and re-renders.

---

## 4. External Services

| Service | Used for | Data sent |
|---------|----------|-----------|
| **Supabase Auth** | User auth, anonymous sessions, JWT issuance | Email, password hash (managed by Supabase) |
| **Open Food Facts API** | Read: barcode lookups; Write: contributing new/corrected products | Product data, images (via bot account) |
| **Google Cloud Vision** | OCR of label images (`VISION_MODE=live`) | Nutritional label image bytes |
| **Google Gemini / Vertex AI** | One-shot label structuring (`VISION_MODE=llm`); image plausibility + abuse gating (`PLAUSIBILITY_MODE=gemini`) | Label or product image bytes |
| **Amazon S3** | Storing user-uploaded product images | Image files (keyed by UUID, no PII in key) |
| **AWS Lambda** | S3-triggered image resizing (raw → processed prefix) | Image bytes |

> See `data.md` for a full analysis of what user data each service receives and the legal basis for each transfer.

---

## 5. Key Cross-Cutting Concerns

- **Authentication:** Every API route except product reads requires a valid Supabase JWT. See `backend.md` for middleware order.
- **Authorization:** Ownership guards (`requireSelf`, `requireGroupMember`, `requireGroupAdmin`) are composable middleware applied at the router layer.
- **Image pipeline:** Client compresses with `expo-image-manipulator` → API validates format/size → uploads to `raw/` prefix → Lambda resizes to `processed/` prefix.
- **Registered vs. anonymous users:** Supabase anonymous sessions are valid JWTs but carry `is_anonymous: true`. Product contributions require a registered account; this is enforced both client-side and via `requireRegistered` middleware.

---

## 6. Environment Summary

| Context | Database | Object storage | Auth |
|---------|----------|----------------|------|
| Local dev | PostgreSQL in Docker | LocalStack (S3-compatible) | Supabase DEV project |
| Production | AWS RDS (PostgreSQL) | Amazon S3 | Supabase production project |

Full environment variable reference: see `CLAUDE.md`.
