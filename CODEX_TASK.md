# Codex implementation task — Halo Knowledge Base UAT

## Mission

Build and verify a **production-usable, temporary UAT web application** for **up to 10 concurrent testers**. The app records test results for a 215-case Halo Knowledge Base UAT library. Prior versions used Google Apps Script and Google Sheets; they suffered from slow, unreliable login and silent lost saves. **Do not port the Google Apps Script backend or its fragile save mechanism.** Build a fresh static frontend and Cloudflare Worker API backed by D1.

**Do the work, not just generate a design or project plan.** Create a runnable repository; run tests; correct failures; document exact deployment commands. Do not claim that a deployment or a real concurrency test succeeded unless you actually executed it. If credentials/Cloudflare access are unavailable, finish all local implementation/testing and give precise manual commands.

## Non-negotiable deployment architecture

1. **GitHub Pages** serves only HTML, CSS, JS, icons, and other public static assets. It MUST work from a repository project path like `https://USER.github.io/halo-kb-uat/`, with relative asset URLs (no assumed `/` site root). No web framework or build tool for the UI unless truly necessary; prefer accessible vanilla HTML/CSS/ES modules.
2. **One Cloudflare Worker** handles the JSON API under `/api/*`. Worker source lives in `worker/`, managed/deployed by Wrangler. The UI calls this Worker via `fetch` using a configurable `API_BASE_URL` in `web/config.js` (which contains **no secrets**).
3. **Cloudflare D1** is the only source of truth for test cases, sessions, participants, assignments, and saved results. The Worker accesses D1 with `env.DB`; D1 is **never queried directly from the browser**. No Apps Script, Google Sheets runtime dependency, Cloudflare Pages hosting, Firebase, Supabase, external auth SaaS, or client-side-only datastore.
4. Use **D1 migrations** rather than a destructive schema reset. Provide local development and remote deployment instructions.
5. Preserve the **look and feel**, general participant flow, and admin reporting of `reference/old-interface-reference.html` as a design guide only. That file contains obsolete Google Apps Script assumptions and is **NOT runtime code to reuse blindly**.
6. Import `data/tests.json` as the authoritative seed. It contains **exactly 215 unique test IDs, 19 categories and 151 Core cases**. Do not paraphrase, invent or omit test definitions. Retain ID, category, tier, priority, title, and expected result. Seed must be idempotent without erasing existing results.

## What testers experience

- Open GitHub Pages link; enter **first name, last initial, team, and session join code**. No email/password. Validate length and character restrictions, trim whitespace and present errors accessibly. The available team list must be configurable. Never treat first name or last initial as secure identity.
- A joining participant receives a cryptographically random, high-entropy opaque **recovery token** (minimum 128 bits; prefer 256 bits), shown once in a copyable 'Save your recovery code' panel, and optionally persisted on the same device. For refresh, restore the existing participant using that token, **without making a duplicate identity**. Restore on a new device only with the recovery token; never allow claiming someone else's session based on name/initial/team.
- No endless spinner at join/restore. Disable the submit button only while its request is actually in flight; show a clear error with Retry; set sensible request timeouts. Failed restoration must not silently erase recoverable pending results.
- Display only tests assigned to the participant's session, in a useful sequence: category sidebar, search/filter, ID, title, instructions or expected result, and progress. Support a **32-case Quick Start**, **Core**, **All 215**, and **Custom ID set** when creating sessions. Quick Start ID list is provided below. Defaults should favor the short session, not 215 tests.
- Four prominent exclusive outcome controls: **Pass, Partial pass, Fail, Skipped**. Comments **required for Partial pass and Fail** after trimming, minimum 2 characters. Comments optional for Pass/Skipped. Client and API enforce identical validation. Support a reasonable upper bound (e.g., 3,000 characters) to protect the database and UI. Display concise inline errors; never silently discard a result.
- Clicking **Next / Previous** must be immediate once the current answer is *valid*. It must not wait for the network; however, if a selected Fail or Partial pass lacks a valid comment, block navigation, focus the comment field, and state why. Do not mark unanswered tests as 'Skipped'. An explicit Skipped result is a saved choice.
- Show **Not started / Pending save / Confirmed / Save failed** clearly, both on the current case and in the aggregate. The progress bar for *confirmed* results must count only records acknowledged by the Worker. Never claim 'saved', 'completed', or 'recorded' from only local state.
- Allow navigating back and revising a previously submitted answer. Prior confirmed results load on refresh. If a save fails, keep the edit locally, show a persistent problem banner, and allow retry. Never discard or silently replace a pending result with stale server data.
- Keyboard accessible and mobile responsive, visible focus states, semantic labels, contrast-appropriate outcome differentiation (not colour alone). Simple York-inspired red/blue/grey palette, restrained style, **fast and clean**, no splash animations.

## Save integrity and concurrency requirements (CRITICAL)

- **Navigation is independent of network writes**, but invalid comments are not allowed. After a valid selection, record it in a *durable local pending queue* (use localStorage or IndexedDB with storage errors handled) before leaving the case. Show a warning if browser storage is unavailable and explain the tab must remain open.
- Use a short debounce/coalescing strategy and at most one in-flight mutation per participant (or guarantee strict per-test ordering). Never fire overlapping writes that can overwrite a newer result with an older one.
- Each result row is uniquely identified by **(session_id, participant_id, test_id)** at the D1 database level. A participant's repeated save **updates** their row, never inserts duplicate logical results. Do not let one participant overwrite another participant's row.
- Support safe request retries and out-of-order responses. Prefer **optimistic concurrency**: result `version` field, client `expected_version`, and unique `mutation_id`; use an atomic SQL conditional update / UPSERT. Return a `409 CONFLICT` on stale revision and have client fetch/reconcile without overwriting either pending work or newer server data. An exact retry of a previously confirmed mutation should be harmless/idempotent. If adding a mutation receipt table improves reliability, do so; document and test how it prevents ambiguous retries. Never rely on timestamps alone to order concurrent modifications.
- Persist statuses with canonical values: `pass`, `partial_pass`, `fail`, `skipped`. API responses report the updated record and server version. `Not started` is **absence of a saved result**, not a fifth stored status.
- The API validates **session membership, that the test is assigned to the session, session active state, allowable status, comment requirement, comment length, expected revision, and caller identity**, not merely the frontend.
- Server-side parameterized D1 statements only; input validation, bounded payloads, structured consistent errors, no SQL string concatenation with user input.
- D1 writes must be short and indexed. If supporting a batch endpoint, define atomic/per-item semantics precisely; do not allow partial success to be reported as full success. Prefer correctness and predictable responsiveness over excessive batching. No polling of D1 for every keystroke.
- When the client is offline or writes fail, visually retain pending outcomes, retry with capped exponential backoff and jitter, and resume sync on reconnect/refresh. Do not suppress the error after retries expire. Do not mark an unconfirmed result as confirmed.
- Provide a **10-concurrent-tester load/smoke test**, including overlapping save timings, repeated retries, updates to the same test, different testers saving the same test, and refresh during pending writes. Test that all expected distinct records exist and latest valid revisions survive. Use automated tests with a local D1 Worker where possible; clearly report what is simulated versus verified remotely.

## Security and privacy requirements

- This is a **temporary, low-sensitivity UAT tool**. Use fabricated ticket scenarios; include a brief visible warning not to enter student records, personal information, production ticket details, passwords, or sensitive data in comments.
- Each participant has a **server-issued random bearer token**; store only its cryptographic hash in D1, never the raw token. Use constant-time checks for any server-secret comparisons where practical. Token must be scoped to **one participant identity**, and to their session(s) as designed. An attacker with a different participant token cannot fetch or write others' results or view the administrator dashboard.
- Registration requires an active, unpredictable **session join code** generated/administered by the admin (not an easily guessed default such as `HALO-UAT`). Do not put live join codes in the publicly accessible GitHub files. Avoid allowing unlimited anonymous session discovery or code-guessing; implement modest registration throttling, and state that the join code is an invitation gate, not verified institutional identity.
- **Admin routes require separate strong authentication**: an administrator API secret provisioned via `wrangler secret put ADMIN_API_KEY` (or a comparably straightforward secure solution). The secret must NEVER ship in public JS/HTML, repository, log, API config, or database seed. Admin login can prompt for the secret once per browser session and hold it **only in memory**, not localStorage. Admin auth must be enforced on *every* admin API request. Do not treat a hidden admin page, a CORS origin, or a session join code as authorization.
- Allow browser CORS requests only from the configured **exact GitHub Pages origin** (and localhost dev origin). Handle `OPTIONS` preflights for `Authorization, Content-Type`; send CORS response headers on successful and error responses, `Vary: Origin`, and appropriate `Cache-Control: no-store` for authenticated responses. CORS is not a security boundary; perform full API authentication/authorization even for curl/no-Origin requests.
- HTTPS for hosted frontend/API. Avoid inline untrusted HTML and `innerHTML` for user-provided comments/titles; escape any dynamic HTML. Restrictive CSP where practical with the required Worker origin; no third-party scripts/tracking. Server-side sensible request size/rate limits. Avoid public per-test result APIs without participant or admin authentication.
- CSV exports must escape commas/quotes/newlines and guard against spreadsheet **formula injection** from comments or names (cells starting with `=`, `+`, `-`, `@`, tab, CR, or LF after leading whitespace). Use UTF-8, Excel-friendly export, and proper `Content-Disposition`.
- Storage geography and data policy: Cloudflare D1 is not automatically guaranteed to be Canadian data residency. Flag this in README for institutional review; app must not be described as authorized to store regulated or confidential York data.

## Data model (minimum)

Provide clear indexed D1 SQL migrations with foreign keys where supported:

- `test_cases` (id PK, category, tier, priority, title, expected_result, optional sort_order, active).
- `sessions` (id PK, name, random join_code_hash, creation timestamp, active/closed, mode [QUICK|CORE|ALL|CUSTOM]). Use a stable session ID independent of join code.
- `session_tests` (session_id, test_id, position; composite PK) for explicit test assignments (snapshot assignment at session creation).
- `participants` (id PK, session_id FK, first_name, last_initial, team, token_hash unique, created_at, last_seen_at). Same first name/initial does not imply same participant.
- `results` (session_id, participant_id, test_id, status CHECK IN ..., comment, version integer, last_mutation_id, created_at, updated_at; UNIQUE session_id + participant_id + test_id). Verify cross-table integrity in Worker.
- Optional `mutation_receipts` for true idempotent retries; optional `result_events` if maintaining an audit trail is cheap.

Index expected filters and joins: results by session/test/team/status; tests by category; participants by session; session_tests by session/position. Avoid redundant data and heavy joins on every keystroke.

## API contract (you may refine endpoints, but document final contracts)

Public (join code needed):
- `POST /api/join` `{sessionCode, firstName, lastInitial, team}` -> participant profile + recovery token once + assigned session metadata.
- `GET /api/health` -> minimal alive response without exposing private details.

Participant bearer-token endpoints:
- `GET /api/me` -> current participant/session info.
- `GET /api/tests` -> assigned test catalogue, ordered; never all sessions' private data.
- `GET /api/results` -> caller's own confirmed results and versions.
- `PUT /api/results/:testId` -> status/comment/expectedVersion/mutationId; response includes save acknowledgement and new version; `409` for real conflicts, `422` for invalid comments, `401/403` for access problems.

Admin bearer-token endpoints:
- `GET /api/admin/sessions`, `POST /api/admin/sessions` (QUICK/CORE/ALL/CUSTOM), `PATCH /api/admin/sessions/:id` for closing/reopening.
- `GET /api/admin/summary` (filter session/team/category/priority/test/status).
- `GET /api/admin/results` (filter/sort/search with pagination and bounded page sizes; include test ID/title/category, participant name/initial, team, session, status, comment, updated_at).
- `GET /api/admin/export.csv` -> full filtered report; allow issues-only export.
- Optional `GET /api/admin/coverage` -> tests never executed, failed across teams, outcomes by category.

Never expose an endpoint that lists other participants' results to non-admins. Use consistent JSON response format and error codes. Include `Access-Control-Allow-Headers: Authorization, Content-Type` in valid preflight responses.

## Dashboard and reporting

Admin view behind admin authentication, displaying:

- Session selector (including all sessions), team selector, status selector, category/test ID filters.
- Participants joined; assigned tests; unique expected test executions; **confirmed** results; outstanding/not-started; Pass; Partial pass; Fail; Skipped; completion rate; pass rate (exclude Skipped and not-started from pass-rate denominator).
- Failing and partial cases ordered prominently with comments; recurring failures by case/team; last submission time per tester; cases with no results.
- Rows with searchable columns: session, tester first name and last initial, team, test ID and title, category, priority, status, comment, timestamp.
- Export all results to CSV, and separately failed/partial only. Export should open correctly in Excel without formula execution from comments.
- Create sessions in UI and show a copyable session join code **only to admin**, not in public static assets. Use random codes (adequate entropy). Make it simple to close or reopen a session.
- Dashboard refresh on demand and optionally every 15-30 seconds. Do not add WebSockets, realtime subscriptions or unnecessary infrastructure.

## UX and performance targets

- Participant entry, navigation, filtering and status selection should feel instantaneous; as a design target, navigation should typically be **under 150 ms** without network dependence.
- Show current save state explicitly, with server confirmation. Do not place a blocking overlay on Next while the network is writing.
- Request timeouts, readable error messages, and Retry actions are mandatory. Prevent double-submit on login and duplicate registration on a retried request, using a registration idempotency key if appropriate.
- Target smooth performance for **10 concurrent testers**; measure and report local browser/request timings and test conditions, rather than guaranteeing latency under all networks.
- Avoid excessive HTML render/rebuild while a tester is typing comments; debounced save should not blur or reset input.

## Explicit acceptance tests (must automate where feasible)

1. First join creates one identity; refresh/recovery resolves the same participant; blocked/slow login reports a retryable error and does not hang.
2. Ten users join a test session in parallel and each saves a result on the same test ID; exactly ten distinct result rows appear, with no cross-user leakage.
3. One user changes Pass -> Fail+comment -> Partial pass+comment quickly; final DB value equals latest valid input, irrespective of simulated network delays and retry order.
4. Fail/Partial without a 2+ character trimmed comment cannot navigate or save; server directly rejects it even if client is bypassed; result remains unconfirmed.
5. Explicit Skip is saved and displayed; Next without answering never silently records Skip or Pass.
6. Simulated network outage and refresh do not falsely mark pending as saved; pending local data is retried/reconciled safely upon recovery.
7. Different user tokens cannot access other users' results; unauthenticated users cannot write; guessing a display name cannot log in; public origin is not sufficient auth.
8. Invalid/missing admin secret fails on all admin routes, including CSV; secret is absent from static deployed assets.
9. A repeated identical request does not create duplicates or overwrite a newer result; stale version returns conflict with recoverable client behaviour.
10. All 215 provided cases seed exactly once with the correct text/ID; sessions with QUICK/CORE/ALL/CUSTOM have the right count/order (QUICK 32, CORE 151, ALL 215).
11. Admin dashboard numbers reconcile against D1 counts after concurrent activity; export rows match dashboard filters and Excel formula injection is neutralized.
12. GitHub Pages served from `/halo-kb-uat/` loads all static assets and successfully contacts the Worker with correct preflight/CORS; browser console has no blocking errors.
13. Reopening after a deployed frontend update does not reset the D1 results or participant recovery.
14. Local build, test, and smoke commands run cleanly; no placeholders accidentally contain secrets or default production credentials.

## Development and deployment deliverables

Use roughly this repository structure (refine as needed):

```
repo/
  web/
    index.html
    admin.html
    styles.css
    config.js                 # Public Worker URL only, never credentials
    app.js
    admin.js
  worker/
    src/index.js             # or TypeScript equivalent
    migrations/0001_init.sql
    wrangler.toml            # D1 DB binding; real DB UUID filled during setup
    package.json
    tests/                   # Worker/API/concurrency tests
  data/tests.json            # all 215 cases
  scripts/seed-tests.*       # idempotent, local/remote-safe
  README.md
  DEPLOYMENT.md
  .gitignore
```

- **GitHub Pages:** explain publishing from `web/` (via GitHub Actions if the branch-publish UI cannot publish a `web/` folder directly) or choose `docs/`/root for easiest no-build branch deployment. Choose the least fragile deploy path; test repository-subpath URLs. Do not incorrectly claim GitHub Pages branch publishing directly supports any arbitrary folder.
- **Cloudflare:** include Wrangler config template and `npx wrangler d1 create ...`, `npx wrangler d1 migrations apply ... --local`, `... --remote`, `npx wrangler secret put ADMIN_API_KEY`, and `npx wrangler deploy` commands, matching actual files and working directory. Do not include active secret values in docs.
- Explain where to set `API_BASE_URL`, configure exact allowed browser origins, inspect Worker logs, and confirm D1 writing remotely. Protect against accidentally running destructive local reset against production.
- Include a **minimal backup procedure** (`wrangler d1 export` or verified alternative, plus admin CSV), a way to check live result counts, and straightforward troubleshooting for CORS, 401, 409, 422, schema mismatch, quota, and deployment.
- Include one full start-to-finish smoke test: create session -> join as tester -> fail with comment -> refresh -> confirm save -> inspect admin dashboard -> export CSV -> verify row.
- If migrating existing Google Sheets results: provide an **optional** documented one-time import script from a named CSV export, dry-run mode, ID mapping, validation, and duplicate prevention. Do not silently overwrite old results. The new app can launch without migration.

## Quick Start exact IDs (32)

```
A01,A02,A03,A04,A07,A09,B01,B03,B11,B12,C01,C03,D01,D02,D07,D14,D16,F04,F07,G02,G06,H02,H03,H04,H05,I01,J04,K03,K09,L01,M02,N02
```

## Execution approach for Codex

1. Inspect `data/tests.json` and `reference/old-interface-reference.html`. Verify test count and unique IDs. Read the existing Google Apps Script code only for intended UX; do not keep its network API functions or authentication model.
2. Implement database schema, migrations, seed import, API auth, session creation, and safe result upsert. Write API tests first for validation, authorization, idempotency and revisions.
3. Implement static interface and result queue; test failing paths before polishing UI.
4. Implement administrator reporting, filtered CSV, and export sanitization.
5. Run lint/automated tests; then execute simulated 10-tester concurrency test and browser test for GitHub subpath, refresh, recovery, pending saves and fail/partial validations.
6. Resolve test failures. Present a short handoff with what was created, tests that actually ran, steps I must perform in Cloudflare/GitHub to deploy, and any known limitations.

**Important:** Do not ask me to decide basic implementation details. Make sound defaults within the specified architecture. Ask only for credentials, repo access or a host origin if deployment actually requires information you cannot infer. Do not stop after building a mockup; deliver functioning API, persistence, and UIs.
