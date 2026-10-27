// Shapes from the public Saifuro API reference (docs.saifuro.com/api).
// Field names are canonical there; this file only mirrors them.

export const VERDICTS = [
  "allow",
  "review",
  "deny_limit",
  "deny_velocity",
  "deny_category",
  "deny_expired",
  "deny_revoked",
  "deny_no_mandate",
] as const;

export type Verdict = (typeof VERDICTS)[number];

export interface AuthorizationRequest {
  amount: number;
  currency: string;
  recipient: string;
  category: string;
  protocol?: "x402" | "mpp" | "acp" | "ap2" | "card";
  /** Only honoured with an organization key. */
  agent?: string;
  metadata?: Record<string, string>;
}

export interface RequestEcho {
  agent: string;
  amount: number;
  currency: string;
  recipient: string;
  category: string;
}

export interface Review {
  review: string;
  waits_for: string;
  expires_at: string;
}

export interface Decision {
  decision: string;
  request: RequestEcho;
  verdict: Verdict;
  reason: string;
  mandate?: string;
  policy_version: string;
  nonce: string;
  mode: "enforce" | "observe";
  issued_at: string;
  expires_at?: string;
  verdict_token: string;
  review?: Review;
  supersedes?: string;
  metadata?: Record<string, string>;
}

export interface MandateInput {
  principal: string;
  agent: string;
  limits: { per_transaction: number; per_month?: number; currency: string };
  categories: string[];
  review_above?: number;
  /** ISO date (YYYY-MM-DD) after which the mandate stops matching. */
  expires: string;
}

export interface Mandate extends MandateInput {
  mandate: string;
  status: "active" | "revoked" | "expired";
  created_at: string;
  revoked_at?: string;
}

export interface Agent {
  agent: string;
  name: string;
  status: "active" | "disabled";
  created_at: string;
  agent_key?: string;
}

export interface ApiErrorBody {
  error: { code: string; message: string; request_id: string };
}

/** Claims of a verdict token, per docs.saifuro.com/reference/verify-a-verdict. */
export interface VerdictClaims {
  iss: string;
  jti: string;
  iat: number;
  exp?: number;
  verdict: Verdict;
  mandate?: string;
  policy_version: string;
  nonce: string;
  request: RequestEcho;
  supersedes?: string;
}
