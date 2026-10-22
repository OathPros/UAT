import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { sql } from "../../scripts/seed-tests.js";
import { QUICK } from "../src/validation.js";
const admin = crypto.randomUUID() + crypto.randomUUID();
let mf, db;
before(async () => {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: ["index.js", "validation.js"].map((file) => ({
        type: "ESModule",
        path: new URL("../src/" + file, import.meta.url).pathname,
      })),
      compatibilityDate: "2025-10-11",
      d1Databases: ["DB"],
      bindings: {
        ADMIN_API_KEY: admin,
        ALLOWED_ORIGINS: "http://localhost:8080",
        TEAMS: "UIT,Other",
      },
      cf: false,
    }),
  );
  db = await mf.getD1Database("DB");
  await db.exec(
    fs.readFileSync(
      new URL("../migrations/0001_init.sql", import.meta.url),
      "utf8",
    ),
  );
  await db.exec(sql);
});
after(async () => {
  await mf?.dispose();
});
let requests = 0;
async function call(
  path,
  { token, method = "GET", body, origin, ...rest } = {},
) {
  const r = await mf.dispatchFetch("http://local" + path, {
    method,
    headers: {
      "CF-Connecting-IP": "test-" + ++requests,
      ...(origin ? { Origin: origin } : {}),
      ...(token ? { Authorization: "Bearer " + token } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    ...rest,
  });
  const text = await r.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: r.status, headers: r.headers, data };
}
async function session(mode = "QUICK", testIds) {
  const r = await call("/api/admin/sessions", {
    token: admin,
    method: "POST",
    body: { name: "Round " + crypto.randomUUID(), mode, testIds },
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data;
}
async function join(code, extra = {}) {
  const body = {
    sessionCode: code,
    firstName: "Alex",
    lastInitial: "C",
    team: "UIT",
    registrationKey:
      crypto.randomUUID().replaceAll("-", "") +
      crypto.randomUUID().replaceAll("-", ""),
    ...extra,
  };
  const r = await call("/api/join", { method: "POST", body });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return { ...r.data, body };
}
async function save(
  token,
  id,
  status = "pass",
  comment = "",
  expectedVersion = 0,
  mutationId = crypto.randomUUID(),
) {
  return call("/api/results/" + id, {
    token,
    method: "PUT",
    body: { status, comment, expectedVersion, mutationId },
  });
}
test("canonical seed is idempotent and preserves all 215 definitions", async () => {
  await db.exec(sql);
  const rows = (
    await db.prepare("SELECT * FROM test_cases ORDER BY sort_order").all()
  ).results;
  const canonical = JSON.parse(
    fs.readFileSync(new URL("../../data/tests.json", import.meta.url)),
  );
  assert.equal(rows.length, 215);
  assert.deepEqual(
    rows.map(({ id, category, tier, priority, title, expected_result }) => ({
      id,
      category,
      tier,
      priority,
      title,
      expected_result,
    })),
    canonical,
  );
});
test("all assignment modes preserve exact count/order; invalid custom rejected", async () => {
  for (const [mode, ids, count] of [
    ["QUICK", QUICK, 32],
    ["CORE", null, 151],
    ["ALL", null, 215],
    ["CUSTOM", ["B03", "A01"], 2],
  ]) {
    const s = await session(mode, ids);
    assert.equal(s.assigned, count);
    const p = await join(s.joinCode);
    const tests = (await call("/api/tests", { token: p.recoveryToken })).data
      .tests;
    assert.equal(tests.length, count);
    if (ids)
      assert.deepEqual(
        tests.map((t) => t.id),
        ids,
      );
  }
  assert.equal(
    (
      await call("/api/admin/sessions", {
        token: admin,
        method: "POST",
        body: { name: "Bad", mode: "CUSTOM", testIds: ["Z99"] },
      })
    ).status,
    422,
  );
});
test("join retry and recovery preserve identity, only hashed tokens stored", async () => {
  const s = await session();
  const p = await join(s.joinCode);
  const again = await call("/api/join", { method: "POST", body: p.body });
  assert.equal(again.data.participant.id, p.participant.id);
  assert.equal(again.data.recoveryToken, p.recoveryToken);
  const me = await call("/api/me", { token: p.recoveryToken });
  assert.equal(me.data.participant.id, p.participant.id);
  assert.equal(
    (
      await db
        .prepare("SELECT count(*) n FROM participants WHERE session_id=?")
        .bind(s.id)
        .first()
    ).n,
    1,
  );
  const row = await db
    .prepare("SELECT token_hash FROM participants WHERE id=?")
    .bind(p.participant.id)
    .first();
  assert.notEqual(row.token_hash, p.recoveryToken);
  assert.equal(p.recoveryToken.length, 64);
  assert.equal(
    (
      await call("/api/join", {
        method: "POST",
        body: { ...p.body, registrationKey: "bad" },
      })
    ).status,
    422,
  );
});
test("invalid comments, statuses, revisions, membership, closed sessions and auth are rejected", async () => {
  const s = await session("CUSTOM", ["A01"]);
  const p = await join(s.joinCode);
  for (const status of ["fail", "partial_pass"])
    assert.equal(
      (await save(p.recoveryToken, "A01", status, " a ")).status,
      422,
    );
  assert.equal((await save(p.recoveryToken, "A01", "bad")).status, 422);
  assert.equal(
    (await save(p.recoveryToken, "A01", "pass", "x".repeat(3001))).status,
    422,
  );
  assert.equal(
    (await save(p.recoveryToken, "A01", "pass", "", -1)).status,
    422,
  );
  assert.equal((await save(p.recoveryToken, "A02")).status, 403);
  assert.equal((await save(null, "A01")).status, 401);
  assert.equal((await call("/api/results", { token: "wrong" })).status, 401);
  assert.equal(
    (await call("/api/results", { token: p.recoveryToken })).data.results
      .length,
    0,
  );
  await call("/api/admin/sessions/" + s.id, {
    token: admin,
    method: "PATCH",
    body: { active: false },
  });
  assert.equal((await save(p.recoveryToken, "A01")).status, 403);
  assert.equal(
    (await call("/api/join", { method: "POST", body: p.body })).status,
    403,
  );
  await call("/api/admin/sessions/" + s.id, {
    token: admin,
    method: "PATCH",
    body: { active: true },
  });
  assert.equal((await save(p.recoveryToken, "A01", "skipped")).status, 200);
});
test("idempotent receipts survive newer updates; stale and reused mutations conflict", async () => {
  const s = await session();
  const p = await join(s.joinCode),
    t = p.recoveryToken,
    m = crypto.randomUUID();
  const first = await save(t, "A01", "pass", "", 0, m);
  assert.equal(first.status, 200, JSON.stringify(first.data));
  const second = await save(t, "A01", "fail", "broken", 1);
  assert.equal(second.data.result.version, 2);
  assert.equal((await save(t, "A01", "pass", "", 0, m)).data.result.version, 1);
  assert.equal((await save(t, "A01", "fail", "different", 0, m)).status, 409);
  const stale = await save(t, "A01", "skipped", "", 1);
  assert.equal(stale.status, 409);
  assert.equal(stale.data.error.current.status, "fail");
  const results = (await call("/api/results", { token: t })).data.results;
  assert.equal(results.length, 1);
  assert.equal(results[0].version, 2);
  await db.exec(sql);
  assert.equal(
    (await call("/api/results", { token: t })).data.results[0].version,
    2,
  );
});
test("ten concurrent testers, overlapping writes/retries, isolation, reports and CSV reconcile", async () => {
  const started = performance.now(),
    s = await session("CUSTOM", ["A01", "A02"]);
  const users = await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      join(s.joinCode, { firstName: "Tester " + String.fromCharCode(65 + i) }),
    ),
  );
  await Promise.all(
    users.map(async (p, i) => {
      const t = p.recoveryToken,
        m = crypto.randomUUID();
      const pair = await Promise.all([
        save(t, "A01", "pass", "", 0, m),
        save(t, "A01", "pass", "", 0, m),
      ]);
      pair.forEach((r) => assert.equal(r.status, 200, JSON.stringify(r.data)));
      const race = await Promise.all([
        save(t, "A01", "fail", "Failure " + i, 1),
        save(t, "A01", "partial_pass", "Partial " + i, 1),
      ]);
      assert.equal(race.filter((r) => r.status === 200).length, 1);
      assert.equal(race.filter((r) => r.status === 409).length, 1);
      assert.equal(
        (await save(t, "A01", "partial_pass", "Final " + i, 2)).data.result
          .version,
        3,
      );
      await save(
        t,
        "A02",
        "fail",
        i === 0 ? ' =HYPERLINK("evil")' : "Issue " + i,
        0,
      );
      const own = (
        await call(
          "/api/results?participant_id=" + users[(i + 1) % 10].participant.id,
          { token: t },
        )
      ).data.results;
      assert.equal(own.length, 2);
      assert.equal(own.find((r) => r.test_id === "A01").comment, "Final " + i);
    }),
  );
  const count = await db
    .prepare("SELECT count(*) n FROM results WHERE session_id=?")
    .bind(s.id)
    .first();
  assert.equal(count.n, 20);
  const report = (
    await call("/api/admin/summary?session=" + s.id, { token: admin })
  ).data.summary;
  assert.equal(report.participants, 10);
  assert.equal(report.expected, 20);
  assert.equal(report.confirmed, 20);
  assert.equal(report.outstanding, 0);
  assert.equal(report.counts.fail, 10);
  assert.equal(report.counts.partial_pass, 10);
  assert.equal(report.completion, 1);
  assert.equal(report.passRate, 0);
  const filtered = await call(
    "/api/admin/results?session=" + s.id + "&status=fail&size=3&page=2",
    { token: admin },
  );
  assert.equal(filtered.data.rows.length, 3);
  assert.equal(filtered.data.total, 10);
  const csv = await call(
    "/api/admin/export.csv?session=" + s.id + "&issues=1",
    { token: admin },
  );
  assert.equal(csv.status, 200);
  assert.equal(csv.data.split("\r\n").length, 21);
  assert.ok(csv.data.includes("'=HYPERLINK"));
  assert.ok(csv.headers.get("content-disposition").includes(".csv"));
  console.log(
    `10-tester local D1 smoke: 20 distinct records, 30 final revisions, ${Math.round(performance.now() - started)} ms total (in-process Worker/D1, not live Cloudflare).`,
  );
});
test("all admin routes enforce auth; CORS preflight/errors and request bounds", async () => {
  for (const [path, method] of [
    ["sessions", "GET"],
    ["sessions", "POST"],
    ["summary", "GET"],
    ["results", "GET"],
    ["export.csv", "GET"],
    ["sessions/unknown", "PATCH"],
  ])
    for (const token of [null, "invalid"])
      assert.equal(
        (await call("/api/admin/" + path, { method, token })).status,
        401,
      );
  const r = await call("/api/results", { origin: "http://localhost:8080" });
  assert.equal(r.status, 401);
  assert.equal(
    r.headers.get("access-control-allow-origin"),
    "http://localhost:8080",
  );
  const pre = await call("/api/results/A01", {
    method: "OPTIONS",
    origin: "http://localhost:8080",
  });
  assert.equal(pre.status, 204);
  assert.ok(
    pre.headers.get("access-control-allow-headers").includes("Authorization"),
  );
  assert.equal(
    (await call("/api/health", { origin: "https://evil.example" })).status,
    403,
  );
  assert.equal(
    (
      await call("/api/admin/sessions", {
        method: "POST",
        token: admin,
        body: { name: "x".repeat(17000) },
      })
    ).status,
    413,
  );
});
test("CSV escapes all formula prefixes and quotes/newlines; empty assignment reporting is accurate", async () => {
  const { csvCell } = await import("../src/index.js");
  for (const text of [
    "=1",
    "+1",
    "-1",
    "@x",
    "\tfoo",
    "\rfoo",
    "\nfoo",
    "   =1",
    "  \tfoo",
  ])
    assert.ok(csvCell(text).startsWith("\"'"), text);
  assert.equal(csvCell('a,"b"\nc'), '"a,""b""\nc"');
  const s = await session("CUSTOM", ["A01", "B03"]);
  const summary = (
    await call("/api/admin/summary?session=" + s.id, { token: admin })
  ).data.summary;
  assert.equal(summary.assignedTests, 2);
  assert.equal(summary.expected, 0);
  assert.equal(summary.unexecuted.length, 2);
  assert.equal(summary.passRate, null);
});
test("join throttling uses one IP across failed guesses; no name-only recovery", async () => {
  const body = {
    sessionCode: "0".repeat(64),
    firstName: "Alex",
    lastInitial: "C",
    team: "UIT",
    registrationKey: "1".repeat(64),
  };
  for (let i = 0; i < 31; i++) {
    const r = await mf.dispatchFetch("http://local/api/join", {
      method: "POST",
      headers: {
        "CF-Connecting-IP": "fixed-guess-ip",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    assert.equal(r.status, i === 30 ? 429 : 403);
    await r.text();
  }
});
