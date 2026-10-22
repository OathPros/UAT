# Worker API

All paths are relative to the configured HTTPS Worker origin. JSON success envelopes contain `ok: true`; errors contain `ok: false, error: {code, message}`. Requests with bodies require `Content-Type: application/json`, an object and at most 16 KiB. No endpoint accepts a caller-supplied participant ID to choose whose results to read/write. HTTP errors include CORS headers only for configured origins. API responses are `Cache-Control: no-store`.

## Public

| Method / path     | Input / output                                                                              |
| ----------------- | ------------------------------------------------------------------------------------------- |
| `GET /api/health` | `{ok:true,alive:true}` only.                                                                |
| `GET /api/config` | `{ok:true,teams:[...]}` public join-team options.                                           |
| `POST /api/join`  | `{sessionCode,firstName,lastInitial,team,registrationKey}` → `{participant,recoveryToken}`. |

`sessionCode` is the private admin-generated 64-character lowercase hex invitation. `registrationKey` is a client-generated random 256-bit value encoded as 64 lowercase hex characters. Persist it **before** issuing the first join; retry identical details with the same key until entry is confirmed. Generate a fresh key only after successful entry or an explicit decision to create a different identity. It must not be a name-derived value. Retrying a committed join returns the same profile and bearer recovery token. The join must still be active. Missing/incorrect invitation does not reveal whether a name already exists.

Names are trimmed, begin with a Unicode letter/mark, and contain letters/marks, spaces, apostrophes or hyphens, maximum 40 UTF-16 code units. Last initial is one Unicode letter (uppercased). Team must match an exact configured team. Name/initial/team are labels, never authentication.

## Participant: `Authorization: Bearer <recoveryToken>`

| Method / path              | Output                                                                                                          |
| -------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `GET /api/me`              | `participant` with `id,session_id,first_name,last_initial,team,session_name,active,mode`. No credential hashes. |
| `GET /api/tests`           | `tests` assignment snapshot ordered by position, containing canonical fields and sort metadata.                 |
| `GET /api/results`         | `results` own confirmed records: `test_id,status,comment,version,updated_at`.                                   |
| `PUT /api/results/:testId` | Input below; returns `result`, optionally `replayed:true`.                                                      |

Mutation body:

```json
{
  "status": "partial_pass",
  "comment": "The search filter missed a relevant article.",
  "expectedVersion": 0,
  "mutationId": "a-new-UUID-for-each-logical-mutation"
}
```

Use an actual UUID from `crypto.randomUUID()`; the explanatory string above is not a valid mutation ID. `expectedVersion:0` means no existing row; otherwise use the last server-acknowledged revision. Comments are trimmed, at most 3,000 UTF-16 code units and at least two characters for `fail`/`partial_pass`. Valid statuses: `pass,partial_pass,fail,skipped`. Next without an answer does not call this endpoint.

A save acknowledgement contains `test_id,status,comment,version,updated_at`. A trigger stores this original acknowledgement atomically with its result. Keep the identical mutation ID and body across ambiguous retries. A retry after a later edit returns the original acknowledgement, not a new write; the client must never regress its known version. A stale version returns `409 CONFLICT` with `error.current` containing the latest server row (or null). Preserve pending local work and ask which revision to retain before creating a new mutation. Reusing an ID with a different payload returns `409 MUTATION_REUSE`.

## Administrator: `Authorization: Bearer <ADMIN_API_KEY>`

| Method / path                   | Contract                                                                                                                                                                                           |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/admin/sessions`       | `sessions` including `id,name,created_at,active,mode,assigned`; never join codes/hashes.                                                                                                           |
| `POST /api/admin/sessions`      | `{name,mode,testIds?}` → `201 {id,joinCode,assigned}`. Mode `QUICK,CORE,ALL,CUSTOM`; custom is 1–215 unique existing IDs in desired order. Join code returned once. Name 1–100 trimmed characters. |
| `PATCH /api/admin/sessions/:id` | `{active:boolean}` closes/reopens, preserving results.                                                                                                                                             |
| `GET /api/admin/results`        | `{rows,total,page,size}`; default page 1, size 50, maximum 100.                                                                                                                                    |
| `GET /api/admin/summary`        | `summary` metrics, recurring issues/teams, unexecuted cases and last submissions.                                                                                                                  |
| `GET /api/admin/export.csv`     | Full filtered CSV attachment, UTF-8 BOM/CRLF, all cells quoted and formula-neutralized. No page limit.                                                                                             |

Reporting filters: `session` exact session ID, `team`, `category`, `priority`, `test` exact test ID, `status`, `q` case-insensitive literal substring across comment/test ID/title/participant name. `issues=1` restricts to Fail and Partial. `sort=newest` orders by update time; otherwise issues come first. Results also accept `page,size`. The UI issues-only export clears the status selector before applying `issues=1`.

`summary` includes `participants,assignedTests,expected,confirmed,filteredResults,outstanding,counts,completion,passRate,lastSubmissions,unexecuted,recurring`. `assignedTests` counts explicit assignments over the selected sessions/catalogue; `expected` counts the participant × assigned-case population for selected session/team/catalogue. `confirmed` and `outstanding` use that population, independent of status/text filters. `counts`, `filteredResults`, `recurring` and pass rate include status/text filters. Completion and pass rate are fractions; pass rate is null with no Pass/Partial/Fail denominator. Last submissions show all selected participants, including those without results. Unexecuted cases are selected assigned cases with zero results for selected participants, independent of outcome/text filters.

Typical errors: `400 JSON`, `401 UNAUTHORIZED`, `403 ORIGIN/SESSION/CLOSED/ASSIGNMENT`, `404 NOT_FOUND`, `409 CONFLICT/MUTATION_REUSE/REGISTRATION`, `413 SIZE`, `415 CONTENT_TYPE`, `422 VALIDATION`, `429 RATE_LIMIT`, `503 CONFIG`. Unexpected errors return sanitized `500 INTERNAL`. Registration throttling is 30/IP/minute; participant routes are 180/identity/minute; admin routes 240/IP/minute. There are no destructive reset or anonymous participant-discovery endpoints.
