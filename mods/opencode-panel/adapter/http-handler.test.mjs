import test from "node:test";
import assert from "node:assert/strict";
import { createHandler, MAX_BODY } from "./http-handler.mjs";

function fixture() {
  const state = { reads: 0, uses: 0, snapshots: [], fail: false };
  const cache = { revision: 7, stats: { listRequests: 2 }, projects: new Map([["project", {}]]),
    async activity() {},
    async snapshot(...args) {
      state.snapshots.push(args);
      if (state.fail) throw new Error("private fixture upstream details");
      return { sessions: [], revision: 7 };
    } };
  const handle = createHandler({ token: "fixture-token", build: "fixture-build", cache,
    onUse: () => state.uses++, shutdown() {} });
  const request = ({ path = "/snapshot", method = "POST", headers = {}, body = { directory: "/repo" }, error } = {}) => handle({
    url: `http://127.0.0.1:12345${path}`, method,
    headers: new Headers({ host: "127.0.0.1:12345", authorization: "Bearer fixture-token", ...headers }),
    async json() { state.reads++; if (error) throw error; return body; },
  }, 12345);
  return { state, request };
}

test("shared handler authenticates before reading bodies or querying OpenCode", async () => {
  const f = fixture();
  for (const authorization of ["", "Bearer wrong", "Bearer fixture-tokeX"]) {
    const response = await f.request({ headers: { authorization } });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
  assert.equal(f.state.reads, 0); assert.equal(f.state.uses, 0);
  assert.deepEqual(f.state.snapshots, []);
});

test("shared handler rejects browser origins and non-loopback or wrong-port hosts", async () => {
  const f = fixture();
  for (const headers of [{ origin: "" }, { origin: "https://untrusted.example" }, { host: "untrusted.example" }, { host: "127.0.0.1:54321" }]) {
    assert.equal((await f.request({ headers })).status, 403);
  }
  assert.equal(f.state.reads, 0); assert.equal(f.state.uses, 0);
});

test("shared handler checks declared body limits before parsing", async () => {
  const f = fixture();
  const response = await f.request({ headers: { "content-length": String(MAX_BODY + 1) } });
  assert.equal(response.status, 413);
  assert.equal(f.state.reads, 0);
  assert.deepEqual(await response.json(), { error: "Request body too large" });
});

test("shared handler passes validated snapshot arguments and defaults", async () => {
  const f = fixture();
  assert.deepEqual(await (await f.request()).json(), { sessions: [], revision: 7 });
  assert.equal((await f.request({ body: { directory: "/repo/worktree", limit: 30, force: true } })).status, 200);
  assert.equal((await f.request({ body: { directory: "/repo", allProjects: true } })).status, 200);
  assert.deepEqual(f.state.snapshots, [["/repo", 10, false, false], ["/repo/worktree", 30, true, false], ["/repo", 10, false, true]]);
  assert.equal((await f.request({ body: { directory: "/repo", allProjects: "true" } })).status, 400);
});

test("shared handler sanitizes JSON reader and upstream errors", async () => {
  const f = fixture();
  const malformed = await f.request({ error: new Error("private body-reader details") });
  assert.equal(malformed.status, 400);
  assert.deepEqual(await malformed.json(), { error: "Invalid JSON" });
  const oversized = await f.request({ error: Object.assign(new Error("private transport details"), { status: 413 }) });
  assert.equal(oversized.status, 413);
  assert.deepEqual(await oversized.json(), { error: "Request body too large" });
  f.state.fail = true;
  const unavailable = await f.request();
  assert.equal(unavailable.status, 503);
  assert.deepEqual(await unavailable.json(), { error: "OpenCode API unavailable or directory not found. Check the local service and directory, then refresh." });
});

test("shared metadata routes do not read a body or expose credentials", async () => {
  const f = fixture();
  assert.deepEqual(await (await f.request({ path: "/health", method: "GET" })).json(), { version: 1, build: "fixture-build" });
  assert.deepEqual(await (await f.request({ path: "/revision", method: "GET" })).json(), { revision: 7 });
  assert.deepEqual(await (await f.request({ path: "/metrics", method: "GET" })).json(), { listRequests: 2, projects: 1, revision: 7 });
  assert.equal(f.state.reads, 0); assert.deepEqual(f.state.snapshots, []);
});

test("shared handler rejects unsupported routes and methods without reading bodies", async () => {
  const f = fixture();
  assert.equal((await f.request({ path: "/unknown" })).status, 404);
  assert.equal((await f.request({ path: "/snapshot", method: "GET" })).status, 404);
  assert.equal(f.state.reads, 0); assert.deepEqual(f.state.snapshots, []);
});
