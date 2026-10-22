import fs from "node:fs";
import { fileURLToPath } from "node:url";
const url = new URL(process.argv[2] || "");
if (
  url.protocol !== "https:" ||
  url.username ||
  url.password ||
  url.pathname !== "/" ||
  url.search ||
  url.hash
)
  throw Error(
    "Provide an HTTPS Worker origin with no path, credentials or query",
  );
const root = fileURLToPath(new URL("../web/", import.meta.url));
fs.writeFileSync(
  root + "config.js",
  `// Public Worker origin. Never put credentials here.\nexport const API_BASE_URL = ${JSON.stringify(url.origin)};\n`,
);
for (const file of ["index.html", "admin.html"]) {
  const html = fs.readFileSync(root + file, "utf8");
  fs.writeFileSync(
    root + file,
    html.replace(/connect-src [^;]+;/, `connect-src 'self' ${url.origin};`),
  );
}
console.log(
  "Configured public API origin and exact CSP in web/. Commit these public changes before publishing.",
);
