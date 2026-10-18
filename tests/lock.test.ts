import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock } from "../src/lock.ts";

test("allows one owner and releases its lock", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-cron-"));
  const path = join(dir, "run.lock");
  const first = await acquireLock(path);
  assert.ok(first);
  assert.equal(await acquireLock(path), undefined);
  await first.release();
  const second = await acquireLock(path);
  assert.ok(second);
  await second.release();
});
