import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const rows = JSON.parse(fs.readFileSync(root + "data/tests.json", "utf8"));
if (rows.length !== 215 || new Set(rows.map((r) => r.id)).size !== 215)
  throw Error("Invalid canonical inventory");
const quote = (s) => "'" + String(s).replaceAll("'", "''") + "'";
export const sql = rows
  .map(
    (r, i) =>
      `INSERT INTO test_cases(id,category,tier,priority,title,expected_result,sort_order) VALUES(${[r.id, r.category, r.tier, r.priority, r.title, r.expected_result].map(quote).join(",")},${i}) ON CONFLICT(id) DO UPDATE SET category=excluded.category,tier=excluded.tier,priority=excluded.priority,title=excluded.title,expected_result=excluded.expected_result,sort_order=excluded.sort_order;`,
  )
  .join("\n");
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2];
  if (!["--local", "--remote"].includes(mode))
    throw Error("Specify --local or --remote");
  if (mode === "--remote" && process.env.CONFIRM_REMOTE_SEED !== "yes")
    throw Error(
      "Set CONFIRM_REMOTE_SEED=yes for remote seed; never deletes results",
    );
  const path = root + "worker/.seed.sql";
  fs.writeFileSync(path, sql);
  try {
    const r = spawnSync(
      process.execPath,
      [
        fileURLToPath(
          new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url),
        ),
        "d1",
        "execute",
        "DB",
        mode,
        "--config",
        root + "worker/wrangler.toml",
        "--file",
        path,
      ],
      { stdio: "inherit", cwd: root },
    );
    if (r.error) throw Error("Could not start Wrangler: " + r.error.message);
    process.exitCode = r.status ?? 1;
    if (r.status === 0)
      console.log(
        "Successfully seeded all 215 canonical test cases (" +
          mode.slice(2) +
          ").",
      );
    else
      console.error(
        "Seeding failed. Wrangler exit status: " +
          (r.status ?? r.signal ?? "unknown"),
      );
  } finally {
    fs.unlinkSync(path);
  }
}
