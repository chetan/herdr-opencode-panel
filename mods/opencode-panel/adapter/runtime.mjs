import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
export const stateDirectory = process.env.HERDR_OPENCODE_ADAPTER_STATE || path.resolve(directory, "../../../data/opencode-panel");
export const registration = path.join(stateDirectory, "bridge.json");
export const lock = path.join(stateDirectory, "start.lock");
export async function buildID() {
  const hash = createHash("sha256");
  for (const name of ["server.mjs", "http-handler.mjs", "http-bun.mjs", "http-node.mjs", "cache.mjs", "roots.mjs", "upstream.mjs", "runtime.mjs", "package.json"]) {
    hash.update(await readFile(path.join(directory, name)));
  }
  return hash.digest("hex").slice(0, 16);
}

export async function registered() {
  try {
    const value = JSON.parse(await readFile(registration, "utf8"));
    if (value.version !== 1 || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535
      || typeof value.token !== "string" || !/^[a-f0-9]{64}$/.test(value.token)) return null;
    return value;
  } catch { return null; }
}

export async function alive(value) {
  if (!value) return false;
  try {
    const response = await fetch(`http://127.0.0.1:${value.port}/health`, {
      headers: { authorization: `Bearer ${value.token}` }, signal: AbortSignal.timeout(1000),
    });
    return response.ok && (await response.json()).build === value.build;
  } catch { return false; }
}
