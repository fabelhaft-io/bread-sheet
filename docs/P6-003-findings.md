# TICKET-P6-003 — Categories (User-Owned Labels for Organising Ratings) — Review Findings

**Verdict: PASS, with one blocking CI gate and two follow-ups.**
**Branch:** `agent/P6-003` · **Base:** `main` @ `fa890e2`
**Implementation commits:** `17e3019` (backend), `8d3ed35` (frontend)
**Reviewed:** 2026-11-09

> **Do not merge until the PR's `App E2E tests (Playwright, Expo web)` CI job is green.** The new
> `bread-sheet-app/e2e/category-chips.spec.ts` could not be executed on this machine (the podman
> Docker-API socket cannot start forking containers — full evidence below), so CI is the first
> place that spec will ever run. Everything else in the matrix was executed locally and is green.

---

## 1. Current state before this ticket

- `Rating` had no organisational axis: the Home tab listed every rating newest-first, and the only
  way to narrow it was the TICKET-P6-008 Mine-scope search box.
- `features/search/match.ts#filterRatingsByQuery` already carried an unused optional
  `categoryPredicate` parameter, deliberately placed by P6-008 as the AND-composition point for
  these chips. P6-008's Slice A box *"It composes with the category chips"* was left open for this
  ticket to close.
- `Product` had no machine-derived category. The `kind=product` plausibility call already returned
  `name`/`brand`/`genericName`; OFF was fetched with
  `fields=product_name,brands,image_url,generic_name` only.
- Cache schema version was `2`; no endpoint in the API had ever returned `204 No Content`, so
  `lib/api.ts`'s `request()` always called `res.json()`.

## 2. What was implemented

### Backend (`17e3019`)

| Area | Change |
|---|---|
| Schema | New `UserCategory` (`userId` FK cascade, `name`, `slug`, `isSeed`, `createdAt`, `@@unique([userId, slug])`); `Rating.categoryId` FK `onDelete: SetNull` + `@@index`; `Product.suggestedCategory String?`. Migration `20261109143154_user_categories`. |
| Routes | `GET`/`POST /api/users/me/categories`, `PATCH`/`DELETE /api/users/me/categories/:id`, `POST /api/users/me/categories/:id/merge` — all `requireAuth` + `userLimiter`, **no `requireRegistered`**. A `router.param('id')` guard 400s a non-UUID before any handler. |
| Service | `services/categoryService.ts` — find-or-create on `(userId, slug)`, 40-per-user cap, rename with 409 collision, delete, transactional merge, and `resolveRatingCategory` (the `unset` / `clear` / `id` / `seed` discriminated union). |
| Rating write | `POST /api/ratings` accepts optional `categoryId` (own id, or `null` to clear) XOR `seedSlug`. Omitting both leaves the stored category untouched — this is what makes outbox replay safe. `GET /api/users/me/ratings` embeds `category: { id, name } \| null`; `GET /api/ratings/product/:productId` deliberately does **not**. |
| Suggestions | `services/categorySuggestion.ts` — ordered OFF `categories_tags` → seed-slug rule list (first match wins, never from the name) + `normalizeSuggestedCategory`. `imagePlausibilityService.ts` gained a `category` field in the prompt/schema for `kind=product`, re-validated against the seed list in *both* modes. `serializeProduct` exposes `suggestedCategory` as a top-level field. |
| Seeds | `server/src/constants/categorySeeds.ts` — the 23 curated slugs from the ticket, no `other`. |
| Docs | `docs/architecture/backend.md`, `data.md`, `CLAUDE.md`; five new Bruno requests under `docs/bruno/Users/` plus updates to the product/rating ones. |

### Frontend (`8d3ed35`)

| Area | Change |
|---|---|
| Module | `features/categories/` — `types.ts`, `api.ts`, `seeds.ts` (mirror), `validation.ts` (1–24 raw chars), `match.ts` (plain-string Levenshtein, no regex, both inputs pre-capped), `picker.ts` (`mapSuggestion`, `sortOwnCategories`, `unusedSeeds`, `buildRatingCategoryFields`), `filter.ts` (`buildCategoryChips`, `categoryPredicateFor`, `isSelectionVisible`). |
| Rating screen | Category row under the taste control + `components/category-picker-sheet.tsx`. An `existing`-kind suggestion pre-selects *and* is marked touched (so it is sent with no extra tap); a `seed`-kind suggestion is offered as a one-tap create and is not auto-applied. Offline, a failed `createCategory({ seedSlug })` falls back to carrying the bare slug. |
| Home tab | `CategoryChipRow` above "My Ratings" — All, one chip per category present in the cached list with counts (most-used first), Uncategorised last. Composed with the search box via `filterRatingsByQuery(..., categoryPredicateFor(filter))`. Selection persisted in a new `categoryFilterCache` document; falls back to All when the selection's chip vanishes. |
| Manage Categories | `app/(app)/manage-categories.tsx`, registered in `(app)/_layout.tsx`, reached from a new profile-tab "Organise" row. Inline rename, merge (pick target), delete with copy that says ratings are kept. |
| Plumbing | `OutboxRating` + `useOutbox.enqueue` carry `categoryId`/`seedSlug`; `RatingEntry.category` became required; `CACHE_SCHEMA_VERSION` 2 → 3 (clean wipe, no-users-yet policy); `lib/api.ts` short-circuits `204`; `add-product.tsx` echoes the plausibility `category` back as `suggestedCategory`. |
| Docs | `docs/architecture/frontend.md`, `CLAUDE.md` (including removing the now-false "P6-003 is not built" sentence from the P6-008 paragraph). |

## 3. Test results

Every row below is a command that was actually run in this worktree. `not_run` rows say so plainly.

| # | Command (cwd) | Exit | Observed |
|---|---|---|---|
| 1 | `npm run typecheck` (`server/`) | 0 | clean |
| 2 | `npm run lint` (`server/`) | 0 | clean (the script is `eslint "src/**/*.ts"`, so the `scripts/*.mjs` `no-undef` noise the implementer expected is out of scope and did not appear) |
| 3 | `npm test` (`server/`) | 0 | `Test Files 45 passed (45)` / `Tests 593 passed (593)` |
| 4 | `npx tsc --noEmit -p tsconfig.json` (`bread-sheet-app/`) | 0 | clean |
| 5 | `npx tsc --noEmit -p tsconfig.test.json` (`bread-sheet-app/`) | 0 | clean |
| 6 | `npm run lint` (`bread-sheet-app/`) | **1** | exactly one error: `scripts/test-maestro.js 1009:40 error 'Buffer' is not defined no-undef` — **pre-existing, see §3.1** |
| 7 | `npm test` (`bread-sheet-app/`) | 0 | `Test Suites: 48 passed, 48 total` / `Tests: 508 passed, 508 total` |
| 8 | `npm run test:e2e` (`bread-sheet-app/`) | **not_run** | the local Supabase stack cannot start on this machine — **see §3.2** |
| 9 | `npm run test:maestro` | **not_run / out of scope** | the diff touches no camera/scan code (`app/(tabs)/scan.tsx`, `features/products/barcode.ts`, `components/manual-barcode-sheet.tsx` and `e2e/maestro/` are all untouched by `fa890e2...HEAD`), so the guardrails' trigger condition is not met |
| 10 | `prisma migrate deploy` against a fresh DB | 0 | `All migrations have been successfully applied.` — **see §3.3** |
| 11 | `prisma migrate diff --from-schema=./prisma/schema.prisma --to-config-datasource --exit-code` | 0 | `No difference detected.` — `schema.prisma` and the migration history agree, no drift |
| 12 | live-Postgres behaviour script (psql) | — | all seven checks behaved as specified — **see §3.3** |

### 3.1 App lint is red on `main` too — pre-existing, not this ticket

Two independent proofs:

```
$ git diff fa890e2...HEAD --stat -- bread-sheet-app/scripts/ bread-sheet-app/eslint.config.js
(no output — neither the offending file nor the lint config is touched by this branch)
```

```
$ git worktree add <scratch>/main-base fa890e2 --detach && cd <scratch>/main-base/bread-sheet-app && npm run lint
.../scripts/test-maestro.js
  1009:40  error  'Buffer' is not defined  no-undef

✖ 1 problem (1 error, 0 warnings)

MAIN_APP_LINT_EXIT=1
```

Byte-identical failure and exit code on the base commit. Recorded as pre-existing; **not** a
blocker for this ticket. (The `lib/api.test.ts:100` warning the implementer mentioned does not
appear in either run — `expo lint` only lints `app/` and `components/`, so `lib/` is never visited
by this script. Nothing to carry forward.)

Worth a separate housekeeping ticket: `npm run lint` being red on `main` means the app lint signal
is permanently useless as a gate. Not filed here (out of this ticket's scope — guardrails §Scope).

### 3.2 Playwright E2E — could not be executed here (environment), evidence in full

The specs sign in with `supabase.auth.signInAnonymously()`, so they need a live GoTrue. Per
`CLAUDE.md` that means a local stack (`supabase start`). Chain of checks, all run directly rather
than inferred:

1. **CLI on `PATH`: absent.**
   ```
   $ command -v supabase        → "supabase not found"
   $ ls ~/.local/bin/supabase /usr/local/bin/supabase /opt/supabase
                                → all "No such file or directory"
   $ pacman -Qs supabase        → (no output)
   ```
2. **But the CLI *does* exist** — a previously cached npx install, at exactly the version CI pins
   (`supabase/setup-cli` with `version: 2.122.0`):
   ```
   $ /home/jano/.npm/_npx/b96a6bd565c470ce/node_modules/.bin/supabase --version
   2.122.0
   ```
   So "the Supabase CLI is unavailable" would have been a **false** finding. It is available.
3. **Container runtime is available and wired up.** `podman` 7 rootless, `DOCKER_HOST=unix:///run/user/1000/podman/podman.sock`,
   `systemctl --user is-active podman.socket` → `active`. `/usr/bin/docker` is the podman shim.
4. **Port clash with the leftover agent DB: none.** `bread-sheet-agent-p6-003-db-1` holds `5432`;
   `supabase/config.toml` uses `54321` (API), `54322` (db), `54329` (pooler). No overlap, no action
   needed.
5. **`supabase start` fails — and not because of Supabase.** Run from the worktree root with CI's
   own exclude list (`realtime,storage-api,imgproxy,mailpit,postgrest,postgres-meta,studio,edge-runtime,logflare,vector,supavisor`),
   three times, including once with `--debug`:
   ```
   Starting database...
   supabase_db_bread-sheet container logs:
   sh: can't fork: Resource temporarily unavailable   [×81]
   Stopping containers...
   {"code":"HealthCheckTimeoutError","message":"supabase_db_bread-sheet container is not running: exited"}
   exit 1
   ```
6. **Root-caused to the podman Docker-API socket, reproduced with Supabase out of the picture.**
   Same image, same trivial command, two different code paths into podman:
   ```
   $ podman run --rm public.ecr.aws/supabase/postgres:17.11.0.006 \
       sh -c 'for i in 1 2 3 4 5; do (true); done; echo FORK_OK_VIA_CLI'
   FORK_OK_VIA_CLI                                   ← podman CLI: fine

   $ docker run --rm public.ecr.aws/supabase/postgres:17.11.0.006 \
       sh -c 'for i in 1 2 3 4 5; do (true); done; echo FORK_OK_VIA_SOCKET'
   sh: can't fork: Resource temporarily unavailable   ← same image, via the API socket: cannot fork at all
   ```
   A socket-created container cannot even fork `cat /sys/fs/cgroup/pids.max` (zero output); the
   CLI-created one reports `pids.max 38292, pids.current 2`. Host limits are not the cause
   (`ulimit -u` 127640 inside and outside, `user-1000.slice` `pids.current` 1182 of 84242,
   `podman.service` `LimitNPROC=127640` / `TasksMax=38292`), and the failing container is created
   with `PidsLimit=0`, no `Ulimits` and `Memory=0` (verified by racing `podman inspect
   supabase_db_bread-sheet` during a start). `systemctl --user restart podman.socket` does not fix
   it. **Any** Docker-API-driven stack is therefore unstartable on this host right now; it is not
   specific to Supabase, to Playwright, or to this ticket. (Matches the known local pattern that
   podman breakage after a kernel upgrade clears on reboot — which a review run cannot do.)
7. **Installing a fresh CLI was not attempted around the sandbox.** `npx --yes supabase@latest
   --version` was denied by the permission system ("Code from External"); that denial was *not*
   worked around, and it is also moot given (2) and (6).

**Consequence and why this is a footnote under a PASS rather than a `BLOCKED`:**

- The gap is machine-wide and affects the whole suite, including the four specs that predate this
  ticket (`auth`, `home-search`, `scan-tab`, `add-custom-product`). It is exactly the "incidental
  suite" case the guardrails' environment clause exists for.
- No acceptance criterion rests on the Playwright run alone. Each behaviour the new spec asserts is
  *also* executed by a RNTL screen-level test in the green `npm test` run (§4 maps them one by one):
  chip row contents and counts, filtering, no-network-request, AND-composition with the query, and
  persistence across a remount through the real on-disk store.
- The one thing genuinely unverified is the **spec file itself** — 110 lines of Playwright the
  frontend agent wrote and never ran. That is a real guardrails concern ("new executables get run
  at least once"), and it is handled by making CI the gate: the PR's `e2e` job runs on
  `bread-sheet-app/**` changes, starts the same stack with the same CLI version, and will execute
  `category-chips.spec.ts` for the first time there. **The PR must not be merged until that job is
  green.** If it fails, the failure belongs to the frontend pillar.

### 3.3 Executed against a real Postgres — the DB-level ACs

The `UserCategory`/`Rating` guarantees in this ticket are enforced by the *database* (`onDelete:
SetNull`, `@@unique([userId, slug])`), and the server suite mocks Prisma — one test is even named
"ratings are not touched here — onDelete…". Inferring those ACs from the migration SQL would not
meet the bar, so they were executed: a scratch database (`p6003_review`) on the running
`bread-sheet-agent-p6-003-db-1` container, `prisma migrate deploy` from zero, then SQL.

| Check | Result |
|---|---|
| Full migration history applies to an empty DB | `All migrations have been successfully applied.` |
| Two different users may both hold slug `wine` | 2 rows — allowed |
| A second `(u1, 'wine')` row | `ERROR: duplicate key value violates unique constraint "UserCategory_userId_slug_key"` |
| Merge semantics (reassign then delete source) | `r1.categoryId` moved `c1` → `c3`; `c1` rows = 0 |
| **Delete a category → `onDelete: SetNull`** | `r1` still present, `score` 8, `categoryId IS NULL` = `t`; `count(Rating)` unchanged at 2 — **ratings survive, uncategorised** |
| Delete a user → categories cascade | 0 rows left for `u2` |
| `Product.suggestedCategory` column | holds `wine` as written |
| Cross-user custom-name query (seed promotion) | `SELECT slug, count(*) FROM "UserCategory" WHERE "isSeed"=false GROUP BY slug` returns rows — the learning-loop report is a plain query |

The script's own exit code is 3 because one step is a *deliberately* failing INSERT (the duplicate,
inside `BEGIN`/`ROLLBACK`). Scratch DB dropped afterwards.

### 3.4 New tests checked for frozen mocks

Per the guardrails' "a mock that freezes state the code under test mutates is not coverage", each
new test was read for what production bug it would actually fail on:

- `home-screen.test.tsx` "persists the selected chip across a restart" — uses the **real**
  `categoryFilterCache` over the real `lib/offline/store.ts`, backed by the existing
  `expo-file-system/legacy` mock's mutable `__files` Map. Tap → write → `unmount()` → fresh
  `render()` → the chip is still selected. Drop the `categoryFilterCache.write` call and this fails.
- `categoryController.test.ts` anonymous cases — the `requireRegistered` mock is a *real*
  implementation (`403` when `req.user.isAnonymous`), and the anonymous tests assert `200`/`201`.
  Adding `requireRegistered` to a category route would turn them red. This is a genuine test of the
  "`requireAuth`, not `requireRegistered`" AC, not a stub.
- `ratingController.test.ts` category cases — assert the actual Prisma payload
  (`expect(call.update).not.toHaveProperty('categoryId')` for the omitted case, `.toBeNull()` for
  the clear case), and the both-fields `400` runs the real validator (only
  `resolveRatingCategory` is mocked, and the test proves the request never reached
  `product.findFirst`).
- `outbox.test.ts` — enqueues through the real on-disk queue and reads it back; the collapse test
  proves the *latest* intent wins (`categoryId: null` replacing an earlier `seedSlug`), which a
  naive merge would get wrong.
- `product-screen-categories.test.tsx` — asserts exact outbound bodies for all five cases
  (pre-selected-with-no-tap, seed one-tap create, skip, explicit clear, offline seed → `enqueue`).
  The "no extra tap" test is the one that would catch a regression where the suggestion is shown but
  not applied.
- `category-picker-sheet.test.tsx` — "Did you mean…?" is asserted *and* "create anyway" is asserted
  to still call `onCreate`, i.e. the nudge is proven not to be a gate.

No frozen-mock pattern found.

## 4. Acceptance criteria — one at a time

| AC | Verdict | Evidence (all from executed runs) |
|---|---|---|
| Assign a category to a rating, change or remove it later | ✅ | `product-screen-categories.test.tsx`: select existing → `{categoryId:'c2'}`; remove → `{categoryId:null}`. Server: `ratingController.test.ts` "a valid categoryId is applied to both create and update" asserts the Prisma upsert payload. |
| A rating with no category is supported, filterable as "Uncategorised" | ✅ | `categoryId` nullable (migration applied, §3.3); `home-screen.test.tsx` "filters to Uncategorised"; "skipping sends no category field at all". |
| Picker pre-selects the suggestion, mapped to an existing category; else offers the seed as one-tap create | ✅ | `product-screen-categories.test.tsx` "pre-selects the chip when the suggestion maps to an existing own category", "sends the pre-selected existing category on submit with no extra tap", "offers an unmatched seed as a one-tap create". `picker.test.ts` covers `mapSuggestion` directly. |
| Picking a seed materialises exactly one `UserCategory`; nothing written before that | ✅ | `categoryService.test.ts` "materialises exactly one row for a seed slug, using the seed canonical name" + "find-or-create: returns the existing row unchanged when the slug already exists"; seeds live in a constant, not a table (static, stated here explicitly). Executed: `(userId, slug)` uniqueness enforced by the DB (§3.3). |
| `Product.suggestedCategory` filled from OFF tags **and** the plausibility response, never rendered as the product's category | ✅ | `productService.test.ts` "derives suggestedCategory from OFF categories_tags, first match wins" / "…null when categories_tags matches nothing known"; `imagePlausibilityService.test.ts` "returns a valid seed slug as category for product photos", "coerces a category outside the seed list to null"; `productController.test.ts` persists it on GTIN creation. Never-rendered: grepped — the only app-side consumer is `mapSuggestion` in `product/[id].tsx`; no JSX reads it. |
| Categories never peer-reviewed; absent from the P5-005/P5-006 edit flow and diff screen | ✅ | `PRODUCT_EDIT_FIELDS`/`PACKAGED_EDIT_FIELDS`/`CUSTOM_EDITABLE_FIELDS` unchanged on this branch and contain no category field; `ProductCorrectionInput` explicitly `Omit`s `suggestedCategory` (typechecks, row 4/5); `productSubmissionValidator.test.ts` covers the correction path; `features/products/edit-form.ts` untouched by the diff. |
| Create a custom category from the picker (1–24 chars, max 40 per user) | ✅ | `validation.test.ts` (raw-length cap, before trim); `category-picker-sheet.test.tsx` "creates a brand-new category with no near match" / "rejects an empty name without calling onCreate"; `categoryService.test.ts` "throws TooManyCategoriesError at the 40-category cap"; `categoryController.test.ts` "returns 409 too_many_categories at the cap". |
| Near-match offers "Did you mean …?" first but still allows creating | ✅ | `match.test.ts` + `category-picker-sheet.test.tsx` "offers 'Did you mean…?' … and 'create anyway' still creates" (asserts `onCreate` *not* called before, and called after). |
| Renaming updates it everywhere, no per-rating writes | ✅ | `categoryService.renameCategory` touches one row; `categoryService.test.ts` "renames and re-slugifies a category the user owns" + the 409-collision case; `manage-categories.test.tsx` "renames a category". Structural (the label lives in one row, FK-joined) — no rating rows exist to write. |
| Merging reassigns the ratings and deletes the source | ✅ | `categoryService.test.ts` "reassigns ratings from source to target, then deletes the source, in one transaction"; `manage-categories.test.tsx` merge test; **and executed against Postgres** (§3.3). |
| Deleting leaves ratings intact and uncategorised, with confirmation copy that says so | ✅ | **Executed against Postgres** — rating survived with `categoryId IS NULL`, `count(Rating)` unchanged (§3.3). Copy: `manage-categories.test.tsx` asserts the alert body matches `/keep their rating but become uncategorised/i`. |
| One user cannot read, assign or modify another user's categories (`403`) | ✅ | `categoryController.test.ts` 403 cases on `PATCH`, `DELETE` ("never deleting") and merge-target; `ratingController.test.ts` "returns 403 when categoryId belongs to another user"; `categoryService.test.ts` ownership checks. Reads are scoped by `where: { userId }` so another user's rows are structurally unreachable. |
| Home chip only for categories the user has ratings in, each with a count, plus Uncategorised when applicable | ✅ | `home-screen.test.tsx` "shows one chip per category with a count, plus Uncategorised, plus All", "does not show an Uncategorised chip when every rating has a category", "shows no chip row when there are no ratings at all"; `filter.test.ts` for `buildCategoryChips`. |
| Chip filtering issues no network request, works offline; selection survives a restart | ✅ (locally; browser-level still pending CI) | `home-screen.test.tsx` "filters the list to the selected category, with no network request" (asserts zero `api.get` calls other than `/api/users/me/ratings`) and "persists the selected chip across a restart" (real disk round-trip through `categoryFilterCache`, §3.4). Offline by construction: chips are derived from the already-cached list and no category request is involved. |
| `GET /api/users/me/ratings` includes each entry's category | ✅ | `userController.test.ts` "includes each entry's category as `{ id, name } \| null`", which also asserts the Prisma `include`. |
| Rating + categorising in one request (`categoryId` or `seedSlug`) | ✅ | `ratingController.test.ts` "seedSlug find-or-creates the seed and assigns it in the same request", "a valid categoryId is applied to both create and update", "returns 400 when both categoryId and seedSlug are provided". |
| Anonymous users can create and use categories (`requireAuth`, not `requireRegistered`) | ✅ | `categoryController.test.ts` "works for an anonymous caller (requireAuth only, not requireRegistered)" on `GET` and `POST`, against a `requireRegistered` mock that really rejects anonymous sessions (§3.4). Routes carry no `requireRegistered` (`userRoutes.ts`). |
| Custom category names queryable across users for seed promotion | ✅ | **Executed** — plain `GROUP BY slug WHERE "isSeed" = false` over `UserCategory` (§3.3). No per-user partitioning stands in the way. Documented in `backend.md`. |

### TICKET-P6-008 box closed by this ticket

> `- [ ] It composes with the category chips. *(Deferred to P6-003; see the note there.)*`

Ticked. The deferred-AC comment in `app/(tabs)/home-search-mine.test.tsx` was replaced by a real
screen-level test, "composes the category chip with the search query (AND)": presses
`category-chip-cat-wine` (Negroni disappears, both wines remain), then types `pinot` (Chardonnay
disappears, Pinot Noir remains). It exercises the production path
`filterRatingsByQuery(ratings, query, categoryPredicateFor(filter))`, and it executed green in run
#7. `features/search/match.test.ts`'s pure-composition test was kept and its stale comment updated.

## 5. Mandatory post-implementation steps (CLAUDE.md)

| Step | Status |
|---|---|
| Tests added/updated, suites green | ✅ rows 3 and 7 |
| `CLAUDE.md` | ✅ new "Categories — frontend" and "Categories — backend" paragraphs, data-model entry for `UserCategory`/`Rating.categoryId`/`Product.suggestedCategory`, plausibility-gate paragraph amended, and the false "TICKET-P6-003 … is **not built**" sentence in the P6-008 paragraph corrected |
| `docs/architecture/backend.md` | ✅ +79 |
| `docs/architecture/frontend.md` | ✅ +119 |
| `docs/architecture/data.md` | ✅ +23 (category labels as user content) |
| `docs/bruno/` | ✅ five new `Users/` requests (list/create/rename/delete/merge) + `Ratings/create-or-update-rating.bru`, `Users/get-my-ratings.bru`, `Products/{lookup-by-gtin,submit-product,upload-image,get-product-by-id}.bru` updated for the new fields |
| New ADR | not needed — ADR 0006 already fixed the "a category is a label the user owns, not a fact about the product" stance and the ticket text carries the decision record; nothing architecturally new was decided here |
| `README.md` | not needed — no setup/run step changed |

## 6. Follow-ups recorded (not implemented — guardrails §Scope)

1. **TICKET-P6-015 — backfill `Product.suggestedCategory` for already-cached OFF products.** Added
   to `FEATURES.md` by the backend agent, correctly blocked on TICKET-P6-001 (whose
   `backfill-off-metadata.ts` is the intended host, since it already re-fetches OFF for allergens).
   Reviewed: the gap is real — `suggestCategoryFromOffTags` runs only where
   `GET /products/gtin/:gtin` *creates* a row from OFF, so a product already in the local DB never
   gets one. Scope and ACs read correctly. No action for this ticket.
2. **The P6-002 `autoShareCategories` amendment has nothing to attach to.** The ticket asks for an
   amendment saying `GroupMember.autoShareCategories` references the member's *own* `UserCategory`
   ids. TICKET-P6-002 is unbuilt and its `FEATURES.md` text already states exactly that
   ("*own* `UserCategory` ids (P6-003) — the policy is a statement about the sharer's labels"), so
   there is no code or doc to change. Confirmed by inspection of `FEATURES.md`; recorded here as
   the amendment's resting place. No `FEATURES.md` edit was needed and none was made.
3. **Stale JSDoc in `features/search/match.ts` (frontend pillar, cosmetic).**
   `filterRatingsByQuery`'s doc comment still reads *"chips don't exist yet, so this parameter is
   unused by any caller today … **Deferred, not built.**"* — both clauses are now false; the Home
   tab passes `categoryPredicateFor(...)` into it. CLAUDE.md's post-implementation step 2 covers
   "inline code comments or JSDoc on public interfaces that are now outdated". Not fixed here (the
   reviewer may not edit app source) and deliberately not treated as a blocker: it misleads a
   reader, it does not mislead the program. **Resolved in the PR** — the comment now describes the
   chip ∧ query composition via `categoryPredicateFor`.
4. **Minor, no AC implication:** in `createRating`, `resolveRatingCategory` runs *before* the
   product visibility lookup, so a `POST /api/ratings` with a valid `seedSlug` and a nonexistent
   `productId` materialises the seed `UserCategory` and then 404s. Harmless (the user did pick that
   seed, and the row is free to reuse or delete) and arguably desirable for the offline replay path,
   but it means "nothing is written per user until they pick one" is satisfied by intent rather than
   by request outcome. Noted, not filed.

## 7. Open questions

None that block. One decision for the human merging:

- **The `e2e` CI job is the gate.** `category-chips.spec.ts` has never executed anywhere. Treat a
  red `App E2E tests (Playwright, Expo web)` job as a frontend-pillar fix, not an infrastructure
  flake, and do not merge until it is green. If it is red for a *harness* reason (selectors needing
  `data-testid` adjustments under Expo web, or the reload test's session rehydration), that is still
  a frontend fix — the spec is the frontend agent's deliverable.
- Host housekeeping, unrelated to this branch: the podman Docker-API socket cannot start forking
  containers (§3.2), which disables `supabase start`, `docker compose` and therefore the whole local
  E2E/infra path for *any* ticket until the host is rebooted. The leftover
  `bread-sheet-agent-p6-003-db-1` container (port 5432, started by the backend agent) is still
  running and was reused for §3.3; it did not clash with anything and was left as found.
