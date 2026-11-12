import { appHome, home, exec, readTextFile } from "herdr";

// Probe runtimes separately: an adapter/dependency failure must never silently
// launch a second copy under a different runtime.
export async function startAdapter(script) {
  for (const command of ["bun", home() + "/.bun/bin/bun", "node"]) {
    let version;
    try { version = await exec(command, ["--version"]); }
    catch { continue; } // Herdr rejects when the executable cannot start.
    if (version.code !== 0) throw new Error("Cannot check the JavaScript runtime. Check its installation.");
    const nodeMajor = Number(/^v?(\d+)\./.exec(version.stdout.trim())?.[1]);
    if (command === "node" && !(nodeMajor >= 22)) {
      throw new Error("OpenCode Panel needs Node.js 22 or newer, or Bun.");
    }
    let result;
    try { result = await exec(command, [script]); }
    catch { throw new Error("Cannot launch the OpenCode API adapter. Check the selected runtime."); }
    if (result.code !== 0) throw new Error("Cannot start OpenCode API adapter. Install its dependencies with bun install --frozen-lockfile or npm ci in mods/opencode-panel/adapter.");
    return;
  }
  throw new Error("No JavaScript runtime found. Install Bun or Node.js 22 or newer.");
}

export class LocalAdapter {
  constructor() { this.endpoint = null; this.starting = null; }

  async ensure() {
    if (this.endpoint) return this.endpoint;
    if (!this.starting) this.starting = (async () => {
      const script = appHome() + "/mods/opencode-panel/adapter/launch.mjs";
      await startAdapter(script);
      const value = JSON.parse(await readTextFile(appHome() + "/data/opencode-panel/bridge.json"));
      if (value.version !== 1 || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535
        || !/^[a-f0-9]{64}$/.test(value.token)) throw new Error("Invalid local adapter registration.");
      this.endpoint = value;
      return value;
    })().finally(() => { this.starting = null; });
    return this.starting;
  }

  async request(route, body, retried = false) {
    const endpoint = await this.ensure();
    let response;
    try {
      response = await fetch(`http://127.0.0.1:${endpoint.port}${route}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { authorization: `Bearer ${endpoint.token}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      this.endpoint = null;
      if (!retried) return this.request(route, body, true);
      throw new Error("OpenCode API adapter is unavailable.");
    }
    if (response.status === 401 && !retried) { this.endpoint = null; return this.request(route, body, true); }
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || "OpenCode API request failed.");
    return value;
  }

  snapshot(directory, limit = 10, force = false, allProjects = false) { return this.request("/snapshot", { directory, limit, force, allProjects }); }
  revision() { return this.request("/revision"); }
}
