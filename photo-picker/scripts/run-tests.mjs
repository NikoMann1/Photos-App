/**
 * Test runner.
 *
 * Node cannot import the project's TypeScript directly — the sources use
 * extensionless relative imports, which Node's ESM resolver rejects — so bundle
 * each test file with esbuild first, then hand the output to `node --test`.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { glob } from "node:fs/promises";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(path.join(tmpdir(), "photo-picker-tests-"));

try {
  const entryPoints = [];
  for await (const file of glob("lib/**/*.test.ts", { cwd: root })) {
    entryPoints.push(path.join(root, file));
  }

  if (entryPoints.length === 0) {
    console.error("No test files found (lib/**/*.test.ts)");
    process.exit(1);
  }

  await build({
    entryPoints,
    outdir: outDir,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    external: ["node:*"],
    // .mjs so Node reads the bundles as ESM: the temp directory has no
    // package.json, so a .js file there would be treated as CommonJS.
    outExtension: { ".js": ".mjs" },
  });

  // `node --test <dir>` resolves the directory as a module rather than
  // scanning it, so name the files explicitly. Recursive: esbuild mirrors the
  // source layout, so tests in subdirectories land in subdirectories.
  const bundles = readdirSync(outDir, { recursive: true })
    .map(String)
    .filter((file) => file.endsWith(".mjs"))
    .map((file) => path.join(outDir, file));

  execFileSync(process.execPath, ["--test", ...bundles], { stdio: "inherit" });
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
