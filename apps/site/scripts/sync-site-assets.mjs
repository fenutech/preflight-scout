import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "./sync-sample-report.mjs";

const siteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
await copyFile(
  path.join(siteRoot, "..", "..", "docs", "agent-guide.md"),
  path.join(siteRoot, "public", "agent-guide.md")
);
const { version } = JSON.parse(await readFile(path.join(siteRoot, "package.json"), "utf8"));
const setupTemplate = await readFile(path.join(siteRoot, "..", "..", "docs", "agent-setup-prompt.md"), "utf8");
const setupPrompt = setupTemplate.replace(/^<!-- Source template:.*-->\n\n/m, "").replaceAll("{{RELEASE_VERSION}}", version);
await mkdir(path.join(siteRoot, "public", "agent-setup"), { recursive: true });
await writeFile(path.join(siteRoot, "public", "agent-setup", "prompt.md"), setupPrompt);
