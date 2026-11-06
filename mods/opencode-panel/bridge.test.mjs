import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

function harness(responder) {
  const calls = [];
  const context = {
    home: () => "/fixture home", appHome: () => "/fixture app",
    exec: async (command, args) => { calls.push({ command, args }); return responder(command, args); },
    readTextFile: async () => JSON.stringify({ version: 1, port: 12345, token: "0".repeat(64) }),
  };
  const source = readFileSync(new URL("./bridge.js", import.meta.url), "utf8")
    .replace(/^import .*;\n/gm, "").replace("export async function startAdapter", "async function startAdapter")
    .replace("export class LocalAdapter", "globalThis.LocalAdapter = class LocalAdapter");
  vm.runInNewContext(source, context);
  return { adapter: new context.LocalAdapter(), calls };
}
const ok = { code: 0, stdout: "1.4.4\n", stderr: "" };
const unavailable = () => { throw new Error("Executable cannot start"); };
const normalized = calls => JSON.parse(JSON.stringify(calls));
const script = "/fixture app/mods/opencode-panel/adapter/launch.mjs";

for (const [label, selected, missing] of [
  ["Bun on PATH", "bun", []],
  ["Bun in the user's home", "/fixture home/.bun/bin/bun", ["bun"]],
  ["Node when both Bun locations are unavailable", "node", ["bun", "/fixture home/.bun/bin/bun"]],
]) {
  test(`prefers ${label}`, async () => {
    const h = harness((command, args) => missing.includes(command) ? unavailable()
      : command === "node" && args[0] === "--version" ? { ...ok, stdout: "v22.22.0\n" } : ok);
    await h.adapter.ensure();
    assert.deepEqual(normalized(h.calls), [...missing.map(command => ({ command, args: ["--version"] })),
      { command: selected, args: ["--version"] }, { command: selected, args: [script] }]);
    await h.adapter.ensure();
    assert.equal(h.calls.length, missing.length + 2);
  });
}

test("missing runtimes produce an actionable error", async () => {
  const h = harness(unavailable);
  await assert.rejects(h.adapter.ensure(), /Install Bun or Node.js 22/);
  assert.equal(h.calls.length, 3);
});

for (const failure of ["nonzero", "rejection"]) {
  test(`does not fall back after an adapter ${failure}`, async () => {
    const h = harness((_command, args) => args[0] === "--version" ? ok
      : failure === "rejection" ? unavailable() : { ...ok, code: 1 });
    await assert.rejects(h.adapter.ensure(), /Cannot (start|launch)/);
    assert.deepEqual(h.calls.map(call => call.command), ["bun", "bun"]);
  });
}

test("a broken runtime probe does not silently select a different runtime", async () => {
  const h = harness(() => ({ ...ok, code: 1 }));
  await assert.rejects(h.adapter.ensure(), /Cannot check/);
  assert.equal(h.calls.length, 1);
});

test("rejects an unsupported Node version before starting the adapter", async () => {
  const h = harness(command => command !== "node" ? unavailable() : { ...ok, stdout: "v20.20.0\n" });
  await assert.rejects(h.adapter.ensure(), /Node.js 22 or newer/);
  assert.equal(h.calls.length, 3);
});

test("concurrent callers share one runtime probe and launch", async () => {
  const h = harness(() => ok);
  await Promise.all([h.adapter.ensure(), h.adapter.ensure()]);
  assert.equal(h.calls.length, 2);
});
