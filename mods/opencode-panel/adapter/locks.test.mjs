import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("Bun and npm lock the same dependency versions and integrity hashes", () => {
  const read = name => readFileSync(new URL(name, import.meta.url), "utf8");
  // Bun's text lockfile is JSON with trailing commas; this fixture has no comments.
  const bun = JSON.parse(read("./bun.lock").replace(/,\s*([}\]])/g, "$1"));
  const npm = JSON.parse(read("./package-lock.json"));
  const manifest = JSON.parse(read("./package.json"));
  assert.deepEqual(bun.workspaces[""].dependencies, manifest.dependencies);
  assert.deepEqual(npm.packages[""].dependencies, manifest.dependencies);
  assert.deepEqual(npm.packages[""].engines, manifest.engines);
  assert.equal(Object.keys(npm.packages).length - 1, Object.keys(bun.packages).length);
  for (const [name, entry] of Object.entries(bun.packages)) {
    const locked = npm.packages[`node_modules/${name}`];
    assert.equal(locked.version, entry[0].slice(entry[0].lastIndexOf("@") + 1), name);
    assert.equal(locked.integrity, entry.at(-1), name);
  }
});
