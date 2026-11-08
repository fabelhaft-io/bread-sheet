-- TICKET-P6-008 Slice B — pg_trgm-backed `GET /api/products/search`.
--
-- `gin_trgm_ops` lives in the `pg_trgm` extension, which ships with Postgres
-- but isn't enabled by default — unlike the partial unique index in
-- 20260703120000_product_edits_peer_review, this one IS representable in the
-- Prisma schema DSL (`@@index([name(ops: raw("gin_trgm_ops"))], type: Gin)` on
-- `Product`), so `prisma migrate dev` generated the two CREATE INDEX
-- statements below unassisted. The CREATE EXTENSION statement is hand-added
-- (Prisma has no DSL concept of extensions) and must run first or the
-- `gin_trgm_ops` operator class below does not exist yet.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- CreateIndex
CREATE INDEX "Product_name_idx" ON "Product" USING GIN ("name" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "Product_brand_idx" ON "Product" USING GIN ("brand" gin_trgm_ops);
