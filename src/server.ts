import { createServer } from "node:http";
import { app } from "./app";
import { ensureDefaultTemplates } from "./lib/site";
import { attachRealtime } from "./lib/realtime";

const PORT = Number(process.env.PORT || 3000);

async function start() {
  await ensureDefaultTemplates();

  // Single HTTP server serves both the REST API and the realtime channel.
  const server = createServer(app);
  attachRealtime(server);

  server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`Realtime server running on ws://localhost:${PORT}/ws`);
  });
}

start()
  .then(() => {})
  .catch((err) => {
    console.error("Failed to start server:", err);
    process.exit(1);
  });