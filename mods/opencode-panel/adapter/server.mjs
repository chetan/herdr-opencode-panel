import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, writeFile, rename, unlink } from "node:fs/promises";
import { createServer } from "node:http";
import { Upstream } from "./upstream.mjs";
import { ProjectCache } from "./cache.mjs";
import { stateDirectory, registration, buildID, registered } from "./runtime.mjs";

const token = randomBytes(32).toString("hex"), build = await buildID();
const upstream = new Upstream();
const cache = new ProjectCache({ call: body => upstream.call(body) });
let lastUse = Date.now(), closing = false;
const MAX_BODY = 4096;

// Bound both declared and chunked bodies without destroying the request socket
// before the client can receive a 413. Never buffer more than MAX_BODY bytes.
function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    const cleanup = () => { request.off("data", data); request.off("end", end); request.off("error", error); request.off("aborted", aborted); };
    const error = () => { cleanup(); reject(new Error("Invalid body")); };
    const aborted = () => error();
    const end = () => { cleanup(); resolve(Buffer.concat(chunks).toString("utf8")); };
    const data = chunk => {
      size += chunk.length;
      if (size > MAX_BODY) {
        cleanup(); request.resume();
        reject(Object.assign(new Error("Body too large"), { status: 413 }));
      } else chunks.push(chunk);
    };
    request.on("data", data); request.on("end", end); request.on("error", error); request.on("aborted", aborted);
  });
}

const server = createServer({ maxHeaderSize: 8192, requestTimeout: 15000 }, async (request, response) => {
  // A client may disconnect mid-body or while an upstream query is pending.
  // Transport errors must not terminate the shared bridge or expose details.
  request.on("error", () => {}); response.on("error", () => {});
  const json = (value, status = 200) => {
    if (response.destroyed || response.writableEnded) return;
    response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify(value));
  };
  try {
    const host = request.headers.host;
    if (request.headers.origin !== undefined || (host !== "127.0.0.1" && host !== `127.0.0.1:${server.address().port}`)
      || !request.url?.startsWith("/") || request.url.startsWith("//")) return json({ error: "Forbidden" }, 403);
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.hostname !== "127.0.0.1") return json({ error: "Forbidden" }, 403);
    const provided = Buffer.from(request.headers.authorization || "");
    const expected = Buffer.from(`Bearer ${token}`);
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return json({ error: "Unauthorized" }, 401);
    if (Number(request.headers["content-length"]) > MAX_BODY) {
      request.resume(); response.setHeader("connection", "close");
      return json({ error: "Request body too large" }, 413);
    }
    lastUse = Date.now();
    if (request.method === "GET" && url.pathname === "/health") return json({ version: 1, build });
    if (request.method === "GET" && url.pathname === "/revision") return json({ revision: cache.revision });
    if (request.method === "GET" && url.pathname === "/metrics") return json({ ...cache.stats, projects: cache.projects.size, revision: cache.revision });
    if (request.method === "POST" && url.pathname === "/shutdown") { setTimeout(shutdown, 50); return json({ stopped: true }); }
    if (request.method !== "POST" || url.pathname !== "/snapshot") return json({ error: "Not found" }, 404);
    try {
      let body;
      try { body = JSON.parse(await readBody(request)); }
      catch (error) {
        response.setHeader("connection", "close");
        return json({ error: error.status === 413 ? "Request body too large" : "Invalid JSON" }, error.status ?? 400);
      }
      if (!body || typeof body.directory !== "string" || !body.directory.startsWith("/") || body.directory.length > 4096
        || (body.limit !== undefined && (!Number.isInteger(body.limit) || body.limit < 1 || body.limit > 1000))
        || (body.force !== undefined && typeof body.force !== "boolean")) return json({ error: "Invalid request" }, 400);
      return json(await cache.snapshot(body.directory, body.limit ?? 10, body.force === true));
    } catch { return json({ error: "OpenCode API unavailable or directory not found. Check the local service and directory, then refresh." }, 503); }
  } catch { if (!response.headersSent) json({ error: "Invalid request" }, 400); else response.destroy(); }
});
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
});
await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
const temporary = `${registration}.${process.pid}.tmp`;
await writeFile(temporary, JSON.stringify({ version: 1, build, pid: process.pid, port: server.address().port, token }), { mode: 0o600 });
await rename(temporary, registration);
void upstream.events(event => cache.event(event));

async function shutdown() {
  if (closing) return;
  closing = true; upstream.close();
  if ((await registered())?.pid === process.pid) await unlink(registration).catch(() => {});
  server.close(); server.closeAllConnections(); process.exit(0);
}
process.on("SIGTERM", shutdown); process.on("SIGINT", shutdown);
// A hidden/closed app doesn't leave a bridge resident forever. The next use
// rediscovers/restarts it; this never stops or replaces OpenCode's own service.
setInterval(() => { if (Date.now() - lastUse > 5 * 60000) void shutdown(); }, 30000).unref();
