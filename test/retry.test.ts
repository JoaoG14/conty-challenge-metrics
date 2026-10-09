import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderError } from "../src/provider.ts";
import { withRetry } from "../src/retry.ts";

describe("retry do provedor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-10-09T12:00:00.000Z");
  });
  afterEach(() => vi.useRealTimers());

  it.each(["2", "Fri, 09 Oct 2026 12:00:02 GMT"])("espera exatamente Retry-After: %s", async (retryAfter) => {
    const request = vi.fn().mockRejectedValueOnce(new ProviderError(429, retryAfter)).mockResolvedValue("ok");
    const pending = withRetry(request);
    await vi.advanceTimersByTimeAsync(1999);
    expect(request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toBe("ok");
    expect(request).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("encerra sem tentar antes do prazo quando Retry-After ultrapassa o teto", async () => {
    const request = vi.fn().mockRejectedValue(new ProviderError(429, "6"));
    await expect(withRetry(request, { maxWaitMs: 5000 })).rejects.toThrow("espera do provedor excede o limite");
    expect(request).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aplica o teto à soma das esperas", async () => {
    const request = vi.fn().mockRejectedValue(new ProviderError(429, "3"));
    const pending = expect(withRetry(request, { maxWaitMs: 5000 })).rejects.toThrow("espera do provedor excede o limite");
    await vi.advanceTimersByTimeAsync(3000);
    await pending;
    expect(request).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aceita uma espera igual ao teto", async () => {
    const request = vi.fn().mockRejectedValueOnce(new ProviderError(429, "5")).mockResolvedValue("ok");
    const pending = withRetry(request);
    await vi.advanceTimersByTimeAsync(4999);
    expect(request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toBe("ok");
  });

  it("limita as tentativas mesmo com Retry-After zero", async () => {
    const request = vi.fn().mockRejectedValue(new ProviderError(429, "0"));
    const pending = expect(withRetry(request)).rejects.toThrow("limite de tentativas");
    await vi.runAllTimersAsync();
    await pending;
    expect(request).toHaveBeenCalledTimes(3);
  });

  it.each([undefined, "inválido", "-1", "1.5"])("usa a espera padrão se Retry-After está ausente ou inválido: %s", async (header) => {
    const request = vi.fn().mockRejectedValueOnce(new ProviderError(429, header)).mockResolvedValue("ok");
    const pending = withRetry(request);
    await vi.advanceTimersByTimeAsync(249);
    expect(request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toBe("ok");
  });

  it("repete falhas 503 com intervalo e limite de três tentativas", async () => {
    const request = vi.fn().mockRejectedValue(new ProviderError(503));
    const pending = expect(withRetry(request)).rejects.toThrow("limite de tentativas");
    await vi.advanceTimersByTimeAsync(249);
    expect(request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(request).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(250);
    await pending;
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("aborta o timeout e tenta de novo após a espera", async () => {
    let signal: AbortSignal | undefined;
    const request = vi.fn().mockImplementationOnce((value: AbortSignal) => {
      signal = value;
      return new Promise(() => {});
    }).mockResolvedValue("ok");
    const pending = withRetry(request);
    await vi.advanceTimersByTimeAsync(999);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signal?.aborted).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(250);
    await expect(pending).resolves.toBe("ok");
    expect(request).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("limita timeouts mesmo se o provedor ignorar o cancelamento", async () => {
    const request = vi.fn(() => new Promise(() => {}));
    const pending = expect(withRetry(request)).rejects.toThrow("limite de tentativas");
    await vi.advanceTimersByTimeAsync(3500);
    await pending;
    expect(request).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([400, 401, 403, 404])("não repete uma falha permanente %s", async (status) => {
    const error = new ProviderError(status);
    const request = vi.fn().mockRejectedValue(error);
    await expect(withRetry(request)).rejects.toBe(error);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("não transforma um erro de programação em retry", async () => {
    const error = new TypeError("bug");
    const request = vi.fn().mockRejectedValue(error);
    await expect(withRetry(request)).rejects.toBe(error);
    expect(request).toHaveBeenCalledTimes(1);
  });
});
