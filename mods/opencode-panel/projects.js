// Per-machine project views survive space/tab/cwd navigation for this mod copy.
export class ProjectViews {
  constructor() { this.entries = new Map(); this.directories = new Map(); this.roots = new Map(); }
  directoryKey(context) { return JSON.stringify([context.on ?? null, context.cwd]); }
  key(context, projectID) { return JSON.stringify([context.on ?? null, projectID]); }
  exact(context) { return this.entries.get(this.directories.get(this.directoryKey(context))); }
  get(context) {
    const exact = this.exact(context);
    if (exact) return exact;
    // Optimistic display only; the adapter still checks .git boundaries before
    // confirming an unseen directory (including nested repos and worktrees).
    const roots = [...this.roots.values()].filter(root => root.on === (context.on ?? null)
      && (context.cwd === root.root || context.cwd?.startsWith(root.root + "/")))
      .sort((a, b) => b.root.length - a.root.length);
    return this.entries.get(roots[0]?.key);
  }
  update(context, snapshot) {
    const key = this.key(context, snapshot.projectID);
    let entry = this.entries.get(key);
    if (!entry) { entry = { key, projectID: snapshot.projectID, sessions: [], extra: 0, checked: 0 }; this.entries.set(key, entry); }
    const fingerprint = JSON.stringify([snapshot.sessions, snapshot.hasMore, snapshot.loading, snapshot.error, snapshot.capped]);
    const changed = entry.fingerprint !== fingerprint;
    if (changed) Object.assign(entry, { sessions: snapshot.sessions, hasMore: snapshot.hasMore,
      loading: snapshot.loading, error: snapshot.error, capped: snapshot.capped, fingerprint });
    entry.checked = Date.now();
    this.directories.set(this.directoryKey(context), key);
    this.roots.set(JSON.stringify([context.on ?? null, snapshot.root]), { on: context.on ?? null, root: snapshot.root, key });
    // Bound session metadata and location hints during a long-lived app session.
    if (this.entries.size > 32) {
      const oldest = [...this.entries.values()].filter(e => e.key !== key).sort((a, b) => a.checked - b.checked)[0];
      if (oldest) this.entries.delete(oldest.key);
    }
    for (const map of [this.directories, this.roots]) if (map.size > 512) map.delete(map.keys().next().value);
    return { entry, changed };
  }
}
