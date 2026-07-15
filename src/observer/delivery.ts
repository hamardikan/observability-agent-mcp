import { createHmac } from "node:crypto";

export interface ObserverDeliveryResult {
  readonly delivered: true;
  readonly attempts: number;
}

export type ObserverDeliveryRoute = "success" | "analysis";

export interface ObserverDeliverySink {
  deliver(body: string, eventId: string, route?: ObserverDeliveryRoute): Promise<ObserverDeliveryResult>;
}

export class ObserverDeliveryError extends Error {
  constructor(readonly code: "unavailable" | "rejected") {
    super(`observer delivery ${code}`);
    this.name = "ObserverDeliveryError";
  }
}

export class HttpDeliverySink implements ObserverDeliverySink {
  readonly #routes: Readonly<Record<ObserverDeliveryRoute, string>>;
  readonly #key: Uint8Array;
  readonly #fetch: typeof globalThis.fetch;
  readonly #clock: () => Date;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #maxAttempts: number;
  readonly #backoffMs: number;
  readonly #timeoutMs: number;

  constructor(options: {
    routes: { success: string; analysis?: string };
    trustedInternalHosts?: readonly string[];
    key: Uint8Array;
    fetch: typeof globalThis.fetch;
    clock?: () => Date;
    sleep?: (milliseconds: number) => Promise<void>;
    maxAttempts: number;
    backoffMs: number;
    timeoutMs: number;
  }) {
    const successUrl = new URL(options.routes.success);
    const analysisUrl = new URL(options.routes.analysis ?? options.routes.success);
    const trustedHosts = options.trustedInternalHosts ?? [];
    if (!isTrustedDeliveryUrl(successUrl.toString(), trustedHosts) || !isTrustedDeliveryUrl(analysisUrl.toString(), trustedHosts)) throw new Error("Delivery URL is not trusted");
    if (options.key.byteLength < 32) throw new Error("Delivery HMAC key must be at least 32 bytes");
    this.#routes = { success: successUrl.toString(), analysis: analysisUrl.toString() };
    this.#key = Buffer.from(options.key);
    this.#fetch = options.fetch;
    this.#clock = options.clock ?? (() => new Date());
    this.#sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.#maxAttempts = Math.max(1, Math.min(8, Math.floor(options.maxAttempts)));
    this.#backoffMs = Math.max(1, Math.min(60_000, Math.floor(options.backoffMs)));
    this.#timeoutMs = Math.max(100, Math.min(30_000, Math.floor(options.timeoutMs)));
  }

  async deliver(body: string, eventId: string, route: ObserverDeliveryRoute = "success"): Promise<ObserverDeliveryResult> {
    const timestamp = String(Math.floor(this.#clock().getTime() / 1_000));
    const signature = signEventPayload(this.#key, timestamp, body);
    const endpoint = this.#routes[route];
    for (let attempt = 1; attempt <= this.#maxAttempts; attempt += 1) {
      let retry = false;
      try {
        const response = await this.#fetch(endpoint, {
          method: "POST",
          redirect: "error",
          body,
          signal: AbortSignal.timeout(this.#timeoutMs),
          headers: {
            "X-Webhook-Signature-V2": signature,
            "X-Webhook-Timestamp": timestamp,
            "X-Request-ID": eventId,
          },
        });
        if (response.ok) return { delivered: true, attempts: attempt };
        retry = response.status === 408 || response.status === 429 || response.status >= 500;
        if (!retry) throw new ObserverDeliveryError("rejected");
      } catch (error) {
        if (error instanceof ObserverDeliveryError) throw error;
        retry = true;
      }
      if (!retry || attempt === this.#maxAttempts) break;
      await this.#sleep(this.#backoffMs * 2 ** (attempt - 1));
    }
    throw new ObserverDeliveryError("unavailable");
  }
}

// Retain the old name for callers that configure Hermes routes explicitly.
export class HermesDelivery extends HttpDeliverySink {
  constructor(options: {
    url: string;
    analysisUrl?: string;
    trustedInternalHosts?: readonly string[];
    key: Uint8Array;
    fetch: typeof globalThis.fetch;
    clock?: () => Date;
    sleep?: (milliseconds: number) => Promise<void>;
    maxAttempts: number;
    backoffMs: number;
    timeoutMs: number;
  }) {
    super({
      routes: { success: options.url, ...(options.analysisUrl === undefined ? {} : { analysis: options.analysisUrl }) },
      ...(options.trustedInternalHosts === undefined ? {} : { trustedInternalHosts: options.trustedInternalHosts }),
      key: options.key,
      fetch: options.fetch,
      ...(options.clock === undefined ? {} : { clock: options.clock }),
      ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
      maxAttempts: options.maxAttempts,
      backoffMs: options.backoffMs,
      timeoutMs: options.timeoutMs,
    });
  }
}

export function signEventPayload(key: Uint8Array, timestamp: string, body: string): string {
  return createHmac("sha256", key).update(`${timestamp}.${body}`, "utf8").digest("hex");
}

export function signHermesPayload(key: Uint8Array, timestamp: string, body: string): string {
  return signEventPayload(key, timestamp, body);
}

export function isTrustedDeliveryUrl(value: string, trustedInternalHosts: readonly string[] = []): boolean {
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  if (url.username !== "" || url.password !== "") return false;
  if (url.protocol === "https:") return true;
  if (url.protocol !== "http:") return false;
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  return isTailscaleCgnatLiteral(hostname) || trustedInternalHosts.some((host) => host.toLowerCase().replace(/\.$/, "") === hostname);
}

export function isTrustedHermesUrl(value: string, trustedInternalHosts: readonly string[] = []): boolean {
  return isTrustedDeliveryUrl(value, trustedInternalHosts);
}

function isTailscaleCgnatLiteral(hostname: string): boolean {
  const parts = hostname.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d+$/.test(part))) return false;
  const octets = parts.map(Number);
  return octets[0] === 100 && octets[1] !== undefined && octets[1] >= 64 && octets[1] <= 127 && octets[2] !== undefined && octets[2] >= 0 && octets[2] <= 255 && octets[3] !== undefined && octets[3] >= 0 && octets[3] <= 255;
}
