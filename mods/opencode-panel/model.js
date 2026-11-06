export const DAY = 24 * 60 * 60 * 1000;
export const DEFAULT_COUNT = 10;

export function directoryKey(path) {
  return typeof path === "string" ? path.replace(/\/+$/, "") || "/" : "";
}

// The CLI already resolves the current project's scope, including worktrees.
// Do not re-filter by session.directory: it can be a checkout root or a sibling
// worktree even when the CLI was invoked from a nested package directory.
export function projectSessions(records) {
  if (!Array.isArray(records)) throw new Error("OpenCode returned an invalid session list.");
  const seen = new Set();
  return records.filter(session => {
    if (!session || !/^ses_[a-zA-Z0-9]+$/.test(session.id) || seen.has(session.id)
      || typeof session.directory !== "string" || !session.directory) return false;
    seen.add(session.id);
    return true;
  }).map(session => ({
    id: session.id,
    title: typeof session.title === "string" && session.title.trim() ? session.title : "Untitled session",
    directory: session.directory,
    updated: Number(session.updated) || Number(session.created) || 0,
  })).sort((a, b) => b.updated - a.updated || a.id.localeCompare(b.id));
}

export function initialCount(sessions) {
  return Math.min(sessions.length, DEFAULT_COUNT);
}

export function age(timestamp, now = Date.now()) {
  const minutes = Math.max(0, Math.floor((now - timestamp) / 60000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`;
  return `${Math.floor(minutes / 1440)}d ago`;
}

// Stop once the requested number is available or the CLI history is exhausted.
export function scanComplete(records, matches, limit, minimum) {
  return records.length < limit || matches.length >= minimum;
}

export function sessionTab(session, space) {
  return { space, folder: session.directory, name: session.title, argv: ["opencode", "--session", session.id] };
}
