import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { chromium } from "@playwright/test";
import { sql } from "../../scripts/seed-tests.js";
const admin = crypto.randomUUID() + crypto.randomUUID();
let mf, server, browser, code;
const errors = [];
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
        ALLOWED_ORIGINS: "http://127.0.0.1:8080",
        TEAMS: "UIT,Other",
      },
      port: 8787,
      host: "127.0.0.1",
      cf: false,
    }),
  );
  const db = await mf.getD1Database("DB");
  await db.exec(
    await fs.readFile(
      new URL("../migrations/0001_init.sql", import.meta.url),
      "utf8",
    ),
  );
  await db.exec(sql);
  const r = await mf.dispatchFetch("http://local/api/admin/sessions", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + admin,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name: "Browser smoke", mode: "QUICK" }),
  });
  code = (await r.json()).joinCode;
  server = createServer(async (req, res) => {
    try {
      const path = new URL(req.url, "http://local").pathname;
      if (path === "/favicon.ico") {
        res.writeHead(204).end();
        return;
      }
      if (!path.startsWith("/halo-kb-uat/")) {
        res.writeHead(404).end();
        return;
      }
      const name = path.slice("/halo-kb-uat/".length) || "index.html";
      if (!/^[\w.-]+$/.test(name)) {
        res.writeHead(404).end();
        return;
      }
      let data = await fs.readFile(
        new URL("../../web/" + name, import.meta.url),
      );
      if (name === "config.js")
        data = Buffer.from(
          "export const API_BASE_URL='http://127.0.0.1:8787';",
        );
      if (name.endsWith(".html"))
        data = Buffer.from(
          data
            .toString()
            .replace(
              /connect-src [^;]+;/,
              "connect-src 'self' http://127.0.0.1:8787;",
            ),
        );
      res.setHeader(
        "Content-Type",
        name.endsWith(".js")
          ? "text/javascript"
          : name.endsWith(".css")
            ? "text/css"
            : "text/html",
      );
      res.end(data);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((r) => server.listen(8080, "127.0.0.1", r));
  const executablePath =
    process.env.CHROMIUM_EXECUTABLE ||
    (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined);
  browser = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
  });
});
after(async () => {
  await browser?.close();
  await new Promise((r) => (server ? server.close(r) : r()));
  await mf?.dispose();
});
const wait = async (page, fn) =>
  page.waitForFunction(fn, undefined, { timeout: 10000 });
test("real Chromium: project subpath, join retry, invalid navigation, durable outage/refresh, recovery and admin CSV", async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (msg) => {
    if (
      msg.type() === "error" &&
      !msg.text().includes("net::ERR_FAILED") &&
      !msg.text().includes("Failed to load resource")
    )
      errors.push(msg.text());
  });
  await page.goto("http://127.0.0.1:8080/halo-kb-uat/");
  await page.selectOption("#team", "UIT");
  await page.fill("#firstName", "Browser");
  await page.fill("#lastInitial", "T");
  await page.fill("#sessionCode", code);
  let lost = true;
  await page.route("**/api/join", async (route) => {
    if (lost) {
      lost = false;
      await route.fetch();
      await route.abort();
    } else await route.continue();
  });
  await page.click("#joinButton");
  await wait(page, () =>
    document.querySelector("#message").textContent.includes("retry"),
  );
  assert.equal(await page.isEnabled("#joinButton"), true);
  await page.click("#joinButton");
  await page.waitForSelector("#tester:visible");
  const token = await page.textContent("#newToken");
  assert.equal(token.length, 64);
  await page.click("#dismissRecovery");
  const db = await mf.getD1Database("DB");
  assert.equal(
    (await db.prepare("SELECT count(*) n FROM participants").first()).n,
    1,
  );
  const initial = await page.textContent("#testTitle");
  await page.click("[data-status=fail]");
  await page.click("#next");
  assert.equal(await page.textContent("#testTitle"), initial);
  assert.ok((await page.textContent("#validation")).includes("at least 2"));
  await page.fill("#comment", "Broken in browser");
  try {
    await page.waitForFunction(
      () => document.querySelector("#saveState").textContent === "Confirmed",
      undefined,
      { timeout: 4000 },
    );
  } catch (e) {
    console.log(
      "Browser diagnostics:",
      await page.textContent("#syncText"),
      errors,
    );
    throw e;
  }
  // Navigation remains immediate while all network mutations are blocked.
  await page.route("**/api/results/*", (route) => route.abort());
  await page.click("[data-status=partial_pass]");
  await page.fill("#comment", "Latest pending edit");
  const start = performance.now();
  await page.click("#next");
  const navigationMs = performance.now() - start;
  assert.notEqual(await page.textContent("#testTitle"), initial);
  await wait(page, () =>
    document.querySelector("#syncText").textContent.includes("Save failed"),
  );
  assert.equal(
    (
      await db
        .prepare("SELECT comment FROM results WHERE test_id='A01'")
        .first()
    ).comment,
    "Broken in browser",
  );
  await page.reload();
  await page.waitForSelector("#tester:visible");
  await wait(page, () =>
    document.querySelector("#syncText").textContent.includes("Save failed"),
  );
  assert.equal(await page.inputValue("#comment"), "Latest pending edit");
  assert.notEqual(await page.textContent("#saveState"), "Confirmed");
  await page.unroute("**/api/results/*");
  await page.click("#retrySaves");
  await wait(
    page,
    () => document.querySelector("#saveState").textContent === "Confirmed",
  );
  assert.equal(
    (
      await db
        .prepare("SELECT comment FROM results WHERE test_id='A01'")
        .first()
    ).comment,
    "Latest pending edit",
  );
  await page.click("#next");
  assert.equal(await page.textContent("#saveState"), "Not started");
  await page.click("[data-status=skipped]");
  await wait(
    page,
    () => document.querySelector("#saveState").textContent === "Confirmed",
  );
  // A new browser identity restores the original participant using only the code.
  const recoveryContext = await browser.newContext();
  const recovery = await recoveryContext.newPage();
  await recovery.goto("http://127.0.0.1:8080/halo-kb-uat/");
  await recovery.locator("summary").click();
  await recovery.fill("#recovery", token);
  await recovery.click("#restoreButton");
  await recovery.waitForSelector("#tester:visible");
  assert.equal(await recovery.inputValue("#comment"), "Latest pending edit");
  assert.equal(
    (await db.prepare("SELECT count(*) n FROM participants").first()).n,
    1,
  );
  const adminPage = await context.newPage();
  adminPage.on("pageerror", (e) => errors.push(e.message));
  await adminPage.goto("http://127.0.0.1:8080/halo-kb-uat/admin.html");
  await adminPage.fill("#adminKey", admin);
  await adminPage.click("#loginButton");
  await adminPage.waitForSelector("#dashboard:visible");
  await adminPage.waitForSelector("#rows tr td");
  assert.ok(
    (await adminPage.textContent("#rows")).includes("Latest pending edit"),
  );
  assert.equal(
    await adminPage.evaluate(
      (secret) => Object.values(localStorage).some((x) => x.includes(secret)),
      admin,
    ),
    false,
  );
  const [download] = await Promise.all([
    adminPage.waitForEvent("download"),
    adminPage.click("#export"),
  ]);
  const stream = await download.createReadStream();
  let csv = "";
  for await (const chunk of stream) csv += chunk.toString();
  assert.ok(csv.includes("Latest pending edit"));
  assert.ok(csv.includes("partial_pass"));
  assert.equal(csv.split("\r\n").length, 3);
  await adminPage.fill("#sessionTitle", "Created from UI");
  await adminPage.selectOption("#mode", "CUSTOM");
  await adminPage.fill("#customIds", "A01,B03");
  await adminPage.click("#createSession");
  await adminPage.waitForSelector("#codePanel:visible");
  assert.equal((await adminPage.textContent("#joinCode")).length, 64);
  await page.screenshot({ path: "/tmp/halo-participant.png", fullPage: true });
  await adminPage.screenshot({ path: "/tmp/halo-admin.png", fullPage: true });
  assert.deepEqual(errors, []);
  console.log(
    `Chromium navigation while saves fail: ${Math.round(navigationMs)} ms (includes Playwright click dispatch; target <150 ms). Subpath/CORS, lost join response, invalid navigation, failed-save refresh, recovery, explicit Skip and CSV verified.`,
  );
  await recoveryContext.close();
  await context.close();
});
test("slow login times out with enabled retry and no endless spinner", async () => {
  const context = await browser.newContext(),
    page = await context.newPage();
  await page.goto("http://127.0.0.1:8080/halo-kb-uat/");
  await page.selectOption("#team", "UIT");
  await page.fill("#firstName", "Slow");
  await page.fill("#lastInitial", "S");
  await page.fill("#sessionCode", code);
  await page.route("**/api/join", async () => {});
  await page.click("#joinButton");
  await page.waitForFunction(
    () => document.querySelector("#message").textContent.includes("timed out"),
    undefined,
    { timeout: 15000 },
  );
  assert.equal(await page.isEnabled("#joinButton"), true);
  await page.unroute("**/api/join");
  await page.click("#joinButton");
  await page.waitForSelector("#tester:visible");
  await context.close();
});
test("ten Chromium testers: delayed acknowledgements, quick edits and refresh retain latest distinct results", async () => {
  const r = await mf.dispatchFetch("http://local/api/admin/sessions", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + admin,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: "Ten browsers",
      mode: "CUSTOM",
      testIds: ["A01", "A02"],
    }),
  });
  const s = await r.json();
  const contexts = [];
  const started = performance.now();
  try {
    await Promise.all(
      Array.from({ length: 10 }, async (_, i) => {
        const context = await browser.newContext();
        contexts.push(context);
        const page = await context.newPage();
        page.on("pageerror", (e) => errors.push(e.message));
        await page.goto("http://127.0.0.1:8080/halo-kb-uat/");
        await page.selectOption("#team", "UIT");
        await page.fill(
          "#firstName",
          "Concurrent " + String.fromCharCode(65 + i),
        );
        await page.fill("#lastInitial", "T");
        await page.fill("#sessionCode", s.joinCode);
        await page.click("#joinButton");
        await page.waitForSelector("#tester:visible");
        await page.click("#dismissRecovery");
        // Commit each request on D1, then deliberately withhold its acknowledgement.
        await page.route("**/api/results/*", async (route) => {
          try {
            const response = await route.fetch();
            await new Promise((resolve) => setTimeout(resolve, 1200 + i * 10));
            await route.fulfill({ response });
          } catch {
            /* Reload aborts an old response; its frozen mutation is safely retried. */
          }
        });
        const sent = page.waitForRequest((req) => req.method() === "PUT");
        await page.click("[data-status=pass]");
        await sent;
        await page.click("[data-status=fail]");
        await page.fill("#comment", "Intermediate failure " + i);
        await page.click("[data-status=partial_pass]");
        await page.fill("#comment", "Latest browser revision " + i);
        await page.click("#next");
        if (i % 2 === 0) {
          await page.reload();
          await page.waitForSelector("#tester:visible");
        }
        await page.waitForFunction(
          () =>
            document
              .querySelector("#progressText")
              .textContent.startsWith("1 / 2 confirmed · 0 pending"),
          undefined,
          { timeout: 15000 },
        );
      }),
    );
    const db = await mf.getD1Database("DB");
    const rows = (
      await db
        .prepare(
          "SELECT r.*,p.first_name FROM results r JOIN participants p ON p.id=r.participant_id WHERE r.session_id=?",
        )
        .bind(s.id)
        .all()
    ).results;
    assert.equal(rows.length, 10);
    assert.equal(new Set(rows.map((r) => r.participant_id)).size, 10);
    for (const row of rows) {
      assert.equal(row.status, "partial_pass");
      assert.equal(row.version, 2);
      assert.ok(row.comment.startsWith("Latest browser revision"));
    }
    assert.deepEqual(errors, []);
    console.log(
      `Ten Chromium profiles with 1.2s delayed acknowledgements and five reloads: ${Math.round(performance.now() - started)} ms total; ten isolated rows, all latest edits confirmed.`,
    );
  } finally {
    await Promise.all(contexts.map((c) => c.close()));
  }
});
