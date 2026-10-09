import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { transaction } from "./db.ts";
import type { Connection, Network, Post, Provider, SyncWindow } from "./provider.ts";
import { withRetry } from "./retry.ts";
import type { RetryPolicy } from "./retry.ts";

export class MetricsError extends Error {
  constructor(message: string, public status: 400 | 404 | 409 | 502) {
    super(message);
  }
}

export function timestamp(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(value)) {
    throw new MetricsError("data deve estar em UTC, no formato YYYY-MM-DDTHH:mm:ss.sssZ", 400);
  }
  const date = new Date(value);
  const normalized = value.includes(".") ? value : value.replace("Z", ".000Z");
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== normalized) {
    throw new MetricsError("data inválida", 400);
  }
  return normalized;
}

export function createConnection(db: DatabaseSync, input: { network: Network; account_id: string; token: string }) {
  return transaction(db, () => {
    const existing = db.prepare("SELECT id FROM connections WHERE network = ? AND account_id = ?")
      .get(input.network, input.account_id);
    if (existing) throw new MetricsError("conta já conectada nesta rede", 409);
    const id = randomUUID();
    db.prepare("INSERT INTO connections (id, network, account_id, token) VALUES (?, ?, ?, ?)")
      .run(id, input.network, input.account_id, input.token);
    return { id, network: input.network, account_id: input.account_id };
  });
}

function getConnection(db: DatabaseSync, id: string): Connection {
  const connection = db.prepare("SELECT * FROM connections WHERE id = ?").get(id) as Connection | undefined;
  if (!connection) throw new MetricsError("conexão não encontrada", 404);
  return connection;
}

export function getMetrics(db: DatabaseSync, id: string) {
  getConnection(db, id);
  const connection = db.prepare("SELECT id, network, account_id, last_sync_at FROM connections WHERE id = ?").get(id);
  const posts = db.prepare(`
    SELECT post_id, published_at, captured_at, fetched_at, views, likes, comments
    FROM posts WHERE connection_id = ? ORDER BY post_id
  `).all(id);
  const totals = db.prepare(`
    SELECT COUNT(*) AS posts, COALESCE(SUM(views), 0) AS views,
      COALESCE(SUM(likes), 0) AS likes, COALESCE(SUM(comments), 0) AS comments
    FROM posts WHERE connection_id = ?
  `).get(id);
  return { connection, totals, posts };
}

function validatePosts(posts: Post[], window: SyncWindow): Post[] {
  if (!Array.isArray(posts)) throw new MetricsError("resposta inválida do provedor", 502);
  return posts.map((post) => {
    try {
      if (!post || typeof post.post_id !== "string" || !post.post_id.trim()) throw new Error();
      const published_at = timestamp(post.published_at);
      const captured_at = timestamp(post.captured_at);
      for (const value of [post.views, post.likes, post.comments]) {
        if (!Number.isSafeInteger(value) || value < 0) throw new Error();
      }
      if (published_at < window.from || published_at >= window.to) throw new Error();
      return { ...post, published_at, captured_at };
    } catch {
      throw new MetricsError("resposta inválida do provedor", 502);
    }
  });
}

export async function syncMetrics(
  db: DatabaseSync,
  provider: Provider,
  id: string,
  window: SyncWindow,
  policy: Partial<RetryPolicy> = {},
) {
  const connection = getConnection(db, id);
  const from = timestamp(window.from);
  const to = timestamp(window.to);
  if (from >= to) throw new MetricsError("from deve ser anterior a to", 400);

  const posts = validatePosts(await withRetry(
    (signal) => provider.fetchPosts(connection, { from, to }, signal), policy,
  ), { from, to });
  const fetchedAt = new Date().toISOString();

  return transaction(db, () => {
    const upsert = db.prepare(`
      INSERT INTO posts (connection_id, post_id, published_at, captured_at, fetched_at, views, likes, comments)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (connection_id, post_id) DO UPDATE SET
        published_at = excluded.published_at, captured_at = excluded.captured_at,
        fetched_at = excluded.fetched_at, views = excluded.views,
        likes = excluded.likes, comments = excluded.comments
      WHERE excluded.captured_at > posts.captured_at
    `);
    const changed = new Set<string>();
    for (const post of posts) {
      const result = upsert.run(id, post.post_id, post.published_at, post.captured_at, fetchedAt,
        post.views, post.likes, post.comments);
      if (result.changes > 0) changed.add(post.post_id);
    }
    db.prepare("UPDATE connections SET last_sync_at = ? WHERE id = ?").run(fetchedAt, id);
    return { updated_posts: changed.size, ...getMetrics(db, id) };
  });
}
