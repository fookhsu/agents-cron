import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
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
    assert.match(entry.filename, /agents-cron-/);

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

    const pkg = join(appDir, "node_modules", "agents-cron");
    for (const shipped of ["bin/agents-cron.mjs", "bin/ts-loader.mjs", "index.mjs", "skills"])
      assert.ok(existsSync(join(pkg, shipped)), `files list is missing ${shipped}`);

    const bin = join(pkg, "bin", "agents-cron.mjs");
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

test("gate: every pi.extensions entry is a root index.* file so the TUI label stays `agents-cron`", () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  const entries = pkg.pi?.extensions;
  assert.ok(Array.isArray(entries) && entries.length > 0,
    "pi.extensions must be a non-empty array");
  // Mirror pi's getCompactExtensionLabel: it strips the `package:` prefix
  // only when path.posix.parse(entry).name === "index" and the dir is empty.
  // Any other name (e.g. extension.mjs) renders as `agents-cron:extension.mjs`
  // in the extensions list.
  for (const entry of entries) {
    const parsed = posix.parse(entry);
    assert.equal(parsed.name, "index",
      `pi.extensions entry "${entry}" must have basename index.* (pi shows the pkg name only for index entries; got "${parsed.name}")`);
    assert.ok(parsed.dir === "" || parsed.dir === ".",
      `pi.extensions entry "${entry}" must sit at the package root (subdirectory entries render as agents-cron:<dir>)`);
  }
  assert.deepEqual(entries, ["./index.mjs"],
    "pi.extensions must stay the single root re-export; keep this in sync when the entry changes");
  const entry = readFileSync(join(repoRoot, entries[0]), "utf8");
  assert.ok(entry.includes('from "./src/agents/pi/extension.ts"'),
    "index.mjs must stay a re-export of src/agents/pi/extension.ts");
});
