import { createServer } from "node:http";
import { MAX_BODY, json } from "./http-handler.mjs";

// Only Node needs manual stream handling. Bound declared and chunked bodies
// without destroying the socket before the client can receive the 413 response.
function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    const cleanup = () => { request.off("data", data); request.off("end", end); request.off("error", error); request.off("aborted", error); };
    const error = () => { cleanup(); reject(new Error("Invalid body")); };
    const end = () => { cleanup(); resolve(Buffer.concat(chunks).toString("utf8")); };
    const data = chunk => {
      size += chunk.length;
      if (size > MAX_BODY) {
        cleanup(); request.resume();
        reject(Object.assign(new Error("Body too large"), { status: 413 }));
      } else chunks.push(chunk);
    };
    request.on("data", data); request.on("end", end); request.on("error", error); request.on("aborted", error);
  });
}

export async function serve(handle) {
  const server = createServer({ maxHeaderSize: 8192, requestTimeout: 15000 }, async (request, response) => {
    // Disconnects must not terminate the bridge or leak transport errors.
    request.on("error", () => {}); response.on("error", () => {});
    let reply;
    try {
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        for (const item of Array.isArray(value) ? value : [value]) if (item !== undefined) headers.append(name, item);
      }
      reply = await handle({
        url: new URL(request.url, `http://127.0.0.1:${server.address().port}`).href,
        method: request.method, headers,
        json: async () => JSON.parse(await readBody(request)),
      }, server.address().port);
    } catch { reply = json({ error: "Invalid request" }, 400); }
    request.resume(); // Drain bodies not consumed by the shared handler.
    if (response.destroyed || response.writableEnded) return;
    try {
      response.writeHead(reply.status, Object.fromEntries(reply.headers));
      response.end(Buffer.from(await reply.arrayBuffer()));
    } catch { response.destroy(); }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  return { port: server.address().port, stop: () => new Promise(resolve => {
    server.close(resolve); server.closeAllConnections();
  }) };
}
