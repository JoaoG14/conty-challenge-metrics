import { ProviderError } from "./provider.ts";

export const defaultRetryPolicy = {
  maxAttempts: 3,
  timeoutMs: 1000,
  retryDelayMs: 250,
  maxWaitMs: 5000,
};
export type RetryPolicy = typeof defaultRetryPolicy;

export class SyncUnavailable extends Error {}

function retryDelay(error: unknown, policy: RetryPolicy): number | null {
  if (error instanceof SyncUnavailable) return policy.retryDelayMs;
  if (!(error instanceof ProviderError)) return null;
  if (error.status >= 500 && error.status <= 599) return policy.retryDelayMs;
  if (error.status !== 429) return null;
  if (!error.retryAfter) return policy.retryDelayMs;

  const value = error.retryAfter.trim();
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  if (!/^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value)) {
    return policy.retryDelayMs;
  }
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : policy.retryDelayMs;
}

async function withTimeout<T>(action: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new SyncUnavailable("timeout do provedor"));
      controller.abort();
    }, timeoutMs);
  });
  try {
    return await Promise.race([action(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export async function withRetry<T>(
  action: (signal: AbortSignal) => Promise<T>,
  overrides: Partial<RetryPolicy> = {},
): Promise<T> {
  const policy = { ...defaultRetryPolicy, ...overrides };
  for (const [key, value] of Object.entries(policy)) {
    if (!Number.isSafeInteger(value) || value < (key === "maxAttempts" || key === "timeoutMs" ? 1 : 0)) {
      throw new Error(`configuração inválida: ${key}`);
    }
  }

  let waitedMs = 0;
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
    try {
      return await withTimeout(action, policy.timeoutMs);
    } catch (error) {
      const delay = retryDelay(error, policy);
      if (delay === null) throw error;
      if (attempt === policy.maxAttempts) throw new SyncUnavailable("limite de tentativas atingido");
      // Não encurta Retry-After: se não cabe no orçamento, encerra o sync.
      if (delay > policy.maxWaitMs - waitedMs) throw new SyncUnavailable("espera do provedor excede o limite");
      await new Promise((resolve) => setTimeout(resolve, delay));
      waitedMs += delay;
    }
  }
  throw new SyncUnavailable("limite de tentativas atingido");
}
