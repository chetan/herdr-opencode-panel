import { checkout } from "./roots.mjs";

export class ProjectCache {
  constructor({ call, resolve = checkout, now = Date.now, changed = () => {} }) {
    this.call = call; this.resolve = resolve; this.now = now; this.changed = changed;
    this.roots = new Map(); this.resolving = new Map(); this.projects = new Map();
    this.revision = 1;
    this.stats = { locationRequests: 0, listRequests: 0, cacheHits: 0 };
  }

  bump() { this.revision++; this.changed(this.revision); }

  async locate(directory) {
    const found = await this.resolve(directory), key = found.identity;
    const cached = this.roots.get(key);
    if (cached && this.now() - cached.checked < 60000) return { ...cached, directory: found.directory, root: found.root };
    if (!this.resolving.has(key)) {
      const request = this.call(async client => {
        this.stats.locationRequests++;
        const location = await client.location.get({ location: { directory: found.directory } });
        const value = { projectID: location.project.id, canonical: location.project.canonical, checked: this.now() };
        this.roots.set(key, value);
        if (this.roots.size > 512) this.roots.delete(this.roots.keys().next().value);
        return value;
      }).finally(() => this.resolving.delete(key));
      this.resolving.set(key, request);
    }
    return { ...await this.resolving.get(key), directory: found.directory, root: found.root };
  }

  invalidate(projectID) {
    for (const entry of this.projects.values()) {
      if (!projectID || entry.projectID === null || entry.projectID === projectID) { entry.dirty++; }
    }
    this.bump();
  }

  event(event) {
    if (event.type === "server.connected") { this.invalidate(); return; }
    if (event.type === "project.updated" || event.type.startsWith("worktree.")) {
      this.roots.clear(); this.invalidate(); return;
    }
    const id = event.data?.projectID;
    const sessionID = event.data?.sessionID ?? event.durable?.aggregateID;
    const known = id ?? [...this.projects.values()].find(entry => entry.sessions?.some(s => s.id === sessionID))?.projectID;
    this.invalidate(known);
  }

  async snapshot(directory, wanted = 10, force = false, allProjects = false) {
    const location = allProjects ? { projectID: null, root: null } : await this.locate(directory);
    let entry = this.projects.get(location.projectID);
    if (!entry) {
      entry = { projectID: location.projectID, sessions: null, wanted: 30, cursor: null, complete: false,
        dirty: 1, loadedDirty: 0, checked: 0, retryAt: 0, error: null, flight: null };
      this.projects.set(location.projectID, entry);
      if (this.projects.size > 32) {
        const oldest = [...this.projects.values()].filter(other => other !== entry && !other.flight).sort((a, b) => a.checked - b.checked)[0];
        if (oldest) this.projects.delete(oldest.projectID);
      }
    }
    entry.wanted = Math.min(1000, Math.max(entry.wanted, wanted));
    const needs = force || !entry.sessions || entry.dirty !== entry.loadedDirty || this.now() - entry.checked >= 30000
      || (entry.sessions.length < entry.wanted && !entry.complete);
    if (needs && (force || this.now() >= entry.retryAt)) {
      const request = this.load(entry, force);
      // Only the initial visit/manual refresh waits. Returning projects keep
      // their cached rows immediately while one shared refresh runs behind them.
      if (!entry.sessions || force) await request;
    } else this.stats.cacheHits++;
    return { ...location, sessions: entry.sessions ?? [], hasMore: !entry.complete,
      loading: Boolean(entry.flight), error: entry.error, revision: this.revision, capped: entry.wanted >= 1000 };
  }

  load(entry, force = false) {
    if (entry.flight) return entry.flight;
    const dirty = entry.dirty;
    const reset = force || !entry.sessions || dirty !== entry.loadedDirty || this.now() - entry.checked >= 30000;
    const job = (async () => {
      let rows = reset ? [] : entry.sessions.slice(), cursor = reset ? undefined : entry.cursor;
      let complete = reset ? false : entry.complete;
      do {
        const page = await this.call(client => {
          this.stats.listRequests++;
          return client.session.list({ ...(entry.projectID === null ? {} : { project: entry.projectID }), parentID: null, archived: false,
            order: "desc", limit: Math.min(100, entry.wanted - rows.length), ...(cursor ? { cursor } : {}) });
        });
        rows.push(...page.data.filter(s => !s.parentID && !s.time.archived).map(s => ({
          id: s.id, title: s.title || "Untitled session", directory: s.location.directory,
          updated: s.time.updated, created: s.time.created,
        })));
        const next = page.cursor.next;
        if (next && next === cursor) throw new Error("OpenCode returned a repeated pagination cursor");
        cursor = next; complete = !cursor;
      } while (!complete && rows.length < entry.wanted);
      const unique = [...new Map(rows.map(s => [s.id, s])).values()].sort((a, b) => b.updated - a.updated || a.id.localeCompare(b.id));
      entry.sessions = unique; entry.cursor = cursor; entry.complete = complete;
      entry.loadedDirty = dirty; entry.checked = this.now(); entry.error = null; entry.retryAt = 0;
    })().catch(() => {
      // Never expose SDK errors, request objects or authentication material.
      entry.error = "OpenCode API unavailable. Check the local service, then refresh.";
      entry.retryAt = this.now() + 5000;
      if (!entry.sessions) throw new Error(entry.error);
    }).finally(() => { entry.flight = null; this.bump(); });
    entry.flight = job;
    // Background failures are reflected in the snapshot; don't leak rejections.
    job.catch(() => {});
    return job;
  }
}
