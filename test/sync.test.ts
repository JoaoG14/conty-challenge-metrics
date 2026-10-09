import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase } from "../src/db.ts";
import { createConnection, getMetrics, syncMetrics } from "../src/metrics.ts";
import { FakeProvider } from "../src/provider.ts";
import type { Post, Provider } from "../src/provider.ts";

const window = { from: "2026-10-01T00:00:00.000Z", to: "2026-10-10T00:00:00.000Z" };
const snapshot: Post = {
  post_id: "post_01", published_at: "2026-10-02T12:00:00.000Z",
  captured_at: "2026-10-08T12:00:00.000Z", views: 100, likes: 10, comments: 1,
};

describe("sincronização de métricas", () => {
  let db: DatabaseSync;
  let id: string;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-10-09T12:00:00.000Z");
    db = openDatabase();
    id = createConnection(db, { network: "instagram", account_id: "account_01", token: "demo" }).id;
  });

  afterEach(() => {
    db.close();
    vi.useRealTimers();
  });

  function provider(posts: Post[]): Provider {
    return { fetchPosts: async () => posts };
  }

  it("não soma respostas duplicadas nem janelas sobrepostas", async () => {
    const fake = new FakeProvider();
    const first = await syncMetrics(db, fake, id, window);
    expect(first.updated_posts).toBe(2);
    expect(first.totals).toEqual({ posts: 2, views: 1500, likes: 150, comments: 15 });

    const repeated = await syncMetrics(db, fake, id, window);
    expect(repeated.updated_posts).toBe(0);
    expect(repeated.posts).toEqual(first.posts);

    const overlap = await syncMetrics(db, fake, id, { from: "2026-10-05T00:00:00.000Z", to: window.to });
    expect(overlap.updated_posts).toBe(0);
    expect(overlap.totals).toEqual(first.totals);
  });

  it("substitui os valores do snapshot mais recente, mesmo quando diminuem", async () => {
    await syncMetrics(db, provider([snapshot]), id, window);
    vi.setSystemTime("2026-10-09T13:00:00.000Z");
    const latest = { ...snapshot, captured_at: "2026-10-09T12:00:00.000Z", views: 80, likes: 8, comments: 0 };
    const result = await syncMetrics(db, provider([latest]), id, window);
    expect(result.totals).toEqual({ posts: 1, views: 80, likes: 8, comments: 0 });
    expect(result.posts[0]).toEqual({ ...latest, fetched_at: "2026-10-09T13:00:00.000Z" });
  });

  it("ignora um snapshot antigo ou repetido e registra a última consulta bem-sucedida", async () => {
    const first = await syncMetrics(db, provider([snapshot]), id, window);
    vi.setSystemTime("2026-10-09T13:00:00.000Z");
    const result = await syncMetrics(db, provider([
      { ...snapshot, captured_at: "2026-10-07T12:00:00.000Z", views: 999 },
      { ...snapshot, views: 200 },
    ]), id, window);
    expect(result.updated_posts).toBe(0);
    expect(result.posts).toEqual(first.posts);
    expect(result.connection?.last_sync_at).toBe("2026-10-09T13:00:00.000Z");
  });

  it("mantém o snapshot mais recente quando dois syncs terminam fora de ordem", async () => {
    let finishSlow!: (posts: Post[]) => void;
    const slow: Provider = { fetchPosts: () => new Promise((resolve) => { finishSlow = resolve; }) };
    const olderSync = syncMetrics(db, slow, id, window);
    const newest = { ...snapshot, captured_at: "2026-10-09T11:00:00.000Z", views: 200 };
    await syncMetrics(db, provider([newest]), id, window);
    finishSlow([snapshot, snapshot]);
    await olderSync;
    expect(getMetrics(db, id).totals).toMatchObject({ posts: 1, views: 200 });
  });

  it("não duplica posts em dois syncs simultâneos da mesma janela", async () => {
    await Promise.all([
      syncMetrics(db, provider([snapshot, snapshot]), id, window),
      syncMetrics(db, provider([snapshot]), id, window),
    ]);
    expect(getMetrics(db, id).totals).toEqual({ posts: 1, views: 100, likes: 10, comments: 1 });
  });

  it("isola IDs de posts entre contas e redes", async () => {
    const second = createConnection(db, { network: "instagram", account_id: "account_02", token: "demo" }).id;
    const third = createConnection(db, { network: "tiktok", account_id: "account_01", token: "demo" }).id;
    for (const connectionId of [id, second, third]) {
      await syncMetrics(db, provider([snapshot]), connectionId, window);
      expect(getMetrics(db, connectionId).totals?.posts).toBe(1);
    }
    expect(() => createConnection(db, { network: "instagram", account_id: "account_01", token: "other" }))
      .toThrow("conta já conectada");
  });

  it("usa início inclusivo e fim exclusivo na janela", async () => {
    const result = await syncMetrics(db, new FakeProvider(), id, {
      from: "2026-10-01T12:00:00.000Z", to: "2026-10-05T12:00:00.000Z",
    });
    expect(result.posts.map((post) => post.post_id)).toEqual(["post_01"]);
  });

  it("uma resposta vazia não apaga métricas existentes", async () => {
    await syncMetrics(db, provider([snapshot]), id, window);
    const result = await syncMetrics(db, provider([]), id, window);
    expect(result.updated_posts).toBe(0);
    expect(result.totals?.posts).toBe(1);
  });

  it("recusa uma resposta inválida inteira sem gravar parte dela", async () => {
    await expect(syncMetrics(db, provider([snapshot, { ...snapshot, post_id: "bad", views: -1 }]), id, window))
      .rejects.toThrow("resposta inválida");
    expect(getMetrics(db, id).totals?.posts).toBe(0);
    expect(getMetrics(db, id).connection?.last_sync_at).toBeNull();
  });

  it("desfaz toda a gravação se o banco falhar no meio do lote", async () => {
    db.exec(`CREATE TRIGGER reject_post BEFORE INSERT ON posts
      WHEN NEW.post_id = 'bad' BEGIN SELECT RAISE(ABORT, 'falha simulada'); END;`);
    await expect(syncMetrics(db, provider([snapshot, { ...snapshot, post_id: "bad" }]), id, window))
      .rejects.toThrow("falha simulada");
    expect(getMetrics(db, id).totals?.posts).toBe(0);
    expect(getMetrics(db, id).connection?.last_sync_at).toBeNull();
  });

  it("preserva idempotência depois de reabrir o banco", async () => {
    const directory = mkdtempSync(join(tmpdir(), "conty-metrics-"));
    const path = join(directory, "metrics.sqlite");
    let saved = openDatabase(path);
    try {
      const connection = createConnection(saved, { network: "x", account_id: "account", token: "demo" });
      await syncMetrics(saved, provider([snapshot]), connection.id, window);
      saved.close();
      saved = openDatabase(path);
      const result = await syncMetrics(saved, provider([snapshot]), connection.id, window);
      expect(result.updated_posts).toBe(0);
      expect(result.totals?.views).toBe(100);
    } finally {
      saved.close();
      rmSync(directory, { recursive: true });
    }
  });
});
