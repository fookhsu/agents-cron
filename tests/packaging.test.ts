import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { test } from "node:test";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

/**
 * The loader in `bin/ts-loader.mjs` exists for exactly one situation: this
 * package's `.ts` sources sitting under a consumer's `node_modules`, where
 * Node refuses to strip types. Every other test runs from the source tree and
 * never exercises that path, so this test installs the real packed artifact
 * the way a consumer would and runs it with a bare `node`.
 *
 * It fails if `files` stops shipping `bin/` + `src/`, if the loader goes
 * missing, or if the loader leaks an ExperimentalWarning onto stderr.
 */
test("the packed tarball runs under a bare node", { timeout: 180_000 }, () => {
  const packDir = mkdtempSync(join(tmpdir(), "pi-sched-pack-"));
  const appDir = mkdtempSync(join(tmpdir(), "pi-sched-app-"));
  try {
    const pack = spawnSync(
      "npm",
      ["pack", "--json", "--pack-destination", packDir],
      { cwd: repoRoot, encoding: "utf8" },
    );
    assert.equal(pack.status, 0, `npm pack failed:\n${pack.stderr}`);
    const [entry] = JSON.parse(pack.stdout);
    assert.match(entry.filename, /agent-cron-/);

    writeFileSync(
      join(appDir, "package.json"),
      JSON.stringify({ name: "smoke-app", private: true }),
    );
    const install = spawnSync(
      "npm",
      [
        "install",
        "--no-save",
        "--no-audit",
        "--no-fund",
        join(packDir, entry.filename),
      ],
      { cwd: appDir, encoding: "utf8" },
    );
    assert.equal(install.status, 0, `npm install failed:\n${install.stderr}`);

    const bin = join(
      appDir,
      "node_modules",
      "agent-cron",
      "bin",
      "agent-cron.mjs",
    );
    const run = spawnSync(
      process.execPath,
      [bin, "list", "--project", appDir],
      { encoding: "utf8" },
    );
    assert.equal(run.status, 0, `installed CLI failed:\n${run.stderr}`);
    assert.ok(
      !run.stderr.includes("ExperimentalWarning"),
      `loader warned on stderr:\n${run.stderr}`,
    );
  } finally {
    rmSync(packDir, { recursive: true, force: true });
    rmSync(appDir, { recursive: true, force: true });
  }
});
