# P6-007 Review Findings — Custom Products: Rate Things With No Barcode

**Verdict: PASS after fix cycle 1.** 14 of the ticket's 15 acceptance criteria are executed and
ticked, plus P6-008's Slice A box. **One criterion is deliberately left unticked** — the
live-Gemini half of the `kind=item` plausibility gate (§F5) — because it cannot be executed
without real Gemini credentials and a paid model call. It is flagged in the PR body for a human
spot-check rather than ticked on faith.

**Date:** 2026-11-09 (round 1), re-reviewed the same day after fix cycle 1
**Branch:** `agent/P6-007` (base `main` @ `0d013d9`)
**Ticket:** [TICKET-P6-007] Custom Products — Rate Things With No Barcode
**Implementer commits:** `9bb88ab` (frontend), `6ac5274` (backend), `bb1f71e` (frontend fix for F1)
**Reviewer:** independent QA gate — read-only on `bread-sheet-app/` and `server/`

Round 1 was `BLOCKED` on one frontend defect: the ≥ 0.6 "Did you mean…?" soft duplicate gate
could be walked past, because "Create" was offered before any search for the current query had
run (§F1). `bb1f71e` fixes it. The fix is verified in a browser, the new tests are verified to
actually fail against the pre-fix source, and the shared `useProductSearch` hook shows no
P6-008 regression. See §Fix cycle 1 re-review.

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

### F1 — ~~BLOCKER~~ **RESOLVED in `bb1f71e`** (frontend): the ≥ 0.6 "Did you mean…?" gate could be walked past, because "Create" was offered before any search had run

> **Status: fixed and verified.** Evidence and the resolution of this finding's two open
> questions are in §Fix cycle 1 re-review. The round-1 analysis is kept verbatim below as the
> record of what was wrong.

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

What was **not** executed: the ticket's *"accepts a plausible non-packaged subject (a cocktail
in a glass)"*. `PLAUSIBILITY_MODE=mock` accepts everything by construction, and `gemini` mode is
a paid live call against a real model, needing credentials the reviewer is not permitted to
obtain. The verdict quality of the new prompt is therefore **unverified**.

> **Correction to round 1.** This finding originally claimed "no acceptance criterion asserts
> it". That was **wrong** — `FEATURES.md` has an explicit AC: *"The image plausibility gate runs
> on custom-product photos via `kind=item`, accepts a plausible non-packaged subject (a cocktail
> in a glass), and still flags abusive uploads with a `UserAbuseFlag`."* The round-1 pass over
> the AC list stopped short of the last four criteria. Recording the mistake rather than quietly
> correcting it, since the whole point of this doc is what was actually checked.

Consequence, applied: **that AC's box is left unticked.** Its three clauses stand as follows.
*"Runs via `kind=item`"* — executed (`checkImage(buffer, mime, 'item')` is called with the item
kind; a live `POST /api/products/upload-image` with `kind=item` passes kind validation and an
anonymous caller still gets `403`). *"Still flags abusive uploads with a `UserAbuseFlag`"* — the
`if (result.verdict === 'abuse')` → `prisma.userAbuseFlag.create` branch in
`productController.ts` is **kind-independent** and is asserted with `toHaveBeenCalledWith` for
the `product` and `label` kinds, so the behaviour holds for `item` by construction, though the
`item` test omits that one assertion (§F9). *"Accepts a cocktail in a glass"* — **not
executed**, and not executable here. A human must run one `PLAUSIBILITY_MODE=gemini` upload of a
cocktail photo and one of an abusive image, then tick the box.

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

### F9 — Minor (backend, found in re-review): the `kind=item` abuse test omits the `UserAbuseFlag` assertion

`uploadImage.test.ts`'s *"rejects abusive content on the item slot too"* stages
`mockAbuseFlagCreate.mockResolvedValue({ id: 'flag-3' })` but never asserts it was called — the
`product` and `label` equivalents both do (`expect(mockAbuseFlagCreate).toHaveBeenCalledWith(…)`).
The flag write is kind-independent so the behaviour is there, but the AC names the
`UserAbuseFlag` explicitly and this is the one test that would catch a future refactor gating it
on `kind`. One line. Not blocking.

### F10 — Minor (frontend, found in re-review): `mockResolvedValueOnce` queues leak between tests when one fails early

Observed while running the new tests against the pre-fix source: a test that fails before
consuming its second `mockSearch.mockResolvedValueOnce(...)` leaves that value queued, and the
*next* test consumes it — which is why *"renders search results including both kinds"* also
failed in that run, looking for `Coca-Cola` and getting the leftover `Negroni`. `beforeEach`
calls `jest.clearAllMocks()`, which does not drain a once-queue. Harmless while the suite is
green, but it turns one real failure into a confusing cascade. A `mockSearch.mockReset()` in
`beforeEach` (before the default `mockResolvedValue`) would fix it. Not blocking.

---

## Fix cycle 1 re-review (`bb1f71e`)

**Scope check:** `git diff --stat ff4624a..bb1f71e -- server/` is **empty** — the backend is
byte-identical to what passed in round 1, so the live-Postgres and HTTP suites were not re-run
(the server unit suite and typecheck were, for the record). Nothing under `terraform/` or
`.github/` is touched. The diff is 6 files: the hook, the screen, their two test files,
`CLAUDE.md` and `frontend.md`.

**The fix.** `useProductSearch` gains `settledQuery` state, set *only* on a successful
**first-page** (non-`append`) response, cleared when the hook deactivates or the query drops
below the searchable length, and exposed as the derived `hasSettled = settledQuery === query`.
Deriving it by comparison rather than storing a boolean is the right call: a keystroke
un-settles instantly, with no extra bookkeeping at fetch start. `add-custom-product.tsx` gates
`canOfferCreateAction` on `hasSettled` instead of `!searchLoading`, and `handleCreatePress`
early-returns when it is false (defence in depth — `results` is only known to belong to the
current query once settled).

**Resolution of F1's two open questions** (decisions supplied by the coordinator, both matching
the ticket's "appears only once … the results have loaded"):

| Question | Decision | Implemented as |
|---|---|---|
| Hide the Create button while unsettled, or show it disabled? | **Hide** | `canOfferCreateAction` gates rendering; no disabled state |
| Does a failed/offline search count as settled? | **No** | `setSettledQuery` is only called in the success path; both the `NetworkError` and `ApiError` branches leave it alone, so `hasSettled` stays false |

### Re-run of the browser probe (the F1 case) — 4/4 pass

Same harness as round 1 (Playwright against Expo web, registered session, mocked
`GET /api/products/search`), extended with two new cases:

```
[probe] CONTROL ok: soft gate still fires when results are loaded
[probe] create visible immediately (searchCalls=0): false
[probe] create visible after debounce (searchCalls=1): false; on create form: false
[probe] LEAK: first query settled, Create offered (expected)
[probe] LEAK: create still visible right after the new keystroke: false
[probe] LEAK: create visible 1.5 s later while the new query is in flight: false
[probe] OFFLINE: create visible while offline: false
4 passed (14.0s)
```

- **CONTROL** — with results loaded, a `similarity: 0.95` match still forces
  `custom-product-duplicate-confirm`. The feature itself is not broken by the fix.
- **RACE (was F1)** — Create is not offered immediately (`searchCalls=0`) *and* not offered
  1.5 s later while the request is still in flight (`searchCalls=1`, so the request really was
  issued). The create form is never reached. In round 1 this same case reached the create form
  with the confirmation never shown.
- **LEAK** (new) — a query that settled does not leave Create offered for the next one, neither
  on the keystroke nor 1.5 s into the new in-flight request. This is the case a boolean
  `hasSettled` flag would most likely have got wrong.
- **OFFLINE** (new) — an aborted search surfaces `custom-product-search-offline` and Create is
  never offered, per the decision above.

### The new tests actually fail on the pre-fix code

Checked rather than assumed, per the guardrails. A throwaway detached worktree at `ff4624a`
(pre-fix source) with only the **post-fix test files** checked out over it, `node_modules`
symlinked, and jest run against it — then the worktree removed:

| Suite | Result against pre-fix source |
|---|---|
| `hooks/use-product-search.test.tsx` | **6 failed**, 8 passed — exactly the 6 new `hasSettled` tests |
| `app/(app)/add-custom-product.test.tsx` | **5 failed**, 12 passed — the 4 new F1 tests, plus one cascade (§F10) |

Representative failure (`hasSettled › is false before any request … has resolved`):
`Expected: false / Received: undefined`.

Nuance worth stating: that particular test would also pass against a `hasSettled` hardcoded to
`false`. It does not stand alone — *"becomes true once the current query's first page
resolves"* pins the opposite direction, and the four screen tests assert rendered behaviour
(button absent before the debounce, absent again for a new query, absent on `NetworkError`,
absent on `ApiError`). As a set they discriminate properly.

**Mock-freeze check on the new tests:** clean. The only mocked boundary is `searchProducts`;
the hook's state, timers and a real `AbortController` all run for real, and the assertions read
state the hook itself mutates (`hasSettled` flipping across a rerender, `results` changing
from `['1']` to `['2']`). The `renderHook` props are driven through `rerender`, so the "query
changed" transition is genuinely exercised rather than restaged.

### No P6-008 regression from the shared hook

`useProductSearch` has exactly two consumers (`grep`): the new screen and
`app/(tabs)/index.tsx`. The Home tab's destructure does **not** take `hasSettled`, so the change
is purely additive there — and all three `e2e/home-search.spec.ts` specs (Mine filtering, the
no-match → All products path, and the All-products scope rendering a global result) pass, along
with the full jest suite (411 tests, up from 402 — the 9 new ones) and both typecheck projects.

### AC "no barcode/nutrition/allergen UI" — the edit-screen half, executed

Round 1 left this partly inferred: the product screen and (new) review-screen cases have unit
tests, and `edit-form.ts`'s CUSTOM logic is unit-tested, but the edit **screen**'s
`{!isCustom ? … }` block (11 hidden `Field`s) had no test. Executed in a browser against a real
custom product from the live API, with a control so the assertion cannot be vacuous:

```
[probe] edit screen for a CUSTOM product — packaged-only fields rendered: none
[probe] CONTROL (PACKAGED product 3d823985-…): field-brand rendered: true
1 passed
```

The control also exercised the real `GET /api/products/gtin/:gtin` Open Food Facts resolution
path. Suggested follow-up: fold an equivalent assertion into
`app/(app)/edit-product/edit-product.test.tsx`, which currently has no CUSTOM case at all.

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

All rows below are from the **final** state of the branch (`bb1f71e`) unless marked
"(round 1)". Backend rows marked "(round 1, not re-run)" are unchanged because
`git diff ff4624a..bb1f71e -- server/` is empty.

| Command | Directory | Exit | Observed |
|---|---|---|---|
| `npm run typecheck` | `server/` | **0** | clean (re-run on `bb1f71e`) |
| `npm test` (vitest) | `server/` | **0** | `Test Files 39 passed (39)` / `Tests 489 passed (489)` (re-run on `bb1f71e`) |
| `npm run lint` | `server/` | **0** | clean (round 1) |
| `npm run build` | `server/` | **0** | clean (round 1) |
| `npm run typecheck` | `bread-sheet-app/` | **0** | clean (both `tsconfig.json` and `tsconfig.test.json`) |
| `npm test` (jest) | `bread-sheet-app/` | **0** | `Test Suites: 38 passed` / `Tests: 411 passed` (was 402 in round 1; +9 from the fix) |
| `npm run lint` | `bread-sheet-app/` | **1** | 1 error, `scripts/test-maestro.js:1009 'Buffer' is not defined`. **Pre-existing**: identical failure in a clean `main` checkout (exit 1); file untouched by the diff; not run in CI. See F2 |
| `npm run test:e2e` | `bread-sheet-app/` | **1** | `5 passed, 2 failed`. **Both new P6-007 specs passed.** Failures: `e2e/auth.spec.ts` and `e2e/scan-tab.spec.ts` — reproduced **identically on `main`** with the same env and the same substitute auth stack (serially too, so not a parallelism artefact). Neither spec nor its code path is touched by this diff |
| live partial-index script (`tsx`, real Postgres) | `server/` | **0** | 9/9 PASS — items 1–8 above plus "a brand-new `PENDING_REVIEW` custom product is ratable" (round 1, not re-run: `server/` unchanged) |
| HTTP contract script, part 1 (real GoTrue tokens, live DB) | — | **1 → 0** | 31 checks; 28 PASS. 3 failed on *harness* bugs, not server behaviour: the harness skipped `POST /api/users/sync` (so every `User` FK failed), used `POST` instead of `DELETE /verify` for reject votes, and proposed a second edit while one was still `PENDING` (`409 edit_pending`, the correct response). Fixed and re-run |
| HTTP contract script, part 2 (the 3 corrected checks) | — | **0** | 3/3 PASS — two net rejections hide the product, the rejected name is reusable, an edit renaming onto an existing name is `409 duplicate_name` |
| HTTP contract script (both parts) | — | — | (round 1, not re-run: `server/` unchanged) |
| reviewer soft-gate probe (Playwright, scratch config) | — | **0** | round 1: `2 passed` — control + **the F1 bypass reproduced**. On `bb1f71e`: `4 passed` — control still fires, and the race, leak and offline cases all show Create correctly withheld |
| post-fix tests vs **pre-fix** source (throwaway worktree at `ff4624a`) | — | **1** (expected) | hook suite **6 failed** / 8 passed; screen suite **5 failed** / 12 passed — the 10 new tests all fail without the fix, confirming they discriminate |
| reviewer edit-screen probe (Playwright) | — | **0** | `1 passed` — no packaged-only field renders for a CUSTOM product; control confirms `field-brand` does render for a PACKAGED one |
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
   rot again. (F2) → **filed under [TICKET-P9-008]**, which already owned the app-lint and CI-lint work.
2. **Spot-check the `kind=item` plausibility prompt against `PLAUSIBILITY_MODE=gemini`** — a
   cocktail in a glass must get `ok`, obvious abuse must still get `abuse` with no reason leaked.
   Mock mode cannot cover this. **This one gates an unticked acceptance criterion**, so it is the
   only follow-up that must happen before P6-007 is considered fully closed. (F5) → **[TICKET-P6-013]**.
3. **Fix the stale migration name in the `Product.nameKey` schema comment.** (F3) → **fixed on this branch** (comment now names `20261108204955_custom_products`).
4. **Make the app's own e2e specs runnable without a backend** (or document that `test:e2e`
   needs one): `e2e/auth.spec.ts` and `e2e/scan-tab.spec.ts` are the only two specs that do not
   mock `GET /api/users/me/ratings`, and they are the two that fail locally. → **filed under [TICKET-P9-006]**.
5. **Assert `UserAbuseFlag` creation in the `kind=item` abuse test** (one line, mirroring the
   `product`/`label` cases). (F9) → **[TICKET-P6-014]**.
6. **Drain the `mockSearch` once-queue in `add-custom-product.test.tsx`'s `beforeEach`** so one
   failure cannot cascade into the next test. (F10) → **[TICKET-P6-014]**.
7. **Add a CUSTOM case to `app/(app)/edit-product/edit-product.test.tsx`** asserting the
   packaged-only fields are not rendered — currently only the reviewer's browser probe covers
   the edit screen's half of that AC. → **[TICKET-P6-014]**.

---

Also filed from the open questions below: the `custom_product_name_unique` real-DB invariants and the
apply-time rename collision (F6, open question 4) → **[TICKET-P9-011]**; the first-page-only soft-gate
residual (open question 3) → a note on the *Merge duplicate custom products* backlog idea.

## Open questions for the implementer / human

1. ~~**F1 — what should "the results have loaded" mean exactly?**~~ **Answered and implemented.**
   (a) *hidden*, not disabled; (b) a failed/offline search does **not** count as settled. Both
   decisions came from the coordinator and both are verified in a browser — see the table in
   §Fix cycle 1 re-review. Kept here because the questions, not just the answers, are the record.
2. **F5 — the one open item that still gates a box.** The `kind=item` plausibility AC is
   **unticked** in `FEATURES.md`. A human needs one `PLAUSIBILITY_MODE=gemini` run: a cocktail
   photo must come back `ok`, an abusive image must still come back `abuse` with a
   `UserAbuseFlag` row and no reason leaked to the client. The reviewer cannot do this (no
   credentials, paid call). Everything else about that gate — the `kind=item` routing, the 422,
   the no-leak rule, the kind-independent flag write — is executed or structurally proven.
3. **Is the residual near-duplicate risk acceptable?** With F1 fixed, the soft gate cannot be
   bypassed by timing, but it still only considers results already on screen (the first page of
   20) and only blocks at `similarity ≥ 0.6`. "Negroni" vs "Classic Negroni" can still become two
   rows, and merging is out of scope by the ticket's own decision. Flagged as a known, accepted
   limit rather than a defect — worth a backlog item if duplicates show up in practice.
4. The apply-time rename-collision path (`castEditVote` → edit auto-`REJECTED` + `logger.warn`)
   is unit-tested but was **not** reproduced live — it needs two voters plus a third party
   taking the name between proposal and the resolving vote. The ticket calls that case "rare and
   acceptable"; flagged only so the record is accurate about what was executed.
