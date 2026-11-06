import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { request } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";

// Each process gets a disposable registration and an absent service file.
// These tests never discover, replace or shut down the owner's live bridge.
async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "herdr-api-fixture-"));
  const child = spawn(process.execPath, [fileURLToPath(new URL("./server.mjs", import.meta.url))], {
    env: { ...process.env, HERDR_OPENCODE_ADAPTER_STATE: directory, HERDR_OPENCODE_SERVICE_FILE: path.join(directory, "absent-service.json") },
    stdio: "ignore",
  });
  const exited = once(child, "exit");
  // Keep a rejection observed even if startup fails before awaiting cleanup.
  exited.catch(() => {});
  async function close() {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
    await rm(directory, { recursive: true, force: true });
  }
  try {
    let state;
    const deadline = Date.now() + 5000;
    while (!state && Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error("Fixture exited before readiness");
      try { state = JSON.parse(await readFile(path.join(directory, "bridge.json"), "utf8")); }
      catch { await sleep(25); }
    }
    if (!state) throw new Error("Fixture adapter did not become ready");
    return { state, directory, exited, close, base: `http://127.0.0.1:${state.port}`, headers: { authorization: `Bearer ${state.token}` } };
  } catch (error) { await close(); throw error; }
}

test("bridge authenticates requests, rejects browser origins/hosts and keeps state private", async () => {
  const f = await fixture();
  try {
    assert.equal((await fetch(f.base + "/health")).status, 401);
    const health = await fetch(f.base + "/health", { headers: f.headers });
    assert.equal(health.status, 200);
    assert.equal(health.headers.get("cache-control"), "no-store");
    assert.equal((await fetch(f.base + "/health", { headers: { authorization: "Bearer wrong" } })).status, 401);
    assert.equal((await fetch(f.base + "/health", { headers: { ...f.headers, origin: "https://untrusted.example" } })).status, 403);
    const hostStatus = await new Promise((resolve, reject) => {
      const req = request(f.base + "/health", { headers: { ...f.headers, host: "untrusted.example" } }, res => { res.resume(); resolve(res.statusCode); });
      req.on("error", reject); req.end();
    });
    assert.equal(hostStatus, 403);
    const metrics = await (await fetch(f.base + "/metrics", { headers: f.headers })).json();
    assert.equal(metrics.listRequests, 0);
    assert.equal(Object.keys(metrics).some(key => /token|password|auth/i.test(key)), false);
    assert.equal((await stat(path.join(f.directory, "bridge.json"))).mode & 0o777, 0o600);
    assert.equal((await stat(f.directory)).mode & 0o777, 0o700);
    assert.equal((await fetch(f.base + "/shutdown", { method: "POST", headers: f.headers })).status, 200);
    assert.equal((await f.exited)[0], 0);
    await assert.rejects(readFile(path.join(f.directory, "bridge.json")), { code: "ENOENT" });
  } finally { await f.close(); }
});

test("bridge validates JSON, paths, limits and unavailable upstream errors", async () => {
  const f = await fixture();
  const post = body => fetch(f.base + "/snapshot", { method: "POST", headers: { ...f.headers, "content-type": "application/json" }, body });
  try {
    for (const body of ["{", "null", JSON.stringify({ directory: "relative" }), JSON.stringify({ directory: "/repo", limit: 1001 }), JSON.stringify({ directory: "/repo", force: "yes" })]) {
      assert.equal((await post(body)).status, 400);
    }
    const response = await post(JSON.stringify({ directory: f.directory }));
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "OpenCode API unavailable or directory not found. Check the local service and directory, then refresh." });
    assert.equal((await fetch(f.base + "/unknown", { headers: f.headers })).status, 404);
  } finally { await f.close(); }
});

test("bridge enforces the 4KiB limit for content-length and chunked requests", async () => {
  const f = await fixture();
  try {
    const declared = await fetch(f.base + "/snapshot", { method: "POST", headers: f.headers, body: "x".repeat(4097) });
    assert.equal(declared.status, 413);
    const chunked = await new Promise((resolve, reject) => {
      const req = request(f.base + "/snapshot", { method: "POST", headers: { ...f.headers, "transfer-encoding": "chunked" } }, res => { res.resume(); resolve(res.statusCode); });
      req.on("error", reject);
      req.write("x".repeat(2048)); req.end("x".repeat(2049));
    });
    assert.equal(chunked, 413);
    assert.equal((await fetch(f.base + "/health", { headers: f.headers })).status, 200);
  } finally { await f.close(); }
});

test("an interrupted request body does not terminate the shared bridge", async () => {
  const f = await fixture();
  try {
    const req = request(f.base + "/snapshot", { method: "POST", headers: { ...f.headers, "content-length": "100" } });
    req.on("error", () => {});
    const closed = new Promise(resolve => req.once("close", resolve));
    req.write('{"directory":');
    await sleep(25);
    req.destroy(); await closed;
    assert.equal((await fetch(f.base + "/health", { headers: f.headers })).status, 200);
  } finally { await f.close(); }
});
