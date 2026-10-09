import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { openDatabase } from "./db.ts";
import { FakeProvider } from "./provider.ts";

const db = openDatabase(process.env.DATABASE_PATH ?? "data/metrics.sqlite");
const app = createApp(db, new FakeProvider());
const port = Number(process.env.PORT ?? 3004);

const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port }, (info) => {
  console.log(`métricas em http://127.0.0.1:${info.port}`);
});

function shutdown(): void {
  server.close(() => db.close());
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
