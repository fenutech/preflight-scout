import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = path.join(root, "src");
const outRoot = path.join(root, "out");

for (const sourceFile of await filesUnder(sourceRoot)) {
  if (!/\.[cm]?[jt]sx?$/.test(sourceFile)) continue;
  const source = await readFile(sourceFile, "utf8");
  if (/^["']use client["'];/m.test(source)) {
    throw new Error(`Cannot strip the Next.js runtime while a client component exists: ${path.relative(root, sourceFile)}`);
  }
}

let strippedPages = 0;
for (const htmlFile of (await filesUnder(outRoot)).filter((file) => file.endsWith(".html"))) {
  const html = await readFile(htmlFile, "utf8");
  const stripped = html
    .replace(/<link\b(?=[^>]*\brel="preload")(?=[^>]*\bas="script")(?=[^>]*\bhref="\/_next\/static\/chunks\/[^"]+\.js")[^>]*\/?>/g, "")
    .replace(/<script\b(?=[^>]*\bsrc="\/_next\/static\/chunks\/[^"]+\.js")[^>]*><\/script>/g, "")
    .replace(/<script>(?:\(self\.__next_f|self\.__next_f)[\s\S]*?<\/script>/g, "");

  if (stripped.includes("self.__next_f") || /<script\b[^>]*\bsrc="\/_next\/static\/chunks\/[^"]+\.js"/.test(stripped)) {
    throw new Error(`Next.js runtime markup remains in ${path.relative(outRoot, htmlFile)}`);
  }
  if (stripped !== html) {
    await writeFile(htmlFile, stripped);
    strippedPages += 1;
  }
}

console.log(`Removed the unused Next.js client runtime from ${strippedPages} static HTML pages.`);

async function filesUnder(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(absolute));
    else if (entry.isFile()) files.push(absolute);
  }
  return files;
}
