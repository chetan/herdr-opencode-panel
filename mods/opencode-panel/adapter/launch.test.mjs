import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";

const execute = promisify(execFile);

test("concurrent launchers start one detached bridge and later reuse it", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "herdr launch fixture-"));
  const registration = path.join(directory, "bridge.json");
  const env = { ...process.env, HERDR_OPENCODE_ADAPTER_STATE: directory,
    HERDR_OPENCODE_SERVICE_FILE: path.join(directory, "absent-service.json") };
  const launch = () => execute(process.execPath, [fileURLToPath(new URL("./launch.mjs", import.meta.url))], { env, timeout: 15000 });
  let state;
  try {
    const results = await Promise.all([launch(), launch(), launch()]);
    for (const result of results) assert.deepEqual(JSON.parse(result.stdout), { ready: true });
    state = JSON.parse(await readFile(registration, "utf8"));
    assert.notEqual(state.pid, process.pid);
    const headers = { authorization: `Bearer ${state.token}` };
    const response = await fetch(`http://127.0.0.1:${state.port}/health`, { headers });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).build, state.build);
    await launch();
    assert.equal(JSON.parse(await readFile(registration, "utf8")).pid, state.pid);
  } finally {
    state ??= await readFile(registration, "utf8").then(JSON.parse).catch(() => null);
    if (state) {
      await fetch(`http://127.0.0.1:${state.port}/shutdown`, { method: "POST",
        headers: { authorization: `Bearer ${state.token}` }, signal: AbortSignal.timeout(2000) }).catch(() => {});
      // The registration is removed before the detached child exits.
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        try { await readFile(registration); } catch { break; }
        await sleep(25);
      }
      await assert.rejects(readFile(registration), { code: "ENOENT" });
    }
    await rm(directory, { recursive: true, force: true });
  }
});
