import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = "https://raw.githubusercontent.com/open-free-llm-api/awesome-freellm-apis/main/README.md";

const response = await fetch(source, {
  headers: { "User-Agent": "ULTRON-Mark4" }
});
if (!response.ok) throw new Error("Catalog HTTP " + response.status);

const markdown = await response.text();
const directory = path.join(root, ".ultron", "catalog");
fs.mkdirSync(directory, { recursive: true });

fs.writeFileSync(path.join(directory, "awesome-freellm-apis.md"), markdown);

const headings = [...markdown.matchAll(/^#{2,4}\s+(.+)$/gm)]
  .map(match => match[1].replace(/[*_`]/g, "").trim())
  .filter(value => /groq|nvidia|gemini|mistral|openrouter|cerebras|cloudflare|hugging|together|fireworks/i.test(value));

const metadata = {
  source,
  syncedAt: new Date().toISOString(),
  sha256: crypto.createHash("sha256").update(markdown).digest("hex"),
  candidateHeadings: [...new Set(headings)].slice(0, 100),
  trust: "candidate-discovery-only"
};

fs.writeFileSync(
  path.join(directory, "awesome-freellm-apis.json"),
  JSON.stringify(metadata, null, 2)
);

console.log(
  "catalog synced: " +
  metadata.sha256.slice(0, 12) +
  " (" + metadata.candidateHeadings.length + " candidate provider headings)"
);
