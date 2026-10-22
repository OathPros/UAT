# Halo KB UAT — Codex handoff kit

## How to use this

1. Upload or add this entire kit to your Codex workspace/repository.
2. Give Codex this instruction verbatim:

   > Read `CODEX_TASK.md` and implement the application completely. Use `data/tests.json` as the canonical 215-test inventory and `reference/old-interface-reference.html` only for visual/UX inspiration. Target GitHub Pages for the static frontend and a Cloudflare Worker with D1 for the API/database. Implement and run the tests before declaring it complete. Produce exact deployment steps, and do not claim deployed services or successful live testing unless actually verified.

3. Ideally run Codex in a fresh repo `halo-kb-uat` (or a new branch of an existing UAT repo). Do NOT put secrets in GitHub source.
4. Expect to perform manual setup for Cloudflare access, database binding/ID, admin secret, and GitHub Pages publication unless Codex has authorized access to do those steps.
5. Do a dry run with two browsers/test identities before inviting all 10 testers.

## Provided files

- `CODEX_TASK.md`: Complete implementation, security and acceptance test specification.
- `data/tests.json`: Authoritative machine-readable 215-test seed data.
- `data/tests.csv`: Same source data in CSV, preserved from previous workbook.
- `reference/old-interface-reference.html`: Visual reference. This is obsolete Apps Script frontend code; it is NOT deployable on GitHub Pages as-is.

## Deployment acceptance gate

Do not start the UAT with ten people until: participant restore works on refresh; Pass/Fail/Partial/Skipped survive page reload and appear in admin dashboard; error/retry states do not falsely show saved results; separate users cannot see/edit each other's records; CSV export opens correctly in Excel; and a concurrent 10-user test is passed on the actual deployed Worker where feasible.

## Data privacy

Use only fictitious UAT tickets and minimal participant labels. Cloudflare D1 does not, merely by default, guarantee Canadian-region data residency or compliance with York University's data-storage requirements. Obtain any institutional approvals required before storing real institutional information.
