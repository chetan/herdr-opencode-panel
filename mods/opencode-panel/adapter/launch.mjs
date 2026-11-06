import { mkdir, rmdir, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { stateDirectory, lock, buildID, registered, alive } from "./runtime.mjs";

async function launch() {
  const build = await buildID();
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const previous = await registered();
  if (previous?.build === build && await alive(previous)) return;
  let owned = false;
  try {
    await mkdir(lock, { mode: 0o700 }); owned = true;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    if (Date.now() - (await stat(lock)).mtimeMs > 30000) {
      await rmdir(lock); await mkdir(lock, { mode: 0o700 }); owned = true;
    }
  }
  try {
    if (owned) {
      if (await alive(previous)) {
        await fetch(`http://127.0.0.1:${previous.port}/shutdown`, {
          method: "POST", headers: { authorization: `Bearer ${previous.token}` }, signal: AbortSignal.timeout(1500),
        }).catch(() => {});
      }
      const child = spawn(process.execPath, [new URL("./server.mjs", import.meta.url).pathname], {
        detached: true, stdio: "ignore", env: process.env,
      });
      child.unref();
    }
    const until = Date.now() + 10000;
    while (Date.now() < until) {
      const value = await registered();
      if (value?.build === build && await alive(value)) return;
      await Bun.sleep(100);
    }
    throw new Error("The adapter did not become ready");
  } finally { if (owned) await rmdir(lock).catch(() => {}); }
}

try { await launch(); console.log('{"ready":true}'); }
catch { console.error("Cannot start the OpenCode adapter. Install its dependencies with bun install in mods/opencode-panel/adapter, then retry."); process.exitCode = 1; }
