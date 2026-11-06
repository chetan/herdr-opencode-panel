import { OpenCode } from "@opencode/client";
import { Service } from "@opencode/client/service";
import { setTimeout as sleep } from "node:timers/promises";

export const EVENT_TYPES = ["session.created", "session.renamed", "session.moved", "session.deleted",
  "session.archived", "session.unarchived", "session.forked", "session.execution.started",
  "session.execution.succeeded", "session.execution.failed", "session.execution.interrupted",
  "project.updated", "worktree.updated", "worktree.resolved"];

export class Upstream {
  constructor({ discover = Service.discover, headers = Service.headers, make = OpenCode.make } = {}) {
    this.discover = discover; this.headers = headers; this.make = make;
    this.client = null; this.connecting = null; this.controller = null; this.stopped = false;
  }

  async connect() {
    if (this.client) return this.client;
    if (!this.connecting) this.connecting = (async () => {
      const endpoint = await this.discover({ ...(process.env.HERDR_OPENCODE_SERVICE_FILE ? { file: process.env.HERDR_OPENCODE_SERVICE_FILE } : {}), version: v => v.startsWith("2.") });
      if (!endpoint) throw new Error("No running OpenCode 2.x service. Run opencode service start.");
      // SDK owns registration/credential parsing. With auth disabled this is {}.
      this.client = this.make({ baseUrl: endpoint.url, headers: this.headers(endpoint) });
      return this.client;
    })().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  async call(body) {
    try { return await body(await this.connect()); }
    catch (error) {
      if (error?._tag === "LocationNotFoundError") throw new Error("The terminal directory no longer exists.");
      this.client = null; this.controller?.abort();
      throw new Error("OpenCode API unavailable. Check the local service, then refresh.");
    }
  }

  async events(receive) {
    while (!this.stopped) {
      try {
        const client = await this.connect();
        this.controller = new AbortController();
        for await (const event of client.event.subscribe({ types: EVENT_TYPES, signal: this.controller.signal })) {
          receive(event);
          if (this.stopped) break;
        }
      } catch { /* server restarts rediscover endpoint + credentials; never log them */ }
      this.client = null;
      if (!this.stopped) await sleep(1000);
    }
  }

  close() { this.stopped = true; this.controller?.abort(); }
}
