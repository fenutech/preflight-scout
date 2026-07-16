import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDir, "../../..");
const sourceRoot = path.join(repositoryRoot, "examples", "sample-report");
const destinationRoot = path.join(scriptDir, "..", "public", "example-report");

await rm(destinationRoot, { recursive: true, force: true });
await mkdir(destinationRoot, { recursive: true });

for (const relative of [
  "report.html",
  "auto-expired-promo/console-errors.json",
  "auto-expired-promo/final-observation.json",
  "auto-expired-promo/network-errors.json",
  "auto-valid-promo/console-errors.json",
  "auto-valid-promo/final-observation.json",
  "auto-valid-promo/network-errors.json"
]) {
  const destination = path.join(destinationRoot, ...relative.split("/"));
  await mkdir(path.dirname(destination), { recursive: true });
  const content = await readFile(path.join(sourceRoot, ...relative.split("/")));
  await writeFile(destination, content);
}
