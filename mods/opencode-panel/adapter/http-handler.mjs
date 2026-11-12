import { timingSafeEqual } from "node:crypto";

export const MAX_BODY = 4096;
export const json = (value, status = 200) => Response.json(value, {
  status, headers: { "cache-control": "no-store", ...([400, 413].includes(status) ? { connection: "close" } : {}) },
});

// Bun passes its native Request; Node supplies only the same fields we use:
// url, method, Headers and a bounded json() reader. Routing/security live here.
export function createHandler({ token, build, cache, onUse, shutdown }) {
  const expected = Buffer.from(`Bearer ${token}`);
  return async (request, port) => {
    try {
      const url = new URL(request.url), host = request.headers.get("host");
      if (request.headers.has("origin") || url.hostname !== "127.0.0.1"
        || (host !== "127.0.0.1" && host !== `127.0.0.1:${port}`)) return json({ error: "Forbidden" }, 403);
      const provided = Buffer.from(request.headers.get("authorization") || "");
      if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return json({ error: "Unauthorized" }, 401);
      if (Number(request.headers.get("content-length")) > MAX_BODY) return json({ error: "Request body too large" }, 413);
      onUse();
      if (request.method === "GET" && url.pathname === "/health") return json({ version: 1, build });
      if (request.method === "GET" && url.pathname === "/revision") { await cache.activity(); return json({ revision: cache.revision }); }
      if (request.method === "GET" && url.pathname === "/metrics") return json({ ...cache.stats, projects: cache.projects.size, revision: cache.revision });
      if (request.method === "POST" && url.pathname === "/shutdown") { setTimeout(shutdown, 50); return json({ stopped: true }); }
      if (request.method !== "POST" || url.pathname !== "/snapshot") return json({ error: "Not found" }, 404);
      let body;
      try { body = await request.json(); }
      catch (error) { return json({ error: error?.status === 413 ? "Request body too large" : "Invalid JSON" }, error?.status === 413 ? 413 : 400); }
      if (!body || typeof body.directory !== "string" || !body.directory.startsWith("/") || body.directory.length > 4096
        || (body.limit !== undefined && (!Number.isInteger(body.limit) || body.limit < 1 || body.limit > 1000))
        || (body.force !== undefined && typeof body.force !== "boolean")
        || (body.allProjects !== undefined && typeof body.allProjects !== "boolean")) return json({ error: "Invalid request" }, 400);
      try { return json(await cache.snapshot(body.directory, body.limit ?? 10, body.force === true, body.allProjects === true)); }
      catch { return json({ error: "OpenCode API unavailable or directory not found. Check the local service and directory, then refresh." }, 503); }
    } catch { return json({ error: "Invalid request" }, 400); }
  };
}
