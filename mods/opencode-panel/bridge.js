import { appHome, home, exec, readTextFile } from "herdr";

export class LocalAdapter {
  constructor() { this.endpoint = null; this.starting = null; }

  async ensure() {
    if (this.endpoint) return this.endpoint;
    if (!this.starting) this.starting = (async () => {
      const script = appHome() + "/mods/opencode-panel/adapter/launch.mjs";
      let result;
      try { result = await exec("bun", [script]); }
      catch { result = await exec(home() + "/.bun/bin/bun", [script]); }
      if (result.code !== 0) throw new Error("Cannot start OpenCode API adapter. Check its dependency installation.");
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

  snapshot(directory, limit = 10, force = false) { return this.request("/snapshot", { directory, limit, force }); }
  revision() { return this.request("/revision"); }
}
