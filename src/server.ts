import { app } from "./app";
import { ensureDefaultTemplates } from "./lib/site";
import { startRealtimeServer } from "./lib/realtime";

const PORT = Number(process.env.PORT || 3000);
const WS_PORT = Number(process.env.WS_PORT || 3003);

async function start() {
  await ensureDefaultTemplates();

  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });

  // Bun-native WebSocket server for real-time chat push.
  startRealtimeServer(WS_PORT);
  console.log(`Realtime server running on ws://localhost:${WS_PORT}`);
}

start()
  .then(() => {})
  .catch((err) => {
    console.error("Failed to start server:", err);
    process.exit(1);
  });