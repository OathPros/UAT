# Launch checklist and exact commands

Run commands from the repository root unless stated otherwise. A Cloudflare account with Workers and D1 access and permission to publish this GitHub repository's Pages site are required. No live deployment, account access, remote D1 migration, or Pages publication has been performed here.

## 1. Cloudflare database and configuration

Install dependencies using Node 22.19+:

```sh
npm ci
npx wrangler login
npx wrangler d1 create halo-kb-uat --config worker/wrangler.toml
```

`wrangler login` is for your own authorized workstation. In an automated deployment, use a securely provisioned scoped `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`; do not commit either. The repository does not need or contain Cloudflare credentials.

Copy the returned D1 UUID into `worker/wrangler.toml` as `database_id`, replacing the all-zero local placeholder. Keep binding `DB`, database name `halo-kb-uat`, and migrations directory unchanged.

Set `ALLOWED_ORIGINS` in that file to the **origin** of the actual GitHub Pages site. For the default OathPros project site it is `https://oathpros.github.io`, with no `/UAT/` path and no trailing slash. If using a custom Pages domain, use its exact HTTPS origin instead. Include development origins only if you need browser access to the deployed API from them:

```toml
[vars]
ALLOWED_ORIGINS = "https://oathpros.github.io"
TEAMS = "Client Services,CTS,SSB IT,OUR,UIT,Other"
```

Teams are configurable; existing participant teams remain stored if you later change the join list. Review institutional data requirements before using the service.

Apply the non-destructive migrations and canonical seed deliberately to the **remote** database:

```sh
npx wrangler d1 migrations apply DB --remote --config worker/wrangler.toml
CONFIRM_REMOTE_SEED=yes node scripts/seed-tests.js --remote
npx wrangler secret put ADMIN_API_KEY --config worker/wrangler.toml
npx wrangler deploy --config worker/wrangler.toml
```

For `secret put`, enter a privately generated cryptographic random secret of at least 32 characters (for example 32 random bytes encoded as hex). Save it in your password manager; never put it in JS, `.toml`, a GitHub repository variable, source, chat, command history, or an issue. The CLI securely prompts for the value. This production key is separate from `worker/.dev.vars`.

There is no reset script. Seed only upserts the exact 215 provided definitions, preserving sessions/results. A session's assignment is captured at creation. Do not replace the D1 binding or run DROP/DELETE to deploy an update.

The deploy command prints the HTTPS `workers.dev` origin. Verify its `/api/health` returns `{"ok":true,"alive":true}`. This proves liveness only, not persistence or authorization.

## 2. Configure and publish GitHub Pages

Use the actual Worker origin from deployment, with no `/api` path:

```sh
node scripts/configure-web.js https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev
```

This writes the **public** Worker URL to `web/config.js` and restricts both HTML CSP `connect-src` directives to that exact origin. It supports a custom HTTPS Worker domain as well. Never put a key or join code in this URL or file.

Commit and push the implementation and these public configuration changes to `main` using your normal review process. In GitHub:

1. Open repository **Settings → Pages**.
2. Set **Build and deployment → Source → GitHub Actions**.
3. Enable Actions and allow the Pages deployment environment if your organization requires approval.
4. Run **Publish static UAT frontend** or let its `main` push trigger run. It refuses a localhost API URL.
5. Use the exact URL from the successful Pages action. For this repository's default project site it should be `https://oathpros.github.io/UAT/` (case-sensitive repository path). Admin is `admin.html` beneath it.

Only `web/` is uploaded. GitHub's branch-folder selector does **not** publish arbitrary `web/` directories; use the supplied Actions workflow. All asset references are relative, so repository subpaths work. Enforce HTTPS in Pages settings. If the published origin differs, update `ALLOWED_ORIGINS` and redeploy the Worker.

No GitHub secret is needed for the Pages deployment: it uses the workflow's Pages/OIDC permissions. Do not put `ADMIN_API_KEY` in GitHub frontend configuration.

## 3. Create a session and complete the launch gate

Open the administrator page, enter the private admin key, and create a Quick Start session. Save the random join code when displayed; only its hash is stored, so it cannot be retrieved later. Share it privately with invited testers. You can close/reopen sessions without deleting results. If session creation times out, inspect sessions before retrying. Close any orphan session whose one-time code was lost, then create a replacement.

Before inviting ten testers, use two browsers or separate profiles:

1. Join with a fictitious participant and save the recovery code privately.
2. Select Fail with no comment. Next must be blocked and no record confirmed. Add a comment, navigate immediately, and wait for Confirmed.
3. Refresh. The same participant and confirmed outcome must return without a duplicate identity.
4. Restore with that code in another profile. Confirm the same data; another participant code must show only its own results.
5. Simulate offline/failed PUT requests in browser developer tools. Edit a result, navigate, verify Pending/Save failed, refresh while static assets remain accessible, then restore network and Retry. The edit must persist and confirm. A fully offline page reload may fail to load the static application; reconnect before loading it—this is not a PWA.
6. Save the same case from two profiles with the **same** recovery code. A stale writer must receive a conflict, retain the local comment, and offer both explicit reconciliation choices. Separate participants must never conflict with one another.
7. In admin, Refresh, reconcile counts, filter results and export both all and issues-only CSV. Open in Excel; confirm quoted commas/newlines and formula-looking comments display as text.
8. Close a session, confirm writes/new joins fail without losing local edits; reopen and retry.
9. Run ten simultaneous **distinct** tester identities on the actual deployed Worker. Verify ten result rows for the same case, then rapid revisions/retries and recovery. Check responsiveness on the actual institutional network.
10. Publish a frontend update without changing storage origin or D1 binding. Refresh and verify recovery and results survive.

The automated local ten-tester test is not proof of live Cloudflare latency, quotas or institutional network behaviour. Do not declare the ten-person UAT launched until these deployed gates pass.

## Backup, observation and maintenance

Before migrations or closing the service:

```sh
npx wrangler d1 export DB --remote --config worker/wrangler.toml --output /secure/path/halo-uat-backup.sql
npx wrangler d1 execute DB --remote --config worker/wrangler.toml --command "SELECT session_id, status, COUNT(*) AS records FROM results GROUP BY session_id, status;"
npx wrangler tail --config worker/wrangler.toml
```

Also download filtered/full admin CSV. Keep SQL backups outside this repository; they contain participant labels, token hashes, results, and join-code hashes. Verify restoration into a separate test D1 database before relying on a backup. Never overwrite the live database to test restoration. Worker logs intentionally omit request bodies, bearer tokens and keys; do not enable verbose credential logging.

Keep the production admin key stable while invitations are being joined. Rotation immediately changes admin access, while already-issued participant tokens still work from their stored hashes. An unfinished registration retry whose token cannot be rederived after key rotation must not create a duplicate automatically; contact the administrator with the saved recovery code or start a deliberately new identity only if no prior one is recoverable.

Rate-limit rows can be deleted after their minute has expired using a reviewed maintenance query; do not delete mutation receipts during active UAT, since a refreshed client may retry an old operation. For this temporary workload, retained receipts are deliberately favored over ambiguous retry behaviour.

## Troubleshooting

| Symptom                        | Check / action                                                                                                                                                                          |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CORS / failed fetch            | Exact Pages origin (no project path) in `ALLOWED_ORIGINS`; redeploy Worker. Check `API_BASE_URL`, HTTPS and exact CSP Worker origin. OPTIONS must allow Authorization and Content-Type. |
| 401                            | Enter correct admin key or full participant recovery code. A join code is not a participant/admin bearer token. Pending edits are retained.                                             |
| 403                            | Check closed session, assignment, or denied origin. Reopen session in admin if appropriate, then Retry.                                                                                 |
| 409                            | Preserve both versions. Choose which result to retain. Never clear browser storage to fix a conflict. Reusing a mutation ID with a different payload is invalid.                        |
| 422                            | Check comment (trimmed 2+ characters for Fail/Partial), name/initial/team, custom IDs, or version fields.                                                                               |
| 429                            | Wait one minute, then Retry. Repeated campus joins may share an IP. Avoid repeated clicks.                                                                                              |
| 503                            | Provision `ADMIN_API_KEY` at least 32 characters long; verify the deployed Worker environment.                                                                                          |
| 500 / schema mismatch          | Apply migrations to the database bound as `DB`; verify correct UUID and seed, inspect sanitized Worker logs. Do not reset results.                                                      |
| D1 quota / availability        | Check account limits and Cloudflare status. Keep local pending edits; wait, then Retry. Never mark them confirmed manually.                                                             |
| Pages 404 / assets fail        | Use Actions source, confirm workflow success, retain trailing project slash and relative asset URLs; verify repo access/Pages eligibility for the organization's plan.                  |
| Browser storage denied         | Keep tab open, copy pending comments/recovery code, wait for confirmation. Use a trusted browser/profile that allows storage.                                                           |
| Local browser test won't start | Free ports 8080/8787; install Chromium with Playwright, or set `CHROMIUM_EXECUTABLE`. Production config is overridden only in the browser test fixture.                                 |
