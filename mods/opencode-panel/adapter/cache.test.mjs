import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
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
  assert.equal(a.projectID, b.projectID); assert.equal(b.projectID, c.projectID);
  assert.equal(f.store.stats.locationRequests, 1);
  assert.equal(f.store.stats.listRequests, 1);
});

test("sibling worktrees share the API project cache", async () => {
  const f = fixture({ resolve: async directory => ({ directory, root: directory, identity: directory }) });
  await f.store.snapshot("/repo"); await f.store.snapshot("/tree");
  assert.equal(f.store.stats.locationRequests, 2);
  assert.equal(f.store.stats.listRequests, 1);
});

test("concurrent callers deduplicate resolution and session reads", async () => {
  const f = fixture();
  await Promise.all([f.store.snapshot("/repo"), f.store.snapshot("/repo/web"), f.store.snapshot("/repo/web/ui")]);
  assert.equal(f.store.stats.locationRequests, 1);
  assert.equal(f.store.stats.listRequests, 1);
});

test("stale-while-revalidate preserves rows and shares one refresh", async () => {
  const f = fixture();
  const first = await f.store.snapshot("/repo");
  f.advance(31000);
  const second = await f.store.snapshot("/repo");
  assert.deepEqual(second.sessions, first.sessions);
  await f.store.projects.get(first.projectID).flight;
  assert.equal(f.store.stats.listRequests, 2);
});

test("cursor pagination loads older sessions, not repeated prefixes", async () => {
  const f = fixture();
  await f.store.snapshot("/repo", 10);
  await f.store.snapshot("/repo", 50);
  await f.store.projects.get("project-1").flight;
  assert.equal(f.store.projects.get("project-1").sessions.length, 50);
  assert.equal(f.calls.filter(([name]) => name === "list").at(-1)[1].cursor, "30");
});

test("events invalidate only the relevant cached project when known", async () => {
  const f = fixture({ resolve: async directory => ({ directory, root: directory, identity: directory }) });
  await f.store.snapshot("/repo"); await f.store.snapshot("/nested");
  f.store.event({ type: "session.renamed", data: { projectID: "project-1" } });
  assert.equal(f.store.projects.get("project-1").dirty, 2);
  assert.equal(f.store.projects.get("project-2").dirty, 1);
});

test("all-projects view omits the project filter and is invalidated by every project", async () => {
  const f = fixture();
  await f.store.snapshot("/repo");
  const all = await f.store.snapshot("/repo", 10, false, true);
  assert.equal(all.projectID, null);
  assert.equal(f.store.stats.locationRequests, 1);
  assert.equal(Object.hasOwn(f.calls.filter(([name]) => name === "list").at(-1)[1], "project"), false);
  await f.store.snapshot("/other-project", 10, false, true);
  assert.equal(f.store.stats.listRequests, 2);
  f.store.event({ type: "session.created", data: { projectID: "unseen-project" } });
  assert.equal(f.store.projects.get(null).dirty, 2);
  assert.equal(f.store.projects.get("project-1").dirty, 1);
  await f.store.snapshot("/repo", 50, false, true);
  await f.store.projects.get(null).flight;
  assert.equal(f.store.projects.get(null).sessions.length, 50);
});

test("service reconnect invalidates caches without discarding their rows", async () => {
  const f = fixture(); await f.store.snapshot("/repo");
  const first = f.store.projects.get("project-1").sessions;
  f.store.event({ type: "server.connected" });
  assert.equal(f.store.projects.get("project-1").sessions, first);
  assert.equal(f.store.projects.get("project-1").dirty, 2);
});

test("filesystem resolution detects nested repos and worktree .git files", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "herdr-roots-")));
  try {
    await mkdir(path.join(root, ".git")); await mkdir(path.join(root, "web", "nested"), { recursive: true });
    await mkdir(path.join(root, "web", "nested", ".git"));
    await mkdir(path.join(root, "tree")); await writeFile(path.join(root, "tree", ".git"), "gitdir: ../.git/worktrees/test\n");
    assert.equal((await checkout(path.join(root, "web"))).root, root);
    assert.equal((await checkout(path.join(root, "web", "nested"))).root, path.join(root, "web", "nested"));
    assert.equal((await checkout(path.join(root, "tree"))).root, path.join(root, "tree"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const auth of [undefined, { type: "basic", username: "fixture-user", password: "fixture-password" }]) {
  test(`official SDK reuses discovery authentication (${auth ? "authenticated" : "disabled"})`, async () => {
    const expected = auth ? `Basic ${Buffer.from("fixture-user:fixture-password").toString("base64")}` : null;
    let requests = 0;
    const server = createServer((request, response) => {
      requests++; assert.equal(request.headers.authorization ?? null, expected);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ directory: "/repo", project: { id: "fixture", directory: "/repo", canonical: "/repo" } }));
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const connection = new Upstream({ discover: async () => ({ url: `http://127.0.0.1:${server.address().port}`, auth }) });
    try {
      const location = await connection.call(client => client.location.get({ location: { directory: "/repo" } }));
      assert.equal(location.project.id, "fixture"); assert.equal(requests, 1);
    } finally { connection.close(); server.close(); server.closeAllConnections(); }
  });
}

test("credentials are rediscovered after a connection failure", async () => {
  let discoveries = 0;
  const connection = new Upstream({ discover: async () => { discoveries++; return { url: "http://127.0.0.1:1", auth: undefined }; } });
  await assert.rejects(connection.call(() => Promise.reject(new Error("transport fixture"))), /API unavailable/);
  await assert.rejects(connection.call(() => Promise.reject(new Error("transport fixture"))), /API unavailable/);
  assert.equal(discoveries, 2);
  connection.close();
});
