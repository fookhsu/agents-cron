import test from "node:test";
import assert from "node:assert/strict";
import { bold, colorsEnabledFor, cyan, dim, green, setColorEnabled, yellow } from "../src/color.ts";
import { formatTaskLine } from "../src/format.ts";
import type { ScheduleTask } from "../src/types.ts";

/**
 * Color is additive chrome over the plain vocabulary: until the CLI process
 * enables it for a real terminal, every span is the identity function, so
 * agents, tests, and pipes keep parsing the exact bytes they always did.
 */

function task(overrides: Partial<ScheduleTask> = {}): ScheduleTask {
  return {
    id: "task_ab12",
    projectDir: "/project",
    prompt: "Check CI",
    schedule: { kind: "interval", everyMs: 1_800_000 },
    enabled: true,
    createdAt: "2026-09-01T10:00:00.000Z",
    updatedAt: "2026-09-01T10:00:00.000Z",
    ...overrides,
  };
}

const ANSI = /\u001b\[\d+m/g;

test("spans are the identity function while disabled", () => {
  setColorEnabled(false);
  assert.equal(green("enabled"), "enabled");
  assert.equal(yellow("disabled"), "disabled");
  assert.equal(cyan("task_ab12"), "task_ab12");
  assert.equal(bold("digest"), "digest");
  assert.equal(dim("next 2026-09-01T10:05:00Z"), "next 2026-09-01T10:05:00Z");
});

test("enabled spans wrap in ANSI codes with a reset", () => {
  setColorEnabled(true);
  assert.equal(green("enabled"), "\u001b[32menabled\u001b[0m");
  assert.equal(dim("30m"), "\u001b[2m30m\u001b[0m");
  setColorEnabled(false);
});

test("formatTaskLine: stripping ANSI yields the byte-identical plain line", () => {
  const plain = formatTaskLine(task({ name: "digest", nextRunAt: "2026-09-01T10:05:00.000Z" }));
  setColorEnabled(true);
  const colored = formatTaskLine(task({ name: "digest", nextRunAt: "2026-09-01T10:05:00.000Z" }));
  setColorEnabled(false);
  assert.notEqual(colored, plain);
  assert.equal(colored.replace(ANSI, ""), plain);
});

test("gate: only a real terminal, without NO_COLOR, without injected stdout", () => {
  assert.equal(colorsEnabledFor({ isTTY: true }, {}, false), true);
  assert.equal(colorsEnabledFor({ isTTY: false }, {}, false), false);
  assert.equal(colorsEnabledFor(undefined, {}, false), false);
  assert.equal(colorsEnabledFor({ isTTY: true }, { NO_COLOR: "1" }, false), false);
  assert.equal(colorsEnabledFor({ isTTY: true }, {}, true), false);
});
