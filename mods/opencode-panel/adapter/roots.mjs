import { realpath, stat } from "node:fs/promises";
import path from "node:path";

// Filesystem checks, not subprocesses. Walk from the actual cwd so a nested
// repository never inherits its parent's cached project by prefix alone.
export async function checkout(directory) {
  const physical = await realpath(directory);
  if (!(await stat(physical)).isDirectory()) throw new Error("Not a directory");
  for (let root = physical;; root = path.dirname(root)) {
    try {
      const marker = await stat(path.join(root, ".git"));
      return { directory: physical, root, identity: `${root}:${marker.dev}:${marker.ino}:${marker.mtimeMs}` };
    } catch (error) { if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error; }
    if (root === path.dirname(root)) return { directory: physical, root: physical, identity: physical };
  }
}
