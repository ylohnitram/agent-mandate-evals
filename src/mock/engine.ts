import { randomBytes } from "node:crypto";
import type { AuthorizationRequest, Decision, Mandate, MandateInput, Verdict } from "../saifuro/types.js";

// In-memory model of the Saifuro policy engine, written from the public docs
// (concepts/decision-codes, api/mandates, api/authorizations). It exists so
// the integration and the evals run without onboarding keys; anything the
// docs do not pin down is marked as a mock assumption.

const VELOCITY_WINDOW_MS = 60_000;
const VELOCITY_MAX = 10;
const MONTH_MS = 30 * 24 * 3600_000;
const ALLOW_TTL_MS = 5 * 60_000;
const REVIEW_TTL_MS = 24 * 3600_000;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface AgentRecord {
  agent: string;
  name: string;
  status: "active" | "disabled";
  created_at: string;
  key: string;
}

interface ReviewRecord {
  review: string;
  decision: string;
  mandate: string;
  status: "pending" | "approved" | "denied";
  waits_for: string;
  expires_at: number;
}

export type UnsignedDecision = Omit<Decision, "verdict_token">;
export type Signer = (d: UnsignedDecision) => Promise<string>;

const id = (prefix: string) => `${prefix}_${randomBytes(4).toString("hex")}`;
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const money = (n: number) => n.toFixed(2);

export class PolicyEngine {
  readonly orgKey = `sk_sandbox_${randomBytes(16).toString("hex")}`;
  readonly policyVersion = "pol_mock.1";
  private readonly agents = new Map<string, AgentRecord>();
  private readonly mandates: Mandate[] = [];
  readonly decisions: Decision[] = [];
  private readonly reviews = new Map<string, ReviewRecord>();

  constructor(
    private readonly sign: Signer,
    private readonly now: () => number = Date.now,
  ) {}

  agentForKey(key: string): AgentRecord | undefined {
    for (const a of this.agents.values()) if (a.key === key) return a;
    return undefined;
  }

  createAgent(name: string): AgentRecord & { agent_key: string } {
    if (!/^[a-z0-9_]+$/.test(name ?? "")) throw new ApiError(400, "invalid_request", "name must be a lowercase slug");
    const agentId = `agt_${name}`;
    if (this.agents.has(agentId)) throw new ApiError(400, "invalid_request", `agent ${agentId} already exists`);
    const rec: AgentRecord = {
      agent: agentId,
      name,
      status: "active",
      created_at: iso(this.now()),
      key: `ak_sandbox_${randomBytes(16).toString("hex")}`,
    };
    this.agents.set(agentId, rec);
    return { ...rec, agent_key: rec.key };
  }

  setAgentStatus(agentId: string, status: AgentRecord["status"]): AgentRecord {
    const a = this.agents.get(agentId);
    if (!a) throw new ApiError(404, "not_found", `no agent ${agentId}`);
    a.status = status;
    return a;
  }

  createMandate(input: MandateInput): Mandate {
    const missing = ["principal", "agent", "categories", "expires"].filter(
      (k) => (input as unknown as Record<string, unknown>)?.[k] === undefined,
    );
    if (!input?.limits?.currency) missing.push("limits.currency");
    if (typeof input?.limits?.per_transaction !== "number") missing.push("limits.per_transaction");
    if (missing.length) throw new ApiError(400, "invalid_request", `${missing[0]} is required`);
    if (!this.agents.has(input.agent)) throw new ApiError(404, "not_found", `no agent ${input.agent}`);
    const m: Mandate = { ...input, mandate: id("mnd"), status: "active", created_at: iso(this.now()) };
    this.mandates.push(m);
    return m;
  }

  revokeMandate(mandateId: string): Mandate {
    const m = this.mandates.find((x) => x.mandate === mandateId);
    if (!m) throw new ApiError(404, "not_found", `no mandate ${mandateId}`);
    m.status = "revoked";
    m.revoked_at = iso(this.now());
    return m;
  }

  getDecision(decisionId: string, asAgent?: string): Decision {
    const d = this.decisions.find((x) => x.decision === decisionId);
    if (!d || (asAgent && d.request.agent !== asAgent)) throw new ApiError(404, "not_found", `no decision ${decisionId}`);
    return d;
  }

  async authorize(agentId: string, req: AuthorizationRequest): Promise<Decision> {
    for (const k of ["amount", "currency", "recipient", "category"] as const) {
      if (req?.[k] === undefined) throw new ApiError(400, "invalid_request", `${k} is required`);
    }
    if (typeof req.amount !== "number" || !Number.isFinite(req.amount) || req.amount <= 0) {
      throw new ApiError(400, "invalid_request", "amount must be a positive number"); // mock assumption
    }
    const agent = this.agents.get(agentId);
    if (!agent) throw new ApiError(404, "not_found", `no agent ${agentId}`);

    const now = this.now();
    const echo = {
      agent: agentId,
      amount: req.amount,
      currency: req.currency,
      recipient: req.recipient,
      category: req.category,
    };
    const { verdict, reason, mandate } = this.evaluate(agent, req, now);

    const base: UnsignedDecision = {
      decision: id("dec"),
      request: echo,
      verdict,
      reason,
      ...(mandate ? { mandate: mandate.mandate } : {}),
      policy_version: this.policyVersion,
      nonce: `n_${randomBytes(4).toString("hex")}`,
      mode: "enforce",
      issued_at: iso(now),
      ...(verdict === "allow" ? { expires_at: iso(now + ALLOW_TTL_MS) } : {}),
      ...(req.metadata ? { metadata: req.metadata } : {}),
    };
    if (verdict === "review" && mandate) {
      const rev: ReviewRecord = {
        review: id("rev"),
        decision: base.decision,
        mandate: mandate.mandate,
        status: "pending",
        waits_for: mandate.principal,
        expires_at: now + REVIEW_TTL_MS,
      };
      this.reviews.set(rev.review, rev);
      base.review = { review: rev.review, waits_for: rev.waits_for, expires_at: iso(rev.expires_at) };
    }
    const decision: Decision = { ...base, verdict_token: await this.sign(base) };
    this.decisions.push(decision);
    return decision;
  }

  async approveReview(reviewId: string): Promise<Decision> {
    const rev = this.reviews.get(reviewId);
    if (!rev) throw new ApiError(404, "not_found", `no review ${reviewId}`);
    const now = this.now();
    if (rev.status !== "pending" || rev.expires_at < now) {
      throw new ApiError(400, "invalid_request", `review ${reviewId} is not pending`);
    }
    const original = this.getDecision(rev.decision);
    const agent = this.agents.get(original.request.agent)!;
    const mandate = this.mandates.find((m) => m.mandate === rev.mandate)!;
    if (agent.status !== "active") throw new ApiError(400, "invalid_request", "agent is disabled");
    if (mandate.status === "revoked") throw new ApiError(400, "invalid_request", "mandate is revoked");
    if (this.isExpired(mandate, now)) throw new ApiError(400, "invalid_request", "mandate is expired");
    const month = this.monthSpend(mandate, now) + original.request.amount;
    if (mandate.limits.per_month !== undefined && month > mandate.limits.per_month) {
      throw new ApiError(400, "invalid_request", `amount exceeds per_month limit ${money(mandate.limits.per_month)}`);
    }

    rev.status = "approved";
    const base: UnsignedDecision = {
      decision: id("dec"),
      request: original.request,
      verdict: "allow",
      reason: `review ${reviewId} approved`,
      mandate: mandate.mandate,
      policy_version: this.policyVersion,
      nonce: `n_${randomBytes(4).toString("hex")}`,
      mode: "enforce",
      issued_at: iso(now),
      expires_at: iso(now + ALLOW_TTL_MS),
      supersedes: original.decision,
    };
    const decision: Decision = { ...base, verdict_token: await this.sign(base) };
    this.decisions.push(decision);
    return decision;
  }

  denyReview(reviewId: string): { review: string; status: "denied" } {
    const rev = this.reviews.get(reviewId);
    if (!rev) throw new ApiError(404, "not_found", `no review ${reviewId}`);
    if (rev.status !== "pending") throw new ApiError(400, "invalid_request", `review ${reviewId} is not pending`);
    rev.status = "denied";
    return { review: reviewId, status: "denied" };
  }

  private evaluate(
    agent: AgentRecord,
    req: AuthorizationRequest,
    now: number,
  ): { verdict: Verdict; reason: string; mandate?: Mandate } {
    if (agent.status !== "active") {
      return { verdict: "deny_no_mandate", reason: `agent ${agent.agent} is disabled` };
    }
    const candidates = this.mandates.filter((m) => m.agent === agent.agent && m.limits.currency === req.currency);
    if (!candidates.length) {
      return { verdict: "deny_no_mandate", reason: `no mandate in ${req.currency} for ${agent.agent}` };
    }
    const results = candidates.map((m) => ({ mandate: m, ...this.gate(m, agent, req, now) }));
    return (
      results.find((r) => r.verdict === "allow") ??
      results.find((r) => r.verdict === "review") ??
      results[0]!
    );
  }

  /** One mandate through the gates, in the documented order. */
  private gate(m: Mandate, agent: AgentRecord, req: AuthorizationRequest, now: number): { verdict: Verdict; reason: string } {
    if (m.status === "revoked") return { verdict: "deny_revoked", reason: `mandate ${m.mandate} was revoked` };
    if (this.isExpired(m, now)) return { verdict: "deny_expired", reason: `mandate ${m.mandate} expired ${m.expires}` };
    if (!m.categories.includes(req.category)) {
      return { verdict: "deny_category", reason: `category ${req.category} is not allowed by mandate ${m.mandate}` };
    }
    if (req.amount > m.limits.per_transaction) {
      return {
        verdict: "deny_limit",
        reason: `amount ${money(req.amount)} exceeds per_transaction limit ${money(m.limits.per_transaction)}`,
      };
    }
    if (m.limits.per_month !== undefined) {
      const total = this.monthSpend(m, now) + req.amount;
      if (total > m.limits.per_month) {
        return {
          verdict: "deny_limit",
          reason: `rolling 30-day total ${money(total)} exceeds per_month limit ${money(m.limits.per_month)}`,
        };
      }
    }
    const recent = this.decisions.filter(
      (d) => d.request.agent === agent.agent && now - Date.parse(d.issued_at) < VELOCITY_WINDOW_MS,
    ).length;
    if (recent >= VELOCITY_MAX) {
      return { verdict: "deny_velocity", reason: `${recent} decisions in the last 60 seconds` };
    }
    if (m.review_above !== undefined && req.amount > m.review_above) {
      return {
        verdict: "review",
        reason: `amount ${money(req.amount)} is above review_above ${money(m.review_above)}`,
      };
    }
    return { verdict: "allow", reason: `within mandate ${m.mandate}` };
  }

  private isExpired(m: Mandate, now: number): boolean {
    // Mock assumption: a mandate matches through the whole of its `expires` date (UTC).
    return iso(now).slice(0, 10) > m.expires;
  }

  private monthSpend(m: Mandate, now: number): number {
    return this.decisions
      .filter((d) => d.mandate === m.mandate && d.verdict === "allow" && now - Date.parse(d.issued_at) < MONTH_MS)
      .reduce((s, d) => s + d.request.amount, 0);
  }

  listDecisions(filter: { agent?: string; verdict?: string; mandate?: string }): Decision[] {
    return this.decisions.filter(
      (d) =>
        (!filter.agent || d.request.agent === filter.agent) &&
        (!filter.verdict || d.verdict === filter.verdict) &&
        (!filter.mandate || d.mandate === filter.mandate),
    );
  }
}
