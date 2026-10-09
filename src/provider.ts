import { setTimeout as sleep } from "node:timers/promises";

export const networks = ["instagram", "tiktok", "youtube", "x"] as const;
export type Network = typeof networks[number];
export type Connection = { id: string; network: Network; account_id: string; token: string };
export type SyncWindow = { from: string; to: string };
export type Post = {
  post_id: string;
  published_at: string;
  captured_at: string;
  views: number;
  likes: number;
  comments: number;
};

export interface Provider {
  fetchPosts(connection: Connection, window: SyncWindow, signal: AbortSignal): Promise<Post[]>;
}

export class ProviderError extends Error {
  constructor(public status: number, public retryAfter?: string) {
    super(`provedor respondeu ${status}`);
  }
}

// Todos os adaptadores entregam o mesmo formato de métricas para o sync.
export class FakeProvider implements Provider {
  private calls = new Map<string, number>();

  async fetchPosts(connection: Connection, window: SyncWindow, signal: AbortSignal): Promise<Post[]> {
    const attempt = (this.calls.get(connection.id) ?? 0) + 1;
    this.calls.set(connection.id, attempt);

    if (connection.token === "demo-rate-limit" && attempt === 1) throw new ProviderError(429, "2");
    if (connection.token === "demo-unavailable") throw new ProviderError(503);
    if (connection.token === "demo-invalid-token") throw new ProviderError(401);
    if (connection.token === "demo-timeout" && attempt === 1) {
      await sleep(60_000, undefined, { signal });
    }

    const posts: Post[] = [
      { post_id: "post_01", published_at: "2026-10-01T12:00:00.000Z", captured_at: "2026-10-08T12:00:00.000Z", views: 1000, likes: 100, comments: 10 },
      { post_id: "post_02", published_at: "2026-10-05T12:00:00.000Z", captured_at: "2026-10-08T12:00:00.000Z", views: 500, likes: 50, comments: 5 },
    ];
    // O mesmo post vem duas vezes de propósito.
    return [...posts, posts[0]].filter((post) => post.published_at >= window.from && post.published_at < window.to);
  }
}
