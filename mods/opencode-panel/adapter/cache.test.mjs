import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProjectCache } from "./cache.mjs";
import { checkout } from "./roots.mjs";
import { Upstream } from "./upstream.mjs";

const rows = count => Array.from({ length: count }, (_, i) => ({ id: `ses_${i}`, title: `Session ${i}`,
  projectID: "project-1", time: { created: 100, updated: 10000 - i }, location: { directory: "/repo" } }));

function fixture({ count = 80, resolve, listing } = {}) {
  let now = 100000;
  const calls = [];
  const client = {
    location: { get: async input => { calls.push(["location", input]); return { project: { id: input.location.directory.startsWith("/nested") ? "project-2" : "project-1", canonical: "/repo" } }; } },
    session: { list: async input => {
      calls.push(["list", input]);
      if (listing) return listing(input);
      const offset = input.cursor ? Number(input.cursor) : 0;
      return { data: rows(count).slice(offset, offset + input.limit), cursor: { next: offset + input.limit < count ? String(offset + input.limit) : null } };
    } },
  };
  const store = new ProjectCache({ call: body => body(client), now: () => now,
    resolve: resolve ?? (async directory => ({ directory, root: "/repo", identity: "repo-git" })) });
  return { store, calls, advance(ms) { now += ms; } };
}

test("cd within one project resolves once and lists once", async () => {
  const f = fixture();
  const a = await f.store.snapshot("/repo", 10);
  const b = await f.store.snapshot("/repo/web", 10);
  const c = await f.store.snapshot("/repo/web/components", 10);
  expect(a.projectID).toBe(b.projectID); expect(b.projectID).toBe(c.projectID);
  expect(f.store.stats.locationRequests).toBe(1);
  expect(f.store.stats.listRequests).toBe(1);
});

test("sibling worktrees share the API project cache", async () => {
  const f = fixture({ resolve: async directory => ({ directory, root: directory, identity: directory }) });
  await f.store.snapshot("/repo"); await f.store.snapshot("/tree");
  expect(f.store.stats.locationRequests).toBe(2);
  expect(f.store.stats.listRequests).toBe(1);
});

test("concurrent callers deduplicate resolution and session reads", async () => {
  const f = fixture();
  await Promise.all([f.store.snapshot("/repo"), f.store.snapshot("/repo/web"), f.store.snapshot("/repo/web/ui")]);
  expect(f.store.stats.locationRequests).toBe(1);
  expect(f.store.stats.listRequests).toBe(1);
});

test("stale-while-revalidate preserves rows and shares one refresh", async () => {
  const f = fixture();
  const first = await f.store.snapshot("/repo");
  f.advance(31000);
  const second = await f.store.snapshot("/repo");
  expect(second.sessions).toEqual(first.sessions);
  await f.store.projects.get(first.projectID).flight;
  expect(f.store.stats.listRequests).toBe(2);
});

test("cursor pagination loads older sessions, not repeated prefixes", async () => {
  const f = fixture();
  await f.store.snapshot("/repo", 10);
  await f.store.snapshot("/repo", 50);
  await f.store.projects.get("project-1").flight;
  expect(f.store.projects.get("project-1").sessions.length).toBe(50);
  expect(f.calls.filter(([name]) => name === "list").at(-1)[1].cursor).toBe("30");
});

test("events invalidate only the relevant cached project when known", async () => {
  const f = fixture({ resolve: async directory => ({ directory, root: directory, identity: directory }) });
  await f.store.snapshot("/repo"); await f.store.snapshot("/nested");
  f.store.event({ type: "session.renamed", data: { projectID: "project-1" } });
  expect(f.store.projects.get("project-1").dirty).toBe(2);
  expect(f.store.projects.get("project-2").dirty).toBe(1);
});

test("service reconnect invalidates caches without discarding their rows", async () => {
  const f = fixture(); await f.store.snapshot("/repo");
  const first = f.store.projects.get("project-1").sessions;
  f.store.event({ type: "server.connected" });
  expect(f.store.projects.get("project-1").sessions).toBe(first);
  expect(f.store.projects.get("project-1").dirty).toBe(2);
});

test("filesystem resolution detects nested repos and worktree .git files", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "herdr-roots-")));
  try {
    await mkdir(path.join(root, ".git")); await mkdir(path.join(root, "web", "nested"), { recursive: true });
    await mkdir(path.join(root, "web", "nested", ".git"));
    await mkdir(path.join(root, "tree")); await writeFile(path.join(root, "tree", ".git"), "gitdir: ../.git/worktrees/test\n");
    expect((await checkout(path.join(root, "web"))).root).toBe(root);
    expect((await checkout(path.join(root, "web", "nested"))).root).toBe(path.join(root, "web", "nested"));
    expect((await checkout(path.join(root, "tree"))).root).toBe(path.join(root, "tree"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const auth of [undefined, { type: "basic", username: "fixture-user", password: "fixture-password" }]) {
  test(`official SDK reuses discovery authentication (${auth ? "authenticated" : "disabled"})`, async () => {
    const expected = auth ? `Basic ${Buffer.from("fixture-user:fixture-password").toString("base64")}` : null;
    let requests = 0;
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
      requests++; expect(request.headers.get("authorization")).toBe(expected);
      return Response.json({ directory: "/repo", project: { id: "fixture", directory: "/repo", canonical: "/repo" } });
    } });
    const connection = new Upstream({ discover: async () => ({ url: `http://127.0.0.1:${server.port}`, auth }) });
    try {
      const location = await connection.call(client => client.location.get({ location: { directory: "/repo" } }));
      expect(location.project.id).toBe("fixture"); expect(requests).toBe(1);
    } finally { connection.close(); server.stop(true); }
  });
}

test("credentials are rediscovered after a connection failure", async () => {
  let discoveries = 0;
  const connection = new Upstream({ discover: async () => { discoveries++; return { url: "http://127.0.0.1:1", auth: undefined }; } });
  await expect(connection.call(() => Promise.reject(new Error("transport fixture")))).rejects.toThrow("API unavailable");
  await expect(connection.call(() => Promise.reject(new Error("transport fixture")))).rejects.toThrow("API unavailable");
  expect(discoveries).toBe(2);
  connection.close();
});
