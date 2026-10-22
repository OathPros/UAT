# Halo Knowledge Base UAT

A static, accessible participant application and administrator dashboard for up to ten invited testers. GitHub Pages hosts `web/`; a single Cloudflare Worker implements `/api/*`; D1 stores the authoritative catalogue, sessions, assignments, hashed participant credentials, results, and mutation receipts. There is no Apps Script, Sheets, UI framework, frontend build, or third-party browser script.

Start with [DEPLOYMENT.md](DEPLOYMENT.md) for exact launch instructions. **Nothing has been deployed by this implementation.** See [VALIDATION.md](VALIDATION.md) for executed checks and remaining live gates.

## Local development

Node 22.19 or newer and Python 3 are needed. From the repository root:

```sh
npm ci
npm run setup:local
```

`setup:local` creates an ignored `worker/.dev.vars` with a random local `ADMIN_API_KEY` if the file does not already exist, preserving any existing file. Inspect this file privately to use the local administrator page; never commit it, paste it in issues, or share it with participants. No default credential exists. `npm run dev` reads this file. This key is for local development only; production uses Wrangler secrets.

```sh
npm run dev
# Another terminal, same repository root:
npm run web
```

The participant page is on local port 8080 and admin is `admin.html`. Public `web/config.js` initially targets local Worker port 8787. After configuring the production URL, use `git show` or a separate local working copy of public configuration to target local development; never publish a localhost URL. Use the existing checkout in isolated cloud tasks; creating a Git worktree is unnecessary.

Tests run in isolated, temporary Miniflare/workerd D1 databases, not against your local or production results:

```sh
npx playwright install chromium
npm test
# If using an already-installed compatible Chromium:
CHROMIUM_EXECUTABLE=/usr/bin/chromium npm test
npm run test:unit
npm run build
```

`test:unit` covers API, D1 and queue logic without a browser. Full `npm test` also launches Chromium and serves the actual UI at a project subpath. It uses local ports 8080 and 8787; stop your own dev services before running it. Browser assertions use a generated in-memory admin key. On restricted cloud machines, create a writable configuration directory (`mkdir -p .cache/config`) and set `XDG_CONFIG_HOME="$PWD/.cache/config"` and `WRANGLER_LOG_PATH="$PWD/.cache/wrangler.log"` for Wrangler commands. This avoids writing to an unavailable home configuration directory; it is not needed on normal workstations. Cloudflare telemetry can be disabled with `WRANGLER_SEND_METRICS=false`.

## Participant workflow

The administrator creates a Quick Start (32), Core (151), All (215), or ordered Custom session. Only its explicit assignment snapshot is presented. Testers join with name, initial, configured team, and a private random 256-bit join code. These labels are not verified institutional identity. A separate 256-bit bearer recovery code identifies each participant; it is shown once and optionally remembered on the trusted device. Recovery on another device requires this code.

Select Pass, Partial pass, Fail or Skipped. Fail and Partial require a trimmed 2–3,000 character comment. Previous/Next do not wait for a save. No answer creates no result. Sidebar search/category/outcome filtering is local. The progress bar counts server-confirmed records; older confirmed outcomes can coexist with a newer pending edit. Pending/conflict counts and the current save state make this explicit.

The local durable queue writes each edit before navigation. It coalesces edits and sends only one mutation at a time. Each operation has an immutable mutation UUID, expected server version, and payload. The frozen operation is persisted before transmission and reused after timeouts, failed acknowledgements, or refresh. A newer local edit remains separate until the older operation is acknowledged. Five capped exponential retries with jitter are followed by a persistent error and manual Retry; reconnection also retries. No failed save becomes confirmed.

A conflict preserves both the fetched server revision and pending local edit. The tester explicitly chooses to save their edit against that revision or retain the server outcome. No automatic last-write-wins reconciliation occurs. Browser Web Locks prevent a second tab in the same profile from opening the same participant; browsers without Web Locks warn to use one tab. Separate devices still have independent queues protected by server revisions.

LocalStorage failure displays a persistent warning: keep the tab open and copy pending comments if necessary. Clearing site storage removes the local queue and remembered token; it never deletes D1 results. Do not clear storage or change the Pages origin while pending edits exist. New frontend releases retain storage keys and D1 data.

## Integrity and security

- The result key is `(session_id, participant_id, test_id)`, enforced with foreign keys and a primary key. Conditional writes require the expected integer version. A trigger records a mutation receipt in the same SQLite transaction as the write. An exact retry returns its original acknowledgement even after later revisions; reusing the mutation UUID for different content is rejected. No receipt may be pruned while clients might retry it.
- Join retries use a random 256-bit client registration key persisted before the first request. The Worker issues a pseudorandom recovery token using HMAC-SHA-256 keyed by the administrator secret over session ID and registration key; D1 stores only token and registration hashes. The registration key is not a recovery mechanism without the private invitation code and matching join details. Keep the admin key stable during active onboarding. Rotating it invalidates the derivation for unfinished join retries, but does not invalidate already-issued participant tokens (their hashes remain in D1).
- Admin API keys stay only in page memory and must have at least 32 characters. Every admin route, including export, authenticates them. Participant endpoints derive scope from the token, ignoring client attempts to select another participant. Session activity and assignment are enforced server-side.
- Request bodies are streamed with a 16 KiB bound, SQL input values are bound parameters, statuses/comments are validated on both sides, and registration/admin/participant routes have D1-backed fixed-window rate limits. Join is 30 attempts/IP/minute, admin 240/IP/minute, participants 180/identity/minute. Rate records contain only a rate key, minute, and count. If sharing one institutional proxy, allow a minute between repeated failed joins. Consider Cloudflare edge abuse rules for a public invitation.
- CORS allows only exact configured origins, including error/preflight responses. CORS is not authentication. Authenticated responses are `no-store`. User data is rendered with `textContent`, not `innerHTML`. The production configure script sets CSP to the exact Worker origin. No credential belongs in public JS, Pages artifacts, logs, or source.
- CSV includes UTF-8 BOM, CRLF records, quoted/escaped cells and apostrophe neutralization for formula prefixes (including whitespace-prefixed values). Only admins can export.

This is a temporary, low-sensitivity tool. Use fabricated tickets and minimal labels. **Do not enter student records, production ticket details, passwords, personal information or sensitive data. Cloudflare D1 does not guarantee Canadian data residency.** Obtain institutional approval for any institutional storage requirements. Delete the temporary dataset when retention requirements permit, using a deliberate separate administrative procedure after backup.

## Administrator reporting

Filter by session, team, outcome, exact category, priority and test ID; search names, test titles/IDs and comments. Results default to issues first and are paginated in bounded pages. Summary distinguishes assignment count, participant × assignment expected executions, confirmed results, outstanding, completion, per-outcome counts and pass rate (Pass / (Pass + Partial + Fail)). Outcome/search filters apply to recorded outcome metrics; session/team/catalogue filters define expected/completion totals. UI labels explain this distinction. Reports include recurrent failures and teams, last submission per participant, and assigned cases with no results. Refresh is manual, avoiding background polling. Full filtered export is not limited to the current page.

## Source map

- `worker/src/index.js`: HTTP, authentication, validation, sessions, result writes and reporting.
- `worker/migrations/0001_init.sql`: schema, indexes and atomic mutation receipts.
- `scripts/seed-tests.js`: idempotent canonical seed; upserts definitions without deleting results.
- `web/queue.js`: durable save state machine, tested independently of the DOM.
- `web/app.js`, `web/admin.js`: vanilla ES module interfaces.
- `worker/tests/`: API, simulated ten-tester concurrency, queue and Chromium acceptance checks.
- `.github/workflows/pages.yml`: publish only `web/` through a Pages artifact; source/data/reference are not uploaded.

The obsolete interface is only a reference. Existing Sheets data is not silently imported. A migration is optional and not needed to launch; use a reviewed, separately scoped importer only after obtaining a real export and mapping its participant/session identifiers. Never infer secure identity from display names or replace current results with a spreadsheet.

The API contracts and error semantics are documented in [API.md](API.md). Development dependencies are pinned in the lockfile. The Miniflare version matches the one shipped by the pinned Wrangler release (including its upstream beta version designation); no Node packages are shipped in the static frontend or used as runtime libraries by the deployed Worker.

## Appearance

Choose Classic, Midnight (dark), Bubblegum, Ocean or Sage between Team and Session join code. After joining, use **Appearance** beside your name to change it. The palette is stored only in the browser under `halo.theme`, independently of recovery credentials and pending results; it is not sent to D1 or included in exports. The admin page uses the same device preference. Outcome colours retain their meaning in every palette, with light backgrounds before selection and solid dark backgrounds after selection.

Recovery-code controls and routine synchronization status appear below the test workspace. Failed saves, conflicts, and storage failures remain prominent above it. The participant footer warning was removed at the owner's request; the documented restrictions on using sensitive data remain unchanged. Appearance updates need only a GitHub Pages deployment, with no Worker deployment, database migration, reseeding or changes to existing results.
