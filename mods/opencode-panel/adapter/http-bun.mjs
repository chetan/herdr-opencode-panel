import { MAX_BODY, json } from "./http-handler.mjs";

export function serve(handle) {
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0, maxRequestBodySize: MAX_BODY,
    development: false, // Never expose Bun's development error page.
    fetch(request, server) { return handle(request, server.port); },
    error() { return json({ error: "Invalid request" }, 400); },
  });
  return { port: server.port, stop: () => server.stop(true) };
}
