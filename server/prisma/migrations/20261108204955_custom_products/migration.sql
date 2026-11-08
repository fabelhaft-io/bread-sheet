-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "nameKey" TEXT;

-- Hand-written: DB-level "one name per CUSTOM product" rule (TICKET-P6-007,
-- ADR 0006 decision 3). Prisma's schema DSL cannot express partial unique
-- indexes (same reason `one_pending_edit_per_product` in
-- 20260703120000_product_edits_peer_review is hand-written), so this lives
-- only in the migration. Scoped to `kind = 'CUSTOM' AND status <> 'REJECTED'`
-- so: (a) PACKAGED rows (nameKey always NULL) are never compared — NULLs are
-- distinct from each other under a unique index anyway, but the kind filter
-- makes the intent explicit — and (b) a REJECTED custom product never blocks
-- its name from being reused by a fresh submission. Race-safe: two
-- concurrent creates of "Negroni" produce one row and one P2002, which
-- `createCustomProduct` (services/customProductService.ts) catches and turns
-- into a friendly `409 duplicate_name`.
CREATE UNIQUE INDEX "custom_product_name_unique" ON "Product"("nameKey") WHERE "kind" = 'CUSTOM' AND "status" <> 'REJECTED';
