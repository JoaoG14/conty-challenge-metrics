import type { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import type { Context } from "hono";
import { createConnection, getMetrics, MetricsError, syncMetrics } from "./metrics.ts";
import { networks, ProviderError } from "./provider.ts";
import type { Network, Provider } from "./provider.ts";
import { SyncUnavailable } from "./retry.ts";
import type { RetryPolicy } from "./retry.ts";

async function readBody(c: Context): Promise<Record<string, unknown>> {
  const body: unknown = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new MetricsError("corpo deve ser um objeto JSON", 400);
  }
  return body as Record<string, unknown>;
}

function requiredText(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== "string" || !value.trim()) throw new MetricsError(`${field} é obrigatório`, 400);
  return value.trim();
}

export function createApp(db: DatabaseSync, provider: Provider, policy: Partial<RetryPolicy> = {}) {
  const app = new Hono();
  app.onError((error, c) => {
    if (error instanceof MetricsError) return c.json({ error: error.message }, error.status);
    if (error instanceof SyncUnavailable) return c.json({ error: error.message }, 503);
    if (error instanceof ProviderError) return c.json({ error: "falha no provedor", provider_status: error.status }, 502);
    console.error(error);
    return c.json({ error: "erro interno" }, 500);
  });

  app.get("/health", (c) => c.json({ ok: true }));

  app.post("/connections", async (c) => {
    const body = await readBody(c);
    const network = requiredText(body, "network");
    if (!networks.includes(network as Network)) throw new MetricsError("rede inválida", 400);
    const connection = createConnection(db, {
      network: network as Network,
      account_id: requiredText(body, "account_id"),
      token: requiredText(body, "token"),
    });
    return c.json(connection, 201);
  });

  app.get("/connections/:id/metrics", (c) => c.json(getMetrics(db, c.req.param("id"))));

  app.post("/connections/:id/sync", async (c) => {
    const body = await readBody(c);
    return c.json(await syncMetrics(db, provider, c.req.param("id"), {
      from: requiredText(body, "from"),
      to: requiredText(body, "to"),
    }, policy));
  });

  return app;
}
