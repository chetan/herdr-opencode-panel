import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, writeFile, rename, unlink } from "node:fs/promises";
import { Upstream } from "./upstream.mjs";
import { ProjectCache } from "./cache.mjs";
import { stateDirectory, registration, buildID, registered } from "./runtime.mjs";

const token = randomBytes(32).toString("hex"), build = await buildID();
const upstream = new Upstream();
const cache = new ProjectCache({ call: body => upstream.call(body) });
let lastUse = Date.now(), closing = false;
const json = (value, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });
const server = Bun.serve({
  hostname: "127.0.0.1", port: 0, maxRequestBodySize: 4096,
  async fetch(request) {
    const url = new URL(request.url);
    const provided = Buffer.from(request.headers.get("authorization") || "");
    const expected = Buffer.from(`Bearer ${token}`);
    if (request.headers.has("origin") || url.hostname !== "127.0.0.1") return json({ error: "Forbidden" }, 403);
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return json({ error: "Unauthorized" }, 401);
    lastUse = Date.now();
    if (request.method === "GET" && url.pathname === "/health") return json({ version: 1, build });
    if (request.method === "GET" && url.pathname === "/revision") return json({ revision: cache.revision });
    if (request.method === "GET" && url.pathname === "/metrics") return json({ ...cache.stats, projects: cache.projects.size, revision: cache.revision });
    if (request.method === "POST" && url.pathname === "/shutdown") { setTimeout(shutdown, 50); return json({ stopped: true }); }
    if (request.method !== "POST" || url.pathname !== "/snapshot") return json({ error: "Not found" }, 404);
    try {
      const body = await request.json();
      if (typeof body.directory !== "string" || !body.directory.startsWith("/") || body.directory.length > 4096
        || (body.limit !== undefined && (!Number.isInteger(body.limit) || body.limit < 1 || body.limit > 1000))
        || (body.force !== undefined && typeof body.force !== "boolean")) return json({ error: "Invalid request" }, 400);
      return json(await cache.snapshot(body.directory, body.limit ?? 10, body.force === true));
    } catch { return json({ error: "OpenCode API unavailable or directory not found. Check the local service and directory, then refresh." }, 503); }
  },
});
await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
const temporary = `${registration}.${process.pid}.tmp`;
await writeFile(temporary, JSON.stringify({ version: 1, build, pid: process.pid, port: server.port, token }), { mode: 0o600 });
await rename(temporary, registration);
void upstream.events(event => cache.event(event));

async function shutdown() {
  if (closing) return;
  closing = true; upstream.close();
  if ((await registered())?.pid === process.pid) await unlink(registration).catch(() => {});
  server.stop(true); process.exit(0);
}
process.on("SIGTERM", shutdown); process.on("SIGINT", shutdown);
// A hidden/closed app doesn't leave a bridge resident forever. The next use
// rediscovers/restarts it; this never stops or replaces OpenCode's own service.
setInterval(() => { if (Date.now() - lastUse > 5 * 60000) void shutdown(); }, 30000).unref();
