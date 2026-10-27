import { randomUUID } from "node:crypto";
import type {
  Agent,
  ApiErrorBody,
  AuthorizationRequest,
  Decision,
  Mandate,
  MandateInput,
  Verdict,
} from "./types.js";

export class SaifuroApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId?: string,
  ) {
    super(`${status} ${code}: ${message}`);
  }
}

export interface ClientOptions {
  /** e.g. https://api.saifuro.com/v1 or the local mock. */
  baseUrl: string;
  /** `ak_*` for an agent runtime, `sk_*` for a backend. */
  apiKey: string;
  fetch?: typeof fetch;
}

/**
 * Thin client over the Saifuro REST API. A denial is a 201 with a verdict,
 * not an exception; only transport and request errors throw.
 */
export class SaifuroClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: ClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = opts.fetch ?? fetch;
  }

  authorize(req: AuthorizationRequest, idempotencyKey: string = randomUUID()): Promise<Decision> {
    return this.call("POST", "/authorizations", req, idempotencyKey);
  }

  getDecision(id: string): Promise<Decision> {
    return this.call("GET", `/decisions/${encodeURIComponent(id)}`);
  }

  async listDecisions(filter: { agent?: string; verdict?: Verdict } = {}): Promise<Decision[]> {
    // A cursor is bound to its filters, so the filter set stays fixed for the walk.
    const qs = new URLSearchParams({ ...(filter as Record<string, string>), limit: "100" }).toString();
    const out: Decision[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await this.call<{ data: Decision[]; has_more: boolean; next_cursor?: string }>(
        "GET",
        `/decisions?${qs}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      out.push(...page.data);
      if (!page.has_more || !page.next_cursor) return out;
      cursor = page.next_cursor;
    }
  }

  createAgent(name: string): Promise<Agent> {
    return this.call("POST", "/agents", { name }, randomUUID());
  }

  disableAgent(id: string): Promise<Agent> {
    return this.call("POST", `/agents/${encodeURIComponent(id)}/disable`, {}, randomUUID());
  }

  createMandate(input: MandateInput): Promise<Mandate> {
    return this.call("POST", "/mandates", input, randomUUID());
  }

  revokeMandate(id: string): Promise<Mandate> {
    return this.call("POST", `/mandates/${encodeURIComponent(id)}/revoke`, {}, randomUUID());
  }

  approveReview(id: string): Promise<Decision> {
    return this.call("POST", `/reviews/${encodeURIComponent(id)}/approve`, {}, randomUUID());
  }

  denyReview(id: string): Promise<unknown> {
    return this.call("POST", `/reviews/${encodeURIComponent(id)}/deny`, {}, randomUUID());
  }

  private async call<T>(method: string, path: string, body?: unknown, idempotencyKey?: string): Promise<T> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.opts.apiKey}` };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;

    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : undefined;
    if (!res.ok) {
      const err = (json as ApiErrorBody | undefined)?.error;
      throw new SaifuroApiError(
        res.status,
        err?.code ?? "unknown",
        err?.message ?? text,
        err?.request_id ?? res.headers.get("x-request-id") ?? undefined,
      );
    }
    return json as T;
  }
}
