import test from "node:test";
import assert from "node:assert/strict";
import { DAY, projectSessions, initialCount, scanComplete, age, sessionTab } from "./model.js";

const now = 1800000000000;
const session = (id, hours, directory = "/repo") => ({ id: `ses_${id}`, title: `Session ${id}`, updated: now - hours * 3600000, directory });

test("preserves the CLI project scope across roots, worktrees and packages", () => {
  const rows = [session("a", 1), session("b", 2, "/repo/tree"), session("c", 3, "/repo-other")];
  assert.deepEqual(projectSessions(rows).map(s => s.id), ["ses_a", "ses_b", "ses_c"]);
});

test("reverse chronological order, deduplication and valid IDs", () => {
  const rows = [session("older", 12), session("newest", 0), session("middle", 2), session("newest", 0), { ...session("bad", 0), id: "not-a-session" }];
  assert.deepEqual(projectSessions(rows).map(s => s.id), ["ses_newest", "ses_middle", "ses_older"]);
});

test("shows the newest ten even if everything is old", () => {
  assert.equal(initialCount(Array.from({ length: 15 }, (_, i) => session(String(i), 30 + i))), 10);
});

test("recent sessions do not expand the default beyond ten", () => {
  assert.equal(initialCount(Array.from({ length: 20 }, (_, i) => session(String(i), i))), 10);
});

test("fewer than ten sessions stays bounded by available rows", () => {
  assert.equal(initialCount([], now), 0);
  assert.equal(initialCount([session("one", 30)], now), 1);
});

test("project-scoped scan cannot stop before enough valid sessions", () => {
  const records = [session("a", 30, "/other"), session("b", 40, "/other")];
  assert.equal(scanComplete(records, [], 2, 3, now), false);
  assert.equal(scanComplete(records, [], 3, 3, now), true);
});

test("scan stops at the requested count regardless of timestamps", () => {
  const records = [session("a", 1), session("b", 2), session("c", 3)];
  assert.equal(scanComplete(records, records, 3, 3, now), true);
  records.push(session("d", 25));
  assert.equal(scanComplete(records, records, 4, 3, now), true);
});

test("session opens in a new tab with its own directory in the same space", () => {
  const row = session("abc123", 1, "/repo/feature with spaces");
  assert.deepEqual(sessionTab(row, "space-1"), {
    space: "space-1", folder: row.directory, name: row.title,
    argv: ["opencode", "--session", "ses_abc123"],
  });
});

test("relative timestamps are stable across boundaries", () => {
  assert.equal(age(now, now), "just now");
  assert.equal(age(now - 5 * 60000, now), "5m ago");
  assert.equal(age(now - 2 * 3600000, now), "2h ago");
  assert.equal(age(now - DAY, now), "1d ago");
});

test("invalid JSON shape is an actionable error", () => {
  assert.throws(() => projectSessions({}), /invalid session list/);
});
