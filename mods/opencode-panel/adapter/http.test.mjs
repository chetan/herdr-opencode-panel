import { test, expect } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

test("bridge is loopback-only, authenticates requests and rejects browser origins", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "herdr-api-fixture-"));
  const child = Bun.spawn([process.execPath, new URL("./server.mjs", import.meta.url).pathname], {
    env: { ...process.env, HERDR_OPENCODE_ADAPTER_STATE: directory, HERDR_OPENCODE_SERVICE_FILE: path.join(directory, "absent-service.json") },
    stdin: "ignore", stdout: "ignore", stderr: "ignore",
  });
  try {
    let state;
    const deadline = Date.now() + 5000;
    while (!state && Date.now() < deadline) {
      try { state = JSON.parse(await readFile(path.join(directory, "bridge.json"), "utf8")); }
      catch { await Bun.sleep(25); }
    }
    if (!state) throw new Error("Fixture adapter did not become ready");
    const base = `http://127.0.0.1:${state.port}`;
    expect((await fetch(base + "/health")).status).toBe(401);
    const headers = { authorization: `Bearer ${state.token}` };
    expect((await fetch(base + "/health", { headers })).status).toBe(200);
    expect((await fetch(base + "/health", { headers: { ...headers, origin: "https://untrusted.example" } })).status).toBe(403);
    const invalid = await fetch(base + "/snapshot", { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ directory: "relative" }) });
    expect(invalid.status).toBe(400);
    const metrics = await (await fetch(base + "/metrics", { headers })).json();
    expect(metrics.listRequests).toBe(0);
    expect(Object.keys(metrics).some(key => /token|password|auth/i.test(key))).toBe(false);
    await fetch(base + "/shutdown", { method: "POST", headers });
    await child.exited;
  } finally { child.kill(); await child.exited; await rm(directory, { recursive: true, force: true }); }
}, 10000);
