# P6-007 Review Findings — Custom Products: Rate Things With No Barcode

**Verdict: BLOCKED** (one frontend defect; everything else passes)

**Date:** 2026-11-09
**Branch:** `agent/P6-007` (base `main` @ `0d013d9`)
**Ticket:** [TICKET-P6-007] Custom Products — Rate Things With No Barcode
**Implementer commits:** `9bb88ab` (frontend, `bread-sheet-app/`), `6ac5274` (backend, `server/`)
**Reviewer:** independent QA gate — read-only on `bread-sheet-app/` and `server/`

One acceptance criterion is demonstrably violated at runtime on a reachable path (the soft
duplicate gate, §Finding F1). It is a small, well-localised frontend fix. Nothing else in the
ticket is blocked: the whole backend contract was executed against a live Postgres with real
GoTrue tokens and passes, and both new Playwright specs pass.

Because the run is `BLOCKED`, **no `FEATURES.md` boxes were ticked** — including the P6-008
Slice A box ("A barcode-less item created in P6-007 is findable by name"), which was *verified*
(§Verified at runtime, item 14) and should be ticked together with P6-007's own boxes once F1 is
fixed. No PR was opened.

---

## Current State

`main` @ `0d013d9` has the ADR 0006 slim-`Product` split (P6-009) and P6-008 Slice B's
`GET /api/products/search`. `Product.kind` already carried a `CUSTOM` member with no rows of
that kind and no way to create one: every product needed a `PackagedProduct` with a GTIN.

The branch adds:

**Backend (`6ac5274`)**
- Migration `20261108204955_custom_products`: `Product.nameKey TEXT`, plus the hand-written
  partial unique index `custom_product_name_unique ON "Product"("nameKey") WHERE kind = 'CUSTOM'
  AND status <> 'REJECTED'`.
- `services/nameNormalization.ts` — the single `normalizeProductName` helper (NFKD, strip
  combining marks, lowercase, collapse whitespace, trim).
- `services/customProductService.ts` — `createCustomProduct` (P2002 → `DuplicateCustomProductNameError`
  carrying the winning row's id) and `findCustomProductNameCollision`, shared with the rename paths.
- `validators/customProductValidator.ts` — strict **allowlist** bodies (`{name, imageKey}` for
  create, `{name, productImageKey}` for a PATCH correction); anything else → 400
  `PackagedFieldNotAllowedError`. Name capped at 80 chars on the **raw** string.
- `routes/customProductRoutes.ts` + `controllers/customProductController.ts` —
  `POST /api/custom-products`, `requireAuth` → `apiLimiter` → `requireRegistered`.
- `productEditService.ts` — `correctCustomProduct` (CUSTOM PATCH path), `CUSTOM_EDITABLE_FIELDS
  = ['name','image']` enforced in `createEdit`, rename-collision checks at proposal time and
  again at apply time (apply-time collision → edit `REJECTED` + `logger.warn`, per the ticket).
- `kind=item` threaded through `imageService.ImageKind`, the plausibility prompt, the mock
  verdict, and the resizer Lambda's key regex + size table.

**Frontend (`9bb88ab`)**
- `components/add-choice-sheet.tsx` — the Home "＋" now asks barcode vs. no-barcode.
- `app/(app)/add-custom-product.tsx` — search → optional "Did you mean…?" → short create form;
  registered in `(app)/_layout.tsx`.
- `features/products/custom.ts` — name validation, `canOfferCreate`, `findLikelyDuplicate`
  (threshold 0.6), `isDuplicateNameConflict`.
- `features/products/api.ts` / `types.ts` — `createCustomProduct`, `kind: 'item'` upload,
  `ProductCorrectionPayload` union.
- `features/products/edit-form.ts` — optional `kind` threaded through five helpers, defaulted
  to `PACKAGED` so existing call sites are unchanged.
- `product/[id].tsx` — `focusRating` hand-off (latched into state, param cleared once);
  `edit-product/[id].tsx` and `review-product/[id].tsx` hide every packaged-only field for a
  `CUSTOM` product.
- `e2e/add-custom-product.spec.ts` — two Playwright specs.

Docs: `CLAUDE.md`, `docs/architecture/frontend.md`, `docs/architecture/backend.md`,
`ADR 0006`, and `docs/bruno/Products/create-custom-product.bru` (+ three touched `.bru` files)
were all updated. `CLAUDE.md`'s "Mandatory Post-Implementation Steps" are satisfied.

---

## Findings

### F1 — BLOCKER (frontend): the ≥ 0.6 "Did you mean…?" gate can be walked past, because "Create" is offered before any search has run

**Acceptance criterion violated:** *"A query whose top match has similarity ≥ 0.6 requires a
'Did you mean …?' confirmation before creating."*
**Ticket text violated:** *"A **"Create '<query>'"** action appears only once the query is at
least 2 trimmed characters **and the results have loaded**."*
**Docs that overstate the behaviour:** `CLAUDE.md` ("appears only once the query is ≥ 2 trimmed
characters **and the search has settled**") and `docs/architecture/frontend.md:485`.

`add-custom-product.tsx:87`:

```ts
const canOfferCreateAction = canOfferCreate(query) && !searchLoading;
```

There is no "has loaded / has settled" state anywhere in the screen or in
`hooks/use-product-search.ts`. `isLoading` is only set inside `fetchPage`, which runs **after**
the hook's 300 ms debounce timer fires. So from the keystroke that makes the query searchable
(and again after every subsequent keystroke) the button is rendered for ~300 ms while `results`
is still `[]` (or the previous query's list). `handleCreatePress` then reads that stale
`results` through `findLikelyDuplicate(...)`, gets `null`, and goes straight to the create form.

**Executed proof** (reviewer probe, Playwright against Expo web, registered session, a mocked
`GET /api/products/search` returning one result with `similarity: 0.95`):

```
[probe] CONTROL ok: soft gate fires when results are loaded          <- control passes
[probe] create visible immediately (searchCalls=0): true
[probe] RACE -> create form: true; duplicate confirm: false
2 passed (6.4s)
```

`searchCalls=0` is the important part: the button is tappable before the search request has even
been *issued*, so this is not a narrow race — it is the state of the screen for the first 300 ms
after every keystroke. A user who types or pastes a name and taps the button that is already on
screen gets no confirmation at all.

Why this matters beyond the letter of the AC: the soft gate is the ticket's *only* defence
against near-duplicates ("Negroni" vs "Classic Negroni"). The server's hard gate only catches
exact normalised collisions, and *"Merging duplicates is out of scope"* — so a bypassed soft
gate creates permanent, unmergeable duplicate rows.

**Suggested fix (frontend, not applied by the reviewer):** give `useProductSearch` a
`hasSettled`-style flag (true once a non-aborted request for the *current* query has
resolved/failed) and gate `canOfferCreateAction` on it, instead of on `!searchLoading`. Also
consider making `handleCreatePress` a no-op-with-spinner while the current query has not
settled, so the button cannot be tapped against a stale `results` array. The existing unit test
"offers *Create '<query>'* once the query is searchable **and results have loaded**"
(`add-custom-product.test.tsx:115`) advances the fake timers before asserting, so it cannot
fail on this — it needs a case that asserts the button is *absent* between the keystroke and
the 300 ms tick.

### F2 — Pre-existing, not this ticket: `bread-sheet-app` `npm run lint` fails on `main`

The frontend implementer's claim is **verified**. `bread-sheet-app/scripts/test-maestro.js` is
byte-identical to `main` on this branch (`git diff --quiet main...HEAD -- …` → identical), and
no lint config or `package.json` change is in the diff. Running the same command in a clean
`main` checkout reproduces it exactly:

```
$ cd /home/jano/IdeaProjects/bread-sheet/bread-sheet-app && npm run lint
/home/jano/IdeaProjects/bread-sheet/bread-sheet-app/scripts/test-maestro.js
  1009:40  error  'Buffer' is not defined  no-undef
✖ 1 problem (1 error, 0 warnings)
exit 1
```

`grep -rn "run lint\|eslint" .github/workflows/` returns nothing — **app lint is not run in CI
at all**, which is how `main` came to be red. The `expo lint` half (over `app/` and
`components/`) is clean, so none of this ticket's new files contribute an error. Follow-up
ticket suggested below; not a reason to block P6-007.

### F3 — Minor (backend): stale migration directory name in a schema comment

`server/prisma/schema.prisma:98` points at `20261108180000_custom_products`; the migration that
actually exists is `20261108204955_custom_products`. Cosmetic, but it is the comment that tells
the next reader where the hand-written partial index lives.

### F4 — Not a defect: allergen fields do not exist yet (P6-001 unbuilt) — the AC still holds

Confirmed: there is no `allergens` column anywhere in `schema.prisma` and no allergen member in
`PACKAGED_EDIT_FIELDS`. The AC *"nutrition or allergen fields in a create, correction or edit
payload for a `CUSTOM` product return `400`"* is nevertheless satisfied **and future-proof**,
because the CUSTOM paths are strict allowlists rather than denylists: an unknown key is rejected
on its mere presence. Executed with a literal `allergens` key on all three paths:

```
PASS  create with "allergens" -> 400 :: {"message":"allergens is not editable on a custom product"}
PASS  PATCH with an allergen field on a CUSTOM product -> 400 :: {"message":"allergens is not editable on a custom product"}
PASS  edit proposal with a nutrition field on a CUSTOM product -> 400 :: {"message":"sugars is not editable on a custom product"}
```

When P6-001 lands, no change is needed here for CUSTOM products.

### F5 — Honest gap, not blocking: the `kind=item` plausibility *prompt* was never executed against Gemini

What **was** executed: `kind=item` is accepted by `POST /api/products/upload-image` (an
anonymous caller still gets `403`; a registered one gets past kind validation and fails only on
the absent LocalStack S3), `checkImage(..., 'item')` is called with the item kind, the abuse
verdict still 422s without leaking the reason, and the `item` key prefix/size entry exists in
the resizer Lambda.

What was **not** executed: the ticket's prose *"accepts a cocktail in a glass"* / *"still flags
abuse"* for the new prompt. `PLAUSIBILITY_MODE=mock` accepts everything by construction, and
`gemini` mode is a paid live call against a real model with a daily cap. The verdict quality of
the new prompt is therefore **unverified**. This is recorded rather than glossed: note that
**no acceptance criterion asserts it** (the ACs cover creation, lifecycle, editing, duplicates
and rendering), so it does not change the verdict. It wants a manual spot-check against
`PLAUSIBILITY_MODE=gemini` before this reaches real users.

### F6 — Note: the two mocked backend "race" tests do not prove what their names claim

`customProductService.test.ts:112` ("two concurrent creates … produce exactly one created row
and one duplicate_name error") hand-stages the `P2002` in `mockProductCreate`, and
`:145` ("a REJECTED custom product does not block its name") simply makes `create` resolve.
Both are valid tests of the *error-mapping* code and neither is a frozen-state mock, but neither
exercises the partial unique index — the whole server suite mocks `../db.js`. That is why the
reviewer ran both criteria against live Postgres instead (§Verified at runtime, items 1–5). No
change requested; the gap is noted so nobody mistakes the unit test for the proof.

### F7 — Contract consistency (asked explicitly): `imageKey` vs `productImageKey` agree end to end

Checked on both sides and executed:

| Path | Client sends | Server accepts | Maps to |
|---|---|---|---|
| `POST /api/custom-products` | `imageKey` (`CreateCustomProductPayload`) | `CREATE_KEYS = {name, imageKey}` | `Product.image` |
| `PATCH /api/products/:id` (CUSTOM) | `productImageKey` (`ProductCorrectionPayload`) | `CORRECTION_KEYS = {name, productImageKey}` | `Product.image` |
| `POST /api/products/:id/edits` | `productImageKey` (`buildEditChanges`) | `productEditValidator` KNOWN set | `changes.image`, allowed by `CUSTOM_EDITABLE_FIELDS` |

The create body is the only one using the bare `imageKey` — which is exactly the wire shape the
ticket's endpoint table specifies, so this is intentional asymmetry, not a mismatch. No client
or server disagreement found.

### F8 — `focusRating` param clearing (asked explicitly): the test mock is **not** frozen

`product-screen.test.tsx` was checked specifically for the "mock that freezes mutated state"
failure mode. It does not have it: `mockRouter.setParams` is implemented to mutate the same
object `mockUseLocalSearchParams` returns, and the test then asserts `params.focusRating` is
`undefined` and that a re-render does not call `setParams` a second time. A mock that merely
recorded the call would leave the param at `'1'` and the re-render assertion would fail. The
production bug it would catch is real (an un-cleared param re-focusing the comment field on
every later visit).

---

## Verified at runtime

The server suite mocks `../db.js`, so every criterion about the database or the HTTP contract
was re-executed for real. Setup used: the branch's migration applied to a live Postgres 18
container (`bread-sheet-p6-007-db-1`), the branch's own Express app on `:3000`
(`VISION_MODE=mock PLAUSIBILITY_MODE=mock`, all config passed inline — no `.env` was read; the
runner reported `injected env (0) from .env`), and **real Bearer tokens** from a live GoTrue
v2.197.0 (see §Environment notes). Nothing in this section is mocked below the HTTP boundary.

Live-index checks (`tsx`, real Prisma client, real partial index):

| # | Criterion | Result |
|---|---|---|
| 1 | 5 genuinely concurrent creates of `Negroni` / `negroni` / `Négroni ` / `NEGRONI` / `  negroni  ` → **exactly one row** | PASS — `rows=1`, `nameKey=negroni` |
| 2 | …one fulfilled, four `duplicate_name`, no other error | PASS — `fulfilled=1 duplicate_name=4 other=0` |
| 3 | every conflict carries the **winning** `productId` | PASS |
| 4 | created row is `PENDING_REVIEW`, `kind CUSTOM`, no `PackagedProduct` row | PASS |
| 5 | a `REJECTED` row does **not** block the name | PASS — new row created |
| 6 | rename collision → `duplicate_name` + the holder's id | PASS |
| 7 | a legal rename recomputes `nameKey` and resets the submitter | PASS — `negroni sbagliato rosso` |
| 8 | two `PACKAGED` rows with `NULL nameKey` coexist under the index | PASS |

HTTP checks (real auth, live DB):

| # | Criterion | Result |
|---|---|---|
| 9 | anonymous `POST /api/custom-products` → `403 Registration required` | PASS |
| 10 | registered create → `201 {id, status:'PENDING_REVIEW'}` | PASS |
| 11 | **anonymous** `GET /api/products/:id` → `200`, `unverified:true`, `packaged:null`, `kind:'CUSTOM'`, and `submittedByUserId` omitted; `nameKey` never serialised | PASS |
| 12 | anonymous user can rate it straight away → `201` | PASS |
| 13 | normalised duplicate → `409 {code:'duplicate_name', productId}` | PASS |
| 14 | the rated barcode-less item appears in `GET /api/users/me/ratings` with `product.name` (brand `null`) — i.e. findable by `filterRatingsByQuery` ⇒ the **P6-008 Slice A** box | PASS |
| 15 | `gtin` / `energyKcal` / `ingredients` / `allergens` / `brand` in a create body → `400` each | PASS (5/5) |
| 16 | 81+ **raw** chars (mostly padding) → `400` | PASS |
| 17 | `PATCH` rename of a `PENDING_REVIEW` custom product → `200` | PASS |
| 18 | `PATCH` with a nutrition or allergen field → `400` | PASS |
| 19 | `PATCH` by an anonymous caller → `403` | PASS |
| 20 | `PATCH` rename onto an existing name → `409 duplicate_name` + id | PASS |
| 21 | self-vote on own submission → `403 self_verification` | PASS |
| 22 | two net approvals → `VERIFIED`, `unverified:false` | PASS |
| 23 | two net rejections (`DELETE /verify`) → `404` for everyone, author included | PASS |
| 24 | the rejected name is reusable over HTTP → `201` | PASS |
| 25 | edit proposal on a `VERIFIED` custom product → `201 PENDING` | PASS |
| 26 | edit proposal carrying a nutrition field → `400` | PASS |
| 27 | edit proposal renaming onto an existing name → `409 duplicate_name` + id | PASS |
| 28 | two approvals apply the edit (name updated on the same `Product.id`) | PASS |
| 29 | `GET /api/products/search` finds the barcode-less custom product by name, `kind:'CUSTOM'`, `similarity:1` | PASS |
| 30 | `upload-image` with `kind=item` passes kind validation (not `invalid_kind`) | PASS |
| 31 | `upload-image` `kind=item` by an anonymous caller → `403` | PASS |

UI, executed in a browser (Playwright, Expo web):

| # | Criterion | Result |
|---|---|---|
| 32 | the "＋" offers barcode vs. no-barcode, and the custom screen opens | PASS (repo spec) |
| 33 | a guest can search; only the create action shows the sign-up gate, which routes to signup | PASS (repo spec) |
| 34 | with results loaded, a ≥ 0.6 match forces the "Did you mean…?" confirmation | PASS (reviewer probe, control) |
| 35 | the same gate is bypassed when Create is tapped inside the debounce | **FAIL → F1** |

---

## Test results

| Command | Directory | Exit | Observed |
|---|---|---|---|
| `npm run typecheck` | `server/` | **0** | clean |
| `npm test` (vitest) | `server/` | **0** | `Test Files 39 passed (39)` / `Tests 489 passed (489)` |
| `npm run lint` | `server/` | **0** | clean |
| `npm run build` | `server/` | **0** | clean |
| `npm run typecheck` | `bread-sheet-app/` | **0** | clean (both `tsconfig.json` and `tsconfig.test.json`) |
| `npm test` (jest) | `bread-sheet-app/` | **0** | `Test Suites: 38 passed` / `Tests: 402 passed` |
| `npm run lint` | `bread-sheet-app/` | **1** | 1 error, `scripts/test-maestro.js:1009 'Buffer' is not defined`. **Pre-existing**: identical failure in a clean `main` checkout (exit 1); file untouched by the diff; not run in CI. See F2 |
| `npm run test:e2e` | `bread-sheet-app/` | **1** | `5 passed, 2 failed`. **Both new P6-007 specs passed.** Failures: `e2e/auth.spec.ts` and `e2e/scan-tab.spec.ts` — reproduced **identically on `main`** with the same env and the same substitute auth stack (serially too, so not a parallelism artefact). Neither spec nor its code path is touched by this diff |
| live partial-index script (`tsx`, real Postgres) | `server/` | **0** | 9/9 PASS — items 1–8 above plus "a brand-new `PENDING_REVIEW` custom product is ratable" |
| HTTP contract script, part 1 (real GoTrue tokens, live DB) | — | **1 → 0** | 31 checks; 28 PASS. 3 failed on *harness* bugs, not server behaviour: the harness skipped `POST /api/users/sync` (so every `User` FK failed), used `POST` instead of `DELETE /verify` for reject votes, and proposed a second edit while one was still `PENDING` (`409 edit_pending`, the correct response). Fixed and re-run |
| HTTP contract script, part 2 (the 3 corrected checks) | — | **0** | 3/3 PASS — two net rejections hide the product, the rejected name is reusable, an edit renaming onto an existing name is `409 duplicate_name` |
| reviewer soft-gate probe (Playwright, scratch config) | — | **0** | `2 passed` — control + the F1 bypass, both as asserted |
| `npm run test:maestro` | `bread-sheet-app/` | **not run** | **Not applicable.** The diff touches no camera/scan code: no `app/(tabs)/scan.tsx`, no `components/manual-barcode-sheet.tsx`, no `features/products/barcode.ts`, no OCR, nothing under `e2e/maestro/`. `grep -rn "home-add-product\|add-choice" e2e/maestro/` → no match; `e2e/maestro/manual-entry.yaml` enters via the **Scan tab's** `scan-manual-entry`, which is unchanged, so the new choice sheet on the Home "＋" cannot break it |

---

## Environment notes (how the e2e gap was closed, and what remains)

The frontend implementer reported being unable to run Playwright because no `supabase` CLI was
on `PATH`. **Absence confirmed, but the conclusion was wrong** — the suite *is* runnable here,
and the reviewer ran it:

```
$ which supabase            -> supabase not found
$ ls node_modules/.bin/supabase (repo root and bread-sheet-app)  -> No such file or directory
$ for p in /usr/bin /usr/local/bin ~/.local/bin ~/bin /opt/supabase; ...  -> absent (all)
$ npx --no-install supabase --version  -> "missing packages" (would need supabase@3.0.0)
$ which podman docker       -> /usr/bin/podman  /usr/bin/docker   (podman 6.1.4)
```

Installing `supabase@2.122.0` (CI's pinned version) into a scratch directory worked, but
`supabase start` cannot run on this host for an unrelated reason:

```
$ podman logs supabase_db_bread-sheet
sh: can't fork: Resource temporarily unavailable [x40]
```

Diagnosed, not guessed: `~/.config/containers/containers.conf` sets `pids_limit = 0` (meaning
"unlimited" to the podman CLI), but containers created through podman's **Docker-compat API** —
which is what the Supabase CLI uses — get a literal pids cgroup limit of `0` and cannot fork.
Confirmed by bisection: `podman run -d …` → `pids.max=38292`, forks fine; `docker run -d …` →
cannot fork; `docker run -d --pids-limit 4096 …` → `pids.max=4096`, forks fine. Overriding
`CONTAINERS_CONF` for a privately started `podman system service` did not help (the compat API
takes the request's `PidsLimit` literally). Fixing it means changing the user's container
config, which is outside the reviewer's write scope.

So the reviewer stood up an equivalent auth stack with the podman **CLI** only: GoTrue
`v2.197.0` (the version the pinned CLI embeds) against the existing Postgres container plus a
~25-line `/auth/v1/*` → GoTrue gateway standing in for Kong, and ran the suite against it with
`EXPO_PUBLIC_*` exported inline. That is how all 7 specs executed. The two failures are
pre-existing under this substitute (identically on `main`) and are most likely an artefact of
the substitute rather than of the app; they are **not** attributable to P6-007.

Residual risk to be explicit about: the e2e result above comes from a *hand-built* auth stack,
not from `supabase start`. The two P6-007 specs passed, but the suite has not been seen green as
a whole on this machine. CI (`.github/workflows/test.yml`'s `e2e` job) runs the real stack and
will be the final word.

---

## Follow-ups to file as `FEATURES.md` tickets (not fixed here)

1. **`bread-sheet-app` lint is red on `main` and unguarded by CI.** Add `scripts/` to the lint
   environment (or an `eslint.config.js` `globals.node` entry for `scripts/**`) to clear the
   `Buffer` `no-undef`, and add an app-lint step to `.github/workflows/test.yml` so it cannot
   rot again. (F2)
2. **Spot-check the `kind=item` plausibility prompt against `PLAUSIBILITY_MODE=gemini`** — a
   cocktail in a glass must get `ok`, obvious abuse must still get `abuse` with no reason leaked.
   Mock mode cannot cover this. (F5)
3. **Fix the stale migration name in the `Product.nameKey` schema comment.** (F3)
4. **Make the app's own e2e specs runnable without a backend** (or document that `test:e2e`
   needs one): `e2e/auth.spec.ts` and `e2e/scan-tab.spec.ts` are the only two specs that do not
   mock `GET /api/users/me/ratings`, and they are the two that fail locally.

---

## Open questions for the implementer / human

1. **F1 — what should "the results have loaded" mean exactly?** Two sub-questions the fix has to
   answer, and no test can decide them: (a) while the current query has not settled, should the
   Create button be **hidden** (it then flickers in and out on every keystroke) or **shown but
   disabled//spinner** (steadier, but the user can tap a dead control)? (b) should a *failed or
   offline* search count as settled — i.e. may a user create while search is unavailable, with no
   soft gate at all, relying only on the server's exact-name 409? The reviewer deliberately did
   not choose; both are product decisions.
2. **F5 — is a live-Gemini spot-check of the `item` prompt required before merge, or is it
   acceptable as a post-merge manual check?** It costs a real model call against the daily cap.
3. The apply-time rename-collision path (`castEditVote` → edit auto-`REJECTED` + `logger.warn`)
   is unit-tested but was **not** reproduced live — it needs two voters plus a third party
   taking the name between proposal and the resolving vote. The ticket calls that case "rare and
   acceptable"; flagged only so the record is accurate about what was executed.
