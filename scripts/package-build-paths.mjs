import path from "node:path";

export function portablePathLabel(value) {
  if (typeof value !== "string") throw new TypeError("Build-integrity path labels must be strings.");
  return value.replaceAll("\\", "/");
}

export function relativePathLabel(from, to, pathImplementation = path) {
  return portablePathLabel(pathImplementation.relative(from, to));
}

export function manifestPathLabel(value) {
  return portablePathLabel(value).replace(/^\.\//, "");
}
