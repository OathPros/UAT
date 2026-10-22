import fs from "node:fs";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
const path = fileURLToPath(new URL("../worker/.dev.vars", import.meta.url));
try {
  fs.writeFileSync(
    path,
    `# Local development only. Never commit or reuse in production.\nADMIN_API_KEY=${crypto.randomBytes(32).toString("hex")}\n`,
    { flag: "wx", mode: 0o600 },
  );
  console.log("Created an ignored local-only admin key in worker/.dev.vars.");
} catch (e) {
  if (e.code !== "EEXIST") throw e;
  console.log("Kept existing worker/.dev.vars unchanged.");
}
