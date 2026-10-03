import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Static guard: the OpenAI key is a backend-only secret. Tests run from
// backend/, so the repo root is three levels up from this file.
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

const SKIP_DIRS = new Set(["node_modules", "dist", ".git"]);

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (SKIP_DIRS.has(entry.name)) return [];
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

const KEY_PATTERN = /OPENAI_API_KEY|VITE_OPENAI|\bsk-[A-Za-z0-9_-]{20,}/;

const filesMatching = (files) =>
  files.filter((file) => KEY_PATTERN.test(fs.readFileSync(file, "utf8")));

describe("OpenAI key stays server-side", () => {
  it("never appears in frontend source, config, or env files", () => {
    const files = walk(path.join(repoRoot, "frontend")).filter(
      (f) => !f.endsWith("package-lock.json"),
    );

    expect(files.length).toBeGreaterThan(0);
    expect(filesMatching(files).map((f) => path.relative(repoRoot, f))).toEqual([]);
  });

  it("is not baked into the Docker image (no ARG/ENV for it)", () => {
    const dockerfile = path.join(repoRoot, "Dockerfile");
    expect(fs.existsSync(dockerfile)).toBe(true);
    expect(filesMatching([dockerfile])).toEqual([]);
  });

  it("is read from the environment in exactly one backend module", () => {
    const readers = walk(path.join(repoRoot, "backend", "src"))
      .filter((f) => fs.readFileSync(f, "utf8").includes("process.env.OPENAI_API_KEY"))
      .map((f) => path.relative(path.join(repoRoot, "backend"), f).split(path.sep).join("/"));

    expect(readers).toEqual(["src/lib/ai/openai.js"]);
  });

  it("is not hard-coded as a literal anywhere in backend source", () => {
    const literal = /\bsk-[A-Za-z0-9_-]{20,}/;
    const hits = walk(path.join(repoRoot, "backend", "src")).filter((f) =>
      literal.test(fs.readFileSync(f, "utf8")),
    );

    expect(hits).toEqual([]);
  });
});
