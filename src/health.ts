import http from "http";
import { log } from "./logger";

interface HealthStats {
  getStats: () => Record<string, unknown>;
}

/**
 * Lightweight HTTP health check server.
 * - GET /health → 200 with bot stats (used by Render + uptime monitors)
 * - Everything else → 404
 */
export function startHealthServer(port: number, statsProvider: HealthStats) {
  const server = http.createServer((req, res) => {
    if (req.url === "/health" && req.method === "GET") {
      const stats = statsProvider.getStats();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", ...stats }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  server.listen(port, () => {
    log.info(`Health check server running on port ${port}`);
  });

  return server;
}
