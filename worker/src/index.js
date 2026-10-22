import { resultError, QUICK } from "./validation.js";
const enc = new TextEncoder();
const hash = async (s) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)))]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
const random = () =>
  [...crypto.getRandomValues(new Uint8Array(32))]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
function fail(status, code, message, extra = {}) {
  throw Object.assign(Error(message), { status, code, ...extra });
}
const json = (data, status = 200) =>
  new Response(JSON.stringify({ ok: true, ...data }), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
async function body(req) {
  if (!req.headers.get("content-type")?.includes("application/json"))
    fail(415, "CONTENT_TYPE", "Use application/json");
  const reader = req.body?.getReader();
  let size = 0,
    parts = [];
  if (!reader) fail(400, "JSON", "Missing JSON");
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 16384) {
      await reader.cancel();
      fail(413, "SIZE", "Request too large");
    }
    parts.push(value);
  }
  try {
    const parsed = JSON.parse(
      new TextDecoder().decode(new Uint8Array(parts.flatMap((p) => [...p]))),
    );
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      fail(400, "JSON", "Expected a JSON object");
    return parsed;
  } catch {
    fail(400, "JSON", "Invalid JSON object");
  }
}
const stmt = (env, sql, ...args) => env.DB.prepare(sql).bind(...args);
async function limit(env, key, max) {
  const window = Math.floor(Date.now() / 60000);
  const r = await stmt(
    env,
    "INSERT INTO rate_limits(key,window,count) VALUES(?,?,1) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN window=excluded.window THEN count+1 ELSE 1 END,window=excluded.window RETURNING count",
    key,
    window,
  ).first();
  if (r.count > max)
    fail(429, "RATE_LIMIT", "Too many requests. Retry in a minute.");
}
async function auth(req, env, admin = false) {
  const token = req.headers.get("Authorization")?.match(/^Bearer (\S+)$/)?.[1];
  if (!token) fail(401, "UNAUTHORIZED", "A bearer token is required");
  if (admin) {
    if (!env.ADMIN_API_KEY || env.ADMIN_API_KEY.length < 32)
      fail(503, "CONFIG", "Admin authentication is not configured");
    const a = await hash(token),
      b = await hash(env.ADMIN_API_KEY);
    let diff = 0;
    for (let i = 0; i < a.length; i++)
      diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    if (diff) fail(401, "UNAUTHORIZED", "Invalid admin key");
    return;
  }
  const p = await stmt(
    env,
    "SELECT p.*,s.active,s.name AS session_name,s.mode FROM participants p JOIN sessions s ON s.id=p.session_id WHERE token_hash=?",
    await hash(token),
  ).first();
  if (!p) fail(401, "UNAUTHORIZED", "Invalid recovery code");
  return p;
}
const profile = (p) => ({
  id: p.id,
  session_id: p.session_id,
  first_name: p.first_name,
  last_initial: p.last_initial,
  team: p.team,
  session_name: p.session_name,
  active: p.active,
  mode: p.mode,
});
function filters(url) {
  let clauses = [],
    args = [];
  for (const [param, col] of Object.entries({
    session: "r.session_id",
    team: "p.team",
    category: "t.category",
    priority: "t.priority",
    test: "r.test_id",
    status: "r.status",
  })) {
    const v = url.searchParams.get(param);
    if (v) {
      clauses.push(col + "=?");
      args.push(v);
    }
  }
  if (url.searchParams.get("issues") === "1")
    clauses.push("r.status IN ('fail','partial_pass')");
  const q = url.searchParams.get("q");
  if (q) {
    clauses.push(
      "(instr(lower(r.comment),lower(?))>0 OR instr(lower(t.title),lower(?))>0 OR instr(lower(p.first_name || ' ' || p.last_initial),lower(?))>0 OR instr(lower(r.test_id),lower(?))>0)",
    );
    args.push(q, q, q, q);
  }
  return {
    where: clauses.length ? " WHERE " + clauses.join(" AND ") : "",
    args,
  };
}
const joins =
  " FROM results r JOIN participants p ON p.id=r.participant_id JOIN sessions s ON s.id=r.session_id JOIN test_cases t ON t.id=r.test_id";
const columns =
  "r.*,p.first_name,p.last_initial,p.team,s.name AS session_name,t.title,t.category,t.priority";
export function csvCell(v) {
  let s = String(v ?? "");
  if (/^\s*[=+\-@\t\r\n]/u.test(s) || /^[\t\r\n]/.test(s)) s = "'" + s;
  return '"' + s.replaceAll('"', '""') + '"';
}
async function route(req, env, url) {
  const path = url.pathname,
    method = req.method;
  if (path === "/api/health" && method === "GET") return json({ alive: true });
  if (path === "/api/config" && method === "GET")
    return json({
      teams: (env.TEAMS || "Other")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    });
  if (path === "/api/join" && method === "POST") {
    await limit(
      env,
      "join:" + (req.headers.get("CF-Connecting-IP") || "local"),
      30,
    );
    const b = await body(req);
    for (const key of [
      "sessionCode",
      "firstName",
      "lastInitial",
      "team",
      "registrationKey",
    ])
      if (typeof b[key] !== "string") fail(422, "VALIDATION", "Missing " + key);
    const name = b.firstName.trim(),
      initial = b.lastInitial.trim().toUpperCase(),
      team = b.team.trim();
    if (
      !/^[\p{L}\p{M}][\p{L}\p{M} '\-]{0,39}$/u.test(name) ||
      !/^\p{L}$/u.test(initial) ||
      !(env.TEAMS || "Other")
        .split(",")
        .map((s) => s.trim())
        .includes(team)
    )
      fail(
        422,
        "VALIDATION",
        "Check name, single last initial and configured team",
      );
    if (
      !/^[a-f0-9]{64}$/.test(b.registrationKey) ||
      !/^[a-f0-9]{64}$/.test(b.sessionCode.trim())
    )
      fail(422, "VALIDATION", "Invalid join code or registration key");
    const s = await stmt(
      env,
      "SELECT * FROM sessions WHERE join_code_hash=?",
      await hash(b.sessionCode.trim()),
    ).first();
    if (!s || !s.active) fail(403, "SESSION", "Invalid or closed session");
    // Deterministic 256-bit token keyed by the admin secret permits exact registration retries without storing raw recovery tokens.
    if (!env.ADMIN_API_KEY || env.ADMIN_API_KEY.length < 32)
      fail(503, "CONFIG", "Authentication is not configured");
    const key = await crypto.subtle.importKey(
      "raw",
      enc.encode(env.ADMIN_API_KEY),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const token = [
      ...new Uint8Array(
        await crypto.subtle.sign(
          "HMAC",
          key,
          enc.encode(s.id + ":" + b.registrationKey),
        ),
      ),
    ]
      .map((x) => x.toString(16).padStart(2, "0"))
      .join("");
    const registrationHash = await hash(s.id + ":" + b.registrationKey),
      tokenHash = await hash(token);
    await stmt(
      env,
      "INSERT INTO participants(id,session_id,first_name,last_initial,team,token_hash,registration_hash) VALUES(?,?,?,?,?,?,?) ON CONFLICT(registration_hash) DO NOTHING",
      crypto.randomUUID(),
      s.id,
      name,
      initial,
      team,
      tokenHash,
      registrationHash,
    ).run();
    const p = await stmt(
      env,
      "SELECT p.*,s.name AS session_name,s.active,s.mode FROM participants p JOIN sessions s ON s.id=p.session_id WHERE registration_hash=?",
      registrationHash,
    ).first();
    if (p.token_hash !== tokenHash)
      fail(
        409,
        "REGISTRATION_ROTATED",
        "Registration key predates an admin key rotation. Use your saved recovery code or contact the administrator.",
      );
    if (p.first_name !== name || p.last_initial !== initial || p.team !== team)
      fail(
        409,
        "REGISTRATION",
        "Registration key already used for different details",
      );
    return json({ participant: profile(p), recoveryToken: token });
  }
  if (path.startsWith("/api/admin/")) {
    await limit(
      env,
      "admin:" + (req.headers.get("CF-Connecting-IP") || "local"),
      240,
    );
    await auth(req, env, true);
    if (path === "/api/admin/sessions" && method === "GET")
      return json({
        sessions: (
          await stmt(
            env,
            "SELECT id,name,created_at,active,mode,(SELECT count(*) FROM session_tests WHERE session_id=s.id) AS assigned FROM sessions s ORDER BY created_at DESC",
          ).all()
        ).results,
      });
    if (path === "/api/admin/sessions" && method === "POST") {
      const b = await body(req);
      if (
        typeof b.name !== "string" ||
        !b.name.trim() ||
        b.name.trim().length > 100 ||
        !["QUICK", "CORE", "ALL", "CUSTOM"].includes(b.mode)
      )
        fail(422, "VALIDATION", "Provide a name and valid assignment mode");
      const all = (
        await stmt(
          env,
          "SELECT id,tier FROM test_cases WHERE active=1 ORDER BY sort_order",
        ).all()
      ).results;
      let ids =
        b.mode === "QUICK"
          ? QUICK
          : b.mode === "CORE"
            ? all.filter((r) => r.tier === "Core").map((r) => r.id)
            : b.mode === "ALL"
              ? all.map((r) => r.id)
              : b.testIds;
      if (
        !Array.isArray(ids) ||
        !ids.length ||
        ids.length > 215 ||
        new Set(ids).size !== ids.length ||
        ids.some((id) => !all.some((t) => t.id === id))
      )
        fail(422, "VALIDATION", "Use unique existing test IDs");
      const id = crypto.randomUUID(),
        code = random();
      await env.DB.batch([
        stmt(
          env,
          "INSERT INTO sessions(id,name,join_code_hash,mode) VALUES(?,?,?,?)",
          id,
          b.name.trim(),
          await hash(code),
          b.mode,
        ),
        ...ids.map((t, i) =>
          stmt(env, "INSERT INTO session_tests VALUES(?,?,?)", id, t, i),
        ),
      ]);
      return json({ id, joinCode: code, assigned: ids.length }, 201);
    }
    const match = path.match(/^\/api\/admin\/sessions\/([\w-]+)$/);
    if (match && method === "PATCH") {
      const b = await body(req);
      if (typeof b.active !== "boolean")
        fail(422, "VALIDATION", "active must be boolean");
      const r = await stmt(
        env,
        "UPDATE sessions SET active=? WHERE id=? RETURNING id",
        Number(b.active),
        match[1],
      ).first();
      if (!r) fail(404, "NOT_FOUND", "Session not found");
      return json({ id: r.id });
    }
    if (
      [
        "/api/admin/results",
        "/api/admin/export.csv",
        "/api/admin/summary",
      ].includes(path) &&
      method === "GET"
    ) {
      const { where, args } = filters(url);
      if (path.endsWith("summary")) {
        const rows = (
          await stmt(env, "SELECT " + columns + joins + where, ...args).all()
        ).results;
        // Expected executions are the participant x assigned-test population with the same session/team/catalogue filters; outcome/search filters only affect recorded rows.
        const clauses = [],
          a = [];
        for (const [param, col] of Object.entries({
          session: "p.session_id",
          team: "p.team",
          category: "t.category",
          priority: "t.priority",
          test: "t.id",
        })) {
          const v = url.searchParams.get(param);
          if (v) {
            clauses.push(col + "=?");
            a.push(v);
          }
        }
        const population = (
          await stmt(
            env,
            "SELECT p.id,p.first_name,p.last_initial,p.team,p.session_id,t.id AS test_id,t.title,t.category FROM participants p JOIN session_tests st ON st.session_id=p.session_id JOIN test_cases t ON t.id=st.test_id" +
              (clauses.length ? " WHERE " + clauses.join(" AND ") : ""),
            ...a,
          ).all()
        ).results;
        const baseUrl = new URL(url);
        for (const k of ["status", "issues", "q"])
          baseUrl.searchParams.delete(k);
        const f = filters(baseUrl);
        const confirmed = (
          await stmt(env, "SELECT r.*" + joins + f.where, ...f.args).all()
        ).results;
        const counts = { pass: 0, partial_pass: 0, fail: 0, skipped: 0 };
        for (const r of rows) counts[r.status]++;
        const last = (
          await stmt(
            env,
            "SELECT p.id,p.first_name,p.last_initial,p.team,p.session_id,MAX(r.updated_at) AS last_submission FROM participants p LEFT JOIN results r ON r.participant_id=p.id GROUP BY p.id",
          ).all()
        ).results.filter((p) => population.some((x) => x.id === p.id));
        const assignmentClauses = [],
          assignmentArgs = [];
        for (const [param, col] of Object.entries({
          session: "st.session_id",
          category: "t.category",
          priority: "t.priority",
          test: "t.id",
        })) {
          const v = url.searchParams.get(param);
          if (v) {
            assignmentClauses.push(col + "=?");
            assignmentArgs.push(v);
          }
        }
        const assignments = (
          await stmt(
            env,
            "SELECT st.session_id,t.id AS test_id,t.title,t.category FROM session_tests st JOIN test_cases t ON t.id=st.test_id" +
              (assignmentClauses.length
                ? " WHERE " + assignmentClauses.join(" AND ")
                : ""),
            ...assignmentArgs,
          ).all()
        ).results;
        const covered = new Set(confirmed.map((r) => r.test_id));
        const unseen = [
          ...new Map(
            assignments
              .filter((p) => !covered.has(p.test_id))
              .map((p) => [
                p.test_id,
                { id: p.test_id, title: p.title, category: p.category },
              ]),
          ).values(),
        ];
        const recurring = [
          ...new Set(
            rows
              .filter((r) => ["fail", "partial_pass"].includes(r.status))
              .map((r) => r.test_id),
          ),
        ]
          .map((id) => ({
            test_id: id,
            teams: [
              ...new Set(
                rows
                  .filter(
                    (r) =>
                      r.test_id === id &&
                      ["fail", "partial_pass"].includes(r.status),
                  )
                  .map((r) => r.team),
              ),
            ],
            count: rows.filter(
              (r) =>
                r.test_id === id && ["fail", "partial_pass"].includes(r.status),
            ).length,
          }))
          .sort((a, b) => b.count - a.count);
        return json({
          summary: {
            participants: new Set(population.map((r) => r.id)).size,
            assignedTests: assignments.length,
            expected: population.length,
            confirmed: confirmed.length,
            filteredResults: rows.length,
            outstanding: population.length - confirmed.length,
            counts,
            completion: population.length
              ? confirmed.length / population.length
              : 0,
            passRate:
              counts.pass + counts.partial_pass + counts.fail
                ? counts.pass /
                  (counts.pass + counts.partial_pass + counts.fail)
                : null,
            lastSubmissions: last,
            unexecuted: unseen,
            recurring,
          },
        });
      }
      if (path.endsWith(".csv")) {
        const rows = (
          await stmt(
            env,
            "SELECT " + columns + joins + where + " ORDER BY r.updated_at DESC",
            ...args,
          ).all()
        ).results;
        const keys = [
          "session_name",
          "first_name",
          "last_initial",
          "team",
          "test_id",
          "title",
          "category",
          "priority",
          "status",
          "comment",
          "updated_at",
        ];
        return new Response(
          "\uFEFF" +
            [
              keys.map(csvCell).join(","),
              ...rows.map((r) => keys.map((k) => csvCell(r[k])).join(",")),
            ].join("\r\n"),
          {
            headers: {
              "Content-Type": "text/csv; charset=utf-8",
              "Content-Disposition":
                'attachment; filename="halo-uat-results.csv"',
            },
          },
        );
      }
      const page = Math.max(1, Number(url.searchParams.get("page")) || 1),
        size = Math.min(
          100,
          Math.max(1, Number(url.searchParams.get("size")) || 50),
        );
      if (!Number.isInteger(page) || !Number.isInteger(size))
        fail(422, "VALIDATION", "Invalid pagination");
      const sort =
        url.searchParams.get("sort") === "newest"
          ? "r.updated_at DESC"
          : "CASE r.status WHEN 'fail' THEN 0 WHEN 'partial_pass' THEN 1 ELSE 2 END,r.updated_at DESC";
      return json({
        rows: (
          await stmt(
            env,
            "SELECT " +
              columns +
              joins +
              where +
              " ORDER BY " +
              sort +
              " LIMIT ? OFFSET ?",
            ...args,
            size,
            (page - 1) * size,
          ).all()
        ).results,
        total: (
          await stmt(
            env,
            "SELECT count(*) AS n" + joins + where,
            ...args,
          ).first()
        ).n,
        page,
        size,
      });
    }
    fail(404, "NOT_FOUND", "Unknown admin route");
  }
  const p = await auth(req, env);
  await limit(env, "participant:" + p.id, 180);
  if (path === "/api/me" && method === "GET") {
    await stmt(
      env,
      "UPDATE participants SET last_seen_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?",
      p.id,
    ).run();
    return json({ participant: profile(p) });
  }
  if (path === "/api/tests" && method === "GET")
    return json({
      tests: (
        await stmt(
          env,
          "SELECT t.* FROM session_tests st JOIN test_cases t ON t.id=st.test_id WHERE st.session_id=? ORDER BY st.position",
          p.session_id,
        ).all()
      ).results,
    });
  if (path === "/api/results" && method === "GET")
    return json({
      results: (
        await stmt(
          env,
          "SELECT test_id,status,comment,version,updated_at FROM results WHERE participant_id=?",
          p.id,
        ).all()
      ).results,
    });
  const m = path.match(/^\/api\/results\/([A-Z]\d{2})$/);
  if (m && method === "PUT") {
    const b = await body(req),
      comment = typeof b.comment === "string" ? b.comment.trim() : b.comment;
    const err = resultError(b.status, comment);
    if (err) fail(422, "VALIDATION", err);
    if (
      !Number.isSafeInteger(b.expectedVersion) ||
      b.expectedVersion < 0 ||
      typeof b.mutationId !== "string" ||
      !/^[a-f0-9-]{36}$/.test(b.mutationId)
    )
      fail(422, "VALIDATION", "Invalid revision or mutation ID");
    const payload = {
      testId: m[1],
      status: b.status,
      comment,
      expectedVersion: b.expectedVersion,
    };
    const receipt = await stmt(
      env,
      "SELECT payload,result FROM mutation_receipts WHERE participant_id=? AND mutation_id=?",
      p.id,
      b.mutationId,
    ).first();
    if (receipt) {
      if (
        JSON.stringify(JSON.parse(receipt.payload)) !== JSON.stringify(payload)
      )
        fail(
          409,
          "MUTATION_REUSE",
          "Mutation ID reused with different content",
        );
      return json({ result: JSON.parse(receipt.result), replayed: true });
    }
    if (!p.active)
      fail(
        403,
        "CLOSED",
        "This session is closed. Pending edits are retained.",
      );
    if (
      !(await stmt(
        env,
        "SELECT 1 FROM session_tests WHERE session_id=? AND test_id=?",
        p.session_id,
        m[1],
      ).first())
    )
      fail(403, "ASSIGNMENT", "Test is not assigned");
    // Active-state predicate and revision check execute in the same SQLite statement. Receipt trigger commits atomically with the result.
    let r;
    try {
      r = await stmt(
        env,
        `INSERT INTO results(session_id,participant_id,test_id,status,comment,version,last_mutation_id) SELECT ?,?,?,?,?,1,? WHERE ?=0 AND EXISTS(SELECT 1 FROM sessions WHERE id=? AND active=1) ON CONFLICT(session_id,participant_id,test_id) DO UPDATE SET status=excluded.status,comment=excluded.comment,version=results.version+1,last_mutation_id=excluded.last_mutation_id,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE results.version=? AND EXISTS(SELECT 1 FROM sessions WHERE id=? AND active=1) RETURNING test_id,status,comment,version,updated_at`,
        p.session_id,
        p.id,
        m[1],
        b.status,
        comment,
        b.mutationId,
        b.expectedVersion,
        p.session_id,
        b.expectedVersion,
        p.session_id,
      ).first();
      // For updates, SQLite requires an input row even with expectedVersion > 0. Separate conditional update below.
      if (!r && b.expectedVersion > 0)
        r = await stmt(
          env,
          `UPDATE results SET status=?,comment=?,version=version+1,last_mutation_id=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE session_id=? AND participant_id=? AND test_id=? AND version=? AND EXISTS(SELECT 1 FROM sessions WHERE id=? AND active=1) RETURNING test_id,status,comment,version,updated_at`,
          b.status,
          comment,
          b.mutationId,
          p.session_id,
          p.id,
          m[1],
          b.expectedVersion,
          p.session_id,
        ).first();
    } catch (e) {
      const existing = await stmt(
        env,
        "SELECT payload,result FROM mutation_receipts WHERE participant_id=? AND mutation_id=?",
        p.id,
        b.mutationId,
      ).first();
      if (existing) {
        if (
          JSON.stringify(JSON.parse(existing.payload)) ===
          JSON.stringify(payload)
        )
          return json({ result: JSON.parse(existing.result), replayed: true });
        fail(
          409,
          "MUTATION_REUSE",
          "Mutation ID reused with different content",
        );
      }
      throw e;
    }
    if (!r) {
      const existing = await stmt(
        env,
        "SELECT payload,result FROM mutation_receipts WHERE participant_id=? AND mutation_id=?",
        p.id,
        b.mutationId,
      ).first();
      if (
        existing &&
        JSON.stringify(JSON.parse(existing.payload)) === JSON.stringify(payload)
      )
        return json({ result: JSON.parse(existing.result), replayed: true });
      const current = await stmt(
        env,
        "SELECT test_id,status,comment,version,updated_at FROM results WHERE participant_id=? AND test_id=?",
        p.id,
        m[1],
      ).first();
      fail(409, "CONFLICT", "A newer revision exists. Review both versions.", {
        current,
      });
    }
    return json({ result: r });
  }
  fail(404, "NOT_FOUND", "Route not found");
}
export default {
  async fetch(req, env) {
    const origin = req.headers.get("Origin"),
      allowed = (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim());
    let response;
    try {
      if (origin && !allowed.includes(origin))
        fail(403, "ORIGIN", "Origin is not allowed");
      if (req.method === "OPTIONS")
        response = new Response(null, { status: 204 });
      else response = await route(req, env, new URL(req.url));
    } catch (e) {
      response = new Response(
        JSON.stringify({
          ok: false,
          error: {
            code: e.code || "INTERNAL",
            message: e.status
              ? e.message
              : "The server could not complete the request. Retry.",
            ...(e.current !== undefined ? { current: e.current } : {}),
          },
        }),
        {
          status: e.status || 500,
          headers: { "Content-Type": "application/json" },
        },
      );
      if (!e.status) console.error("Worker request failed", e.message);
    }
    const h = new Headers(response.headers);
    h.set("Cache-Control", "no-store");
    h.set("Vary", "Origin");
    h.set("X-Content-Type-Options", "nosniff");
    if (origin && allowed.includes(origin)) {
      h.set("Access-Control-Allow-Origin", origin);
      h.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
      h.set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, OPTIONS");
    }
    return new Response(response.body, { status: response.status, headers: h });
  },
};
