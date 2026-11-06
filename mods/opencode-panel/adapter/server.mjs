import { randomBytes } from "node:crypto";
import { mkdir, writeFile, rename, unlink } from "node:fs/promises";
import { createHandler } from "./http-handler.mjs";
import { Upstream } from "./upstream.mjs";
import { ProjectCache } from "./cache.mjs";
import { stateDirectory, registration, buildID, registered } from "./runtime.mjs";

const token = randomBytes(32).toString("hex"), build = await buildID();
const upstream = new Upstream();
const cache = new ProjectCache({ call: body => upstream.call(body) });
let lastUse = Date.now(), closing = false;
// Load only the active runtime's transport. Bun never imports our Node fallback
// or its manual HTTP/body-buffering plumbing.
const { serve } = await import(typeof Bun !== "undefined" ? "./http-bun.mjs" : "./http-node.mjs");
const server = await serve(createHandler({ token, build, cache,
  onUse: () => { lastUse = Date.now(); }, shutdown }));
await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
const temporary = `${registration}.${process.pid}.tmp`;
await writeFile(temporary, JSON.stringify({ version: 1, build, pid: process.pid, port: server.port, token }), { mode: 0o600 });
await rename(temporary, registration);
void upstream.events(event => cache.event(event));

async function shutdown() {
  if (closing) return;
  closing = true; upstream.close();
  if ((await registered())?.pid === process.pid) await unlink(registration).catch(() => {});
  await server.stop(); process.exit(0);
}
process.on("SIGTERM", shutdown); process.on("SIGINT", shutdown);
// A hidden/closed app doesn't leave a bridge resident forever. The next use
// rediscovers/restarts it; this never stops or replaces OpenCode's own service.
setInterval(() => { if (Date.now() - lastUse > 5 * 60000) void shutdown(); }, 30000).unref();
