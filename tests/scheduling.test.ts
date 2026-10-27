import test from "node:test";
import assert from "node:assert/strict";
import {
  calculateNextRun,
  isDue,
  normalizeCronExpression,
  parseDuration,
  parseScheduleInput,
  parseScheduleSpec,
} from "../src/scheduling.ts";

test("parses compact durations", () => {
  assert.equal(parseDuration("30s"), 30_000);
  assert.equal(parseDuration("5m"), 300_000);
  assert.equal(parseDuration("2h"), 7_200_000);
  assert.equal(parseDuration("1 day"), 86_400_000);
});

test("rejects invalid or sub-minute durations", () => {
  assert.throws(() => parseDuration("nope"), /duration/i);
  assert.throws(() => parseScheduleInput({ kind: "interval", every: "30s" }), /minute/i);
});

test("duration errors name the accepted syntax", () => {
  assert.throws(() => parseDuration("45"), /30s, 5m, 2h, 1d/);
  assert.throws(() => parseDuration("45 fortnights"), /use s\/sec, m\/min, h\/hr, or d\/day/);
});

test("calculates once and interval schedules", () => {
  const now = new Date("2026-09-01T10:00:00.000Z");
  assert.equal(
    calculateNextRun(
      parseScheduleInput({ kind: "once", runAt: "2026-09-01T11:00:00.000Z" }),
      now,
    )?.toISOString(),
    "2026-09-01T11:00:00.000Z",
  );
  assert.equal(
    calculateNextRun(parseScheduleInput({ kind: "interval", every: "5m" }), now)?.toISOString(),
    "2026-09-01T10:05:00.000Z",
  );
});

test("calculates five-field cron schedules", () => {
  const now = new Date("2026-09-01T10:01:00.000Z");
  assert.equal(
    calculateNextRun(
      parseScheduleInput({ kind: "cron", expression: "*/5 * * * *" }),
      now,
    )?.toISOString(),
    "2026-09-01T10:05:00.000Z",
  );
});

test("expands cron nicknames to the six-field form", () => {
  assert.equal(normalizeCronExpression("@daily"), "0 0 0 * * *");
  assert.equal(normalizeCronExpression("@HOURLY"), "0 0 * * * *");
  assert.equal(normalizeCronExpression("@weekly"), "0 0 0 * * 0");
  assert.equal(normalizeCronExpression("@annually"), "0 0 0 1 1 *");
});

test("rejects an unknown nickname with the supported ones listed", () => {
  assert.throws(() => normalizeCronExpression("@every 10m"), /Unknown cron nickname: @every 10m/);
  assert.throws(() => normalizeCronExpression("@midnight"), /Supported: @yearly/);
});

test("normalizes five- and six-field expressions and rejects anything else", () => {
  assert.equal(normalizeCronExpression("*/5 * * * *"), "0 */5 * * * *");
  assert.equal(normalizeCronExpression("  30 2  *  *  * "), "0 30 2 * * *");
  assert.equal(normalizeCronExpression("0 */2 * * * *"), "0 */2 * * * *");
  assert.throws(() => normalizeCronExpression("* * * *"), /5 or 6 fields/);
});

test("a nickname runs on the same schedule as its expanded expression", () => {
  const now = new Date("2026-09-01T10:01:00.000Z");
  const fromNickname = calculateNextRun(parseScheduleInput({ kind: "cron", expression: "@daily" }), now);
  const fromExpression = calculateNextRun(parseScheduleInput({ kind: "cron", expression: "0 0 * * *" }), now);

  assert.ok(fromNickname);
  assert.equal(fromNickname.toISOString(), fromExpression?.toISOString());
});

test("parses a duration, a nickname, or a quoted cron expression", () => {
  assert.deepEqual(parseScheduleSpec("30m"), { kind: "interval", every: "30m" });
  assert.deepEqual(parseScheduleSpec("@daily"), { kind: "cron", expression: "@daily" });
  assert.deepEqual(parseScheduleSpec('"*/5 * * * *"'), { kind: "cron", expression: "*/5 * * * *" });
  assert.throws(() => parseScheduleSpec("*/5"), /duration like 30m/);
});

test("a task is due once its planned time has arrived", () => {
  const now = new Date("2026-09-01T10:05:00.000Z");
  assert.equal(isDue({ nextRunAt: "2026-09-01T10:05:00.000Z" }, now), true);
  assert.equal(isDue({ nextRunAt: "2026-09-01T10:06:00.000Z" }, now), false);
  assert.equal(isDue({}, now), false);
});
