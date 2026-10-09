import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.ts";
import { openDatabase } from "../src/db.ts";
import { FakeProvider, networks, ProviderError } from "../src/provider.ts";
import type { Post } from "../src/provider.ts";

const window = { from: "2026-10-01T00:00:00.000Z", to: "2026-10-10T00:00:00.000Z" };

describe("API de métricas", () => {
  let db: DatabaseSync;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-10-09T12:00:00.000Z");
    db = openDatabase();
    app = createApp(db, new FakeProvider());
  });

  afterEach(() => {
    db.close();
    vi.useRealTimers();
  });

  function post(path: string, body: unknown) {
    return app.request(path, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
  }

  async function connect(token = "demo", network = "instagram"): Promise<string> {
    const response = await post("/connections", { network, account_id: "account_01", token });
    expect(response.status).toBe(201);
    const body = await response.json() as { id: string };
    expect(body).not.toHaveProperty("token");
    return body.id;
  }

  it.each(networks)("conecta e sincroniza a rede %s", async (network) => {
    const id = await connect("demo", network);
    const response = await post(`/connections/${id}/sync`, window);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      updated_posts: 2,
      connection: { id, network, last_sync_at: "2026-10-09T12:00:00.000Z" },
      totals: { posts: 2, views: 1500, likes: 150, comments: 15 },
    });
    const read = await app.request(`/connections/${id}/metrics`);
    expect(read.status).toBe(200);
    const body = await read.json();
    expect(body).toHaveProperty("posts.0.fetched_at", "2026-10-09T12:00:00.000Z");
    expect(body).not.toHaveProperty("connection.token");
  });

  it("passa a conexão autorizada ao provedor sem expor o token na resposta", async () => {
    const fetchPosts = vi.fn().mockResolvedValue([]);
    app = createApp(db, { fetchPosts });
    const id = await connect("token-ficticio");
    await post(`/connections/${id}/sync`, window);
    expect(fetchPosts).toHaveBeenCalledWith(
      expect.objectContaining({ id, token: "token-ficticio", network: "instagram", account_id: "account_01" }),
      window, expect.any(AbortSignal),
    );
  });

  it("espera Retry-After no fluxo completo e só grava depois do sucesso", async () => {
    const id = await connect("demo-rate-limit");
    const pending = post(`/connections/${id}/sync`, window);
    await vi.advanceTimersByTimeAsync(1999);
    const before = await (await app.request(`/connections/${id}/metrics`)).json();
    expect(before).toHaveProperty("totals.posts", 0);
    expect(before).toHaveProperty("connection.last_sync_at", null);
    await vi.advanceTimersByTimeAsync(1);
    const response = await pending;
    expect(response.status).toBe(200);
    expect(await response.json()).toHaveProperty("posts.0.fetched_at", "2026-10-09T12:00:02.000Z");
  });

  it("retorna 503 ao esgotar tentativas e preserva as métricas anteriores", async () => {
    const id = await connect();
    await post(`/connections/${id}/sync`, window);
    const before = await (await app.request(`/connections/${id}/metrics`)).json();
    const fetchPosts = vi.fn().mockRejectedValue(new ProviderError(503));
    app = createApp(db, { fetchPosts });
    const pending = post(`/connections/${id}/sync`, window);
    await vi.runAllTimersAsync();
    expect((await pending).status).toBe(503);
    expect(fetchPosts).toHaveBeenCalledTimes(3);
    expect(await (await app.request(`/connections/${id}/metrics`)).json()).toEqual(before);
  });

  it("uma resposta que chega após o timeout não grava métricas atrasadas", async () => {
    let finish!: (posts: Post[]) => void;
    const fetchPosts = vi.fn().mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }))
      .mockResolvedValue([]);
    app = createApp(db, { fetchPosts });
    const id = await connect();
    const pending = post(`/connections/${id}/sync`, window);
    await vi.advanceTimersByTimeAsync(1250);
    expect((await pending).status).toBe(200);
    finish([{
      post_id: "late", published_at: window.from, captured_at: window.from,
      views: 999, likes: 99, comments: 9,
    }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(await (await app.request(`/connections/${id}/metrics`)).json()).toHaveProperty("totals.posts", 0);
  });

  it("retorna 502 para token recusado, sem retry", async () => {
    const id = await connect("demo-invalid-token");
    const response = await post(`/connections/${id}/sync`, window);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "falha no provedor", provider_status: 401 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("recusa conexão repetida sem alterar o token", async () => {
    await connect();
    const response = await post("/connections", { network: "instagram", account_id: "account_01", token: "other" });
    expect(response.status).toBe(409);
    expect(db.prepare("SELECT token FROM connections").get()?.token).toBe("demo");
  });

  it.each([
    null, [], {}, { network: "unknown", account_id: "a", token: "b" },
    { network: "instagram", account_id: " ", token: "b" },
    { network: "instagram", account_id: "a", token: " " },
  ])("recusa conexão inválida: %j", async (body) => {
    expect((await post("/connections", body)).status).toBe(400);
  });

  it("recusa JSON malformado", async () => {
    const response = await app.request("/connections", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{",
    });
    expect(response.status).toBe(400);
  });

  it.each([
    {}, { ...window, from: window.to }, { ...window, from: "2026-02-30T00:00:00.000Z" },
    { ...window, from: "ontem" }, { ...window, to: "2026-01-01T00:00:00.000Z" },
  ])("recusa janela inválida antes de chamar o provedor: %j", async (body) => {
    const fetchPosts = vi.fn();
    app = createApp(db, { fetchPosts });
    const id = await connect();
    expect((await post(`/connections/${id}/sync`, body)).status).toBe(400);
    expect(fetchPosts).not.toHaveBeenCalled();
  });

  it("retorna 404 para uma conexão inexistente", async () => {
    expect((await post("/connections/missing/sync", window)).status).toBe(404);
    expect((await app.request("/connections/missing/metrics")).status).toBe(404);
  });
});
