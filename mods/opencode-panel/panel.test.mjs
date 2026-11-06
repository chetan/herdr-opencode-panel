import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import * as model from "./model.js";
import { ProjectViews } from "./projects.js";

const rows = Array.from({ length: 40 }, (_, i) => ({ id: `ses_${i}`, title: `Session ${i}`, updated: Date.now() - i * 60000, directory: "/repo" }));
const snapshot = (directory, projectID = "project-1") => ({ directory, root: directory.startsWith("/different") ? "/different" : "/repo", projectID,
  sessions: rows, hasMore: true, loading: false, error: null, revision: 1 });

function harness(responder = directory => snapshot(directory)) {
  const actions = [], calls = [], jobs = [], buttons = new Map();
  const state = { cwd: "/repo", space: "space-1", on: null, revision: 1 };
  function element(id) {
    const target = { _id: id, _children: [], click: null };
    let proxy;
    proxy = new Proxy(target, { get(object, key) {
      if (key in object) return object[key];
      if (key === "id") return id => { object._id = id; buttons.set(id, proxy); return proxy; };
      if (key === "child") return child => { object._children.push(child); return proxy; };
      if (key === "children") return children => { object._children.push(...children); return proxy; };
      if (key === "when") return (condition, body) => condition ? body(proxy) : proxy;
      if (key === "on_click") return handler => { object.click = handler; return proxy; };
      return () => proxy;
    } });
    if (id) buttons.set(id, proxy);
    return proxy;
  }
  const cx = { notify() {}, timer: { every() {} }, focus_handle: () => ({ focus() {} }),
    spawn(task) { jobs.push(Promise.resolve().then(() => task(cx))); } };
  const sandbox = {
    ...model, ProjectViews, View: class {}, div: element, svg: element, image: element, h_flex: element, v_flex: element,
    Button: { new: element }, Date, Set, Map, JSON,
    LocalAdapter: class {
      snapshot(directory, limit, force) { calls.push({ directory, limit, force }); return Promise.resolve(responder(directory, limit, force)); }
      revision() { return Promise.resolve({ revision: state.revision }); }
    },
    spaces: () => [{ id: state.space, active: true, machine: state.on, tabs: [{ id: "tab-1", active: true }] }],
    panes: () => [{ tab: "tab-1", focused: true, cwd: state.cwd }],
    focused: () => ({ tab: "tab-1", cwd: state.cwd, terminal: "t1" }),
    theme: () => ({}),
    nextCommand: () => new Promise(() => {}), notify() {}, exec: () => { throw new Error("Local queries must not shell out"); },
    run: (command, args) => actions.push({ command, args }),
  };
  const source = readFileSync(new URL("./main.js", import.meta.url), "utf8").replace(/^import .*;\n/gm, "")
    .replace("export default class OpenCodeSessions", "globalThis.Panel = class OpenCodeSessions");
  vm.runInNewContext(source, sandbox);
  const panel = new sandbox.Panel(); panel.init({}, cx);
  return { panel, cx, state, calls, actions, buttons, view: () => panel.views.get({ cwd: state.cwd, on: state.on }),
    async settle() { await Promise.all(jobs.slice(1)); await new Promise(resolve => setImmediate(resolve)); await Promise.all(jobs.slice(1)); } };
}
const renderOnly = { spawn() { throw new Error("render must not spawn"); }, notify() { throw new Error("render must not notify"); } };

test("renders ten sessions and launches a selected session in the current space", async () => {
  const h = harness(); h.panel.refresh(h.cx); await h.settle(); h.panel.render(renderOnly);
  assert.equal([...h.buttons.keys()].filter(id => /^session-ses_/.test(id)).length, 10);
  h.buttons.get("session-ses_0").click();
  assert.deepEqual(JSON.parse(JSON.stringify(h.actions)), [{ command: "tab.new", args: {
    space: "space-1", folder: "/repo", name: "Session 0", argv: ["opencode", "--session", "ses_0"],
  } }]);
});

test("works without custom layout IDs or a layout API", async () => {
  const h = harness(); h.panel.tick(h.cx); await h.settle(); h.panel.render(renderOnly);
  assert.equal(h.calls.length, 1);
  assert.equal(h.buttons.has("session-ses_0"), true);
});

test("Show more and returning spaces preserve expansion per project", async () => {
  const h = harness(); h.panel.refresh(h.cx); await h.settle(); h.panel.more(h.cx);
  assert.equal(h.view().extra, 20);
  h.state.space = "space-2"; h.panel.tick(h.cx); await h.settle();
  h.panel.render(renderOnly);
  assert.equal(h.calls.length, 1);
  assert.equal([...h.buttons.keys()].filter(id => /^session-ses_/.test(id)).length, 30);
});

test("cd to an unseen child keeps cached rows during project resolution", async () => {
  let finish;
  const h = harness(directory => directory === "/repo" ? snapshot(directory) : new Promise(resolve => { finish = resolve; }));
  h.panel.refresh(h.cx); await h.settle();
  h.state.cwd = "/repo/web"; h.buttons.clear(); h.panel.render(renderOnly);
  assert.equal(h.buttons.has("sessions-loading"), false);
  assert.equal(h.buttons.has("session-ses_0"), true);
  h.panel.tick(h.cx); await new Promise(resolve => setImmediate(resolve));
  finish(snapshot("/repo/web")); await h.settle();
  h.state.cwd = "/repo"; h.panel.tick(h.cx); await h.settle();
  assert.equal(h.calls.length, 2); // neither directory transition performs a CLI call
});

test("a new project gets placeholders; late old responses never replace the new project", async () => {
  let finish;
  const h = harness(directory => directory === "/repo" ? new Promise(resolve => { finish = resolve; }) : snapshot(directory, "project-2"));
  h.panel.refresh(h.cx); await new Promise(resolve => setImmediate(resolve));
  h.state.cwd = "/different"; h.panel.render(renderOnly);
  assert.equal(h.buttons.has("sessions-loading"), true);
  h.panel.refresh(h.cx); await new Promise(resolve => setImmediate(resolve));
  finish(snapshot("/repo")); await h.settle();
  assert.equal(h.view().projectID, "project-2");
  h.state.cwd = "/repo"; h.buttons.clear(); h.panel.render(renderOnly);
  assert.equal(h.buttons.has("sessions-loading"), false);
  assert.equal(h.view().projectID, "project-1");
});

test("project cache keys isolate machines and correct nested repository hints", () => {
  const views = new ProjectViews();
  views.update({ cwd: "/repo", on: null }, snapshot("/repo"));
  assert.equal(views.get({ cwd: "/repo/web", on: null }).projectID, "project-1");
  assert.equal(views.get({ cwd: "/repo", on: "remote" }), undefined);
  views.update({ cwd: "/repo/nested", on: null }, { ...snapshot("/repo/nested", "nested"), root: "/repo/nested" });
  assert.equal(views.get({ cwd: "/repo/nested/child", on: null }).projectID, "nested");
});

test("Refresh stays icon-only, and New session uses live cwd without continuation", () => {
  const h = harness(); h.state.cwd = "/repo/web"; h.panel.render(renderOnly);
  assert.equal(h.buttons.get("sessions-refresh")._children.length, 1);
  assert.equal(h.buttons.get("sessions-new")._children.includes("New session"), true);
  h.buttons.get("sessions-new").click();
  assert.deepEqual(JSON.parse(JSON.stringify(h.actions[0].args)), { space: "space-1", folder: "/repo/web", name: "OpenCode", argv: ["opencode"] });
});

test("refresh deduplicates in-flight requests", async () => {
  const h = harness(); h.panel.refresh(h.cx); h.panel.refresh(h.cx); await h.settle();
  assert.equal(h.calls.length, 1);
});

test("network failure retains already-cached sessions", async () => {
  let fail = false;
  const h = harness(directory => { if (fail) throw new Error("Fixture unavailable"); return snapshot(directory); });
  h.panel.refresh(h.cx); await h.settle(); fail = true;
  h.panel.refresh(h.cx); await h.settle(); h.panel.render(renderOnly);
  assert.equal(h.buttons.has("session-ses_0"), true);
  assert.equal(h.buttons.has("sessions-loading"), false);
});
