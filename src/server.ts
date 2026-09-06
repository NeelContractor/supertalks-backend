import { app } from "./app";
import { ensureDefaultTemplates } from "./lib/site";

const PORT = Number(process.env.PORT || 3000);

async function start() {
  await ensureDefaultTemplates();

  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

start()
  .then(() => {})
  .catch((err) => {
    console.error("Failed to start server:", err);
    process.exit(1);
  });