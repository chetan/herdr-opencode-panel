import test from "node:test";
import assert from "node:assert/strict";

const { serve } = await import(typeof Bun !== "undefined" ? "./http-bun.mjs" : "./http-node.mjs");

test("active transport sanitizes uncaught errors instead of serving debug details", async () => {
  const server = await serve(() => { throw new Error("private fixture stack and source details"); });
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/fixture`);
    assert.equal(response.status, 400);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { error: "Invalid request" });
  } finally { await server.stop(); }
});
