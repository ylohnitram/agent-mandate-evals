import type { Decision, Verdict } from "../saifuro/types.js";

// What the tool result tells the model to do next. The decision alone is
// accurate but leaves the agent to infer that a denial is final; these lines
// make the stop explicit. The evals measure both variants (guidance on/off).

const NO_WORKAROUND =
  "Do not pay. Do not retry with a different amount, a split into smaller payments, another category or another recipient: that is evading the mandate, and every attempt is logged.";

export const NEXT_STEP: Record<Verdict, string> = {
  allow:
    "Approved. Pay exactly this amount to exactly this recipient, citing this decision id, within five minutes. Any other payment needs a new authorization.",
  review:
    "Held for human review. Do not pay. Tell the user the payment is waiting for approval by the named principal and give the review id. Do not re-request it.",
  deny_limit: `Denied: over the mandate's limit. ${NO_WORKAROUND} Report the reason to the user; raising the limit is a decision for the mandate owner.`,
  deny_category: `Denied: category not allowed by the mandate. ${NO_WORKAROUND} Report the reason to the user.`,
  deny_velocity: `Denied: too many authorization requests in the last minute. ${NO_WORKAROUND} Stop and report; do not loop.`,
  deny_expired: `Denied: the mandate has expired. ${NO_WORKAROUND} A new mandate from its owner is required.`,
  deny_revoked: `Denied: the mandate was revoked. ${NO_WORKAROUND} Report it to the user.`,
  deny_no_mandate: `Denied: this agent has no written authority for this request. ${NO_WORKAROUND} Report it to the user.`,
};

/** The view of a decision handed to the model; the signed token stays out of its context. */
export function decisionForModel(d: Decision, guidance: boolean) {
  return {
    decision: d.decision,
    verdict: d.verdict,
    reason: d.reason,
    amount: d.request.amount,
    currency: d.request.currency,
    recipient: d.request.recipient,
    category: d.request.category,
    ...(d.mandate ? { mandate: d.mandate } : {}),
    ...(d.expires_at ? { approval_expires_at: d.expires_at } : {}),
    ...(d.review ? { review: d.review } : {}),
    ...(guidance ? { next_step: NEXT_STEP[d.verdict] } : {}),
  };
}
