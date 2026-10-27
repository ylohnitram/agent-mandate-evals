import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { VerdictClaims } from "./types.js";

export const SAIFURO_ISSUER = "https://verdicts.saifuro.com";
export const SAIFURO_JWKS_URL = "https://verdicts.saifuro.com/.well-known/jwks.json";

const MAX_TOKEN_BYTES = 8 * 1024;
const MAX_IAT_SKEW_S = 60;

export interface Deal {
  amount: number;
  currency: string;
  recipient: string;
}

export interface NonceStore {
  /** Atomically record a nonce; false when it was already seen (a replay). */
  claim(nonce: string, expiresAt: number): boolean | Promise<boolean>;
}

/** Process-local store. A real deployment shares one across every instance that settles. */
export class MemoryNonceStore implements NonceStore {
  private readonly seen = new Map<string, number>();
  claim(nonce: string, expiresAt: number): boolean {
    const now = Date.now() / 1000;
    for (const [n, exp] of this.seen) if (exp < now) this.seen.delete(n);
    if (this.seen.has(nonce)) return false;
    this.seen.set(nonce, expiresAt);
    return true;
  }
}

export interface VerifierOptions {
  jwks?: JWTVerifyGetKey;
  issuer?: string;
  /** Accept `sandbox-*` keys. Must stay false anywhere real money settles. */
  allowSandbox?: boolean;
  /** Mandates the paying operator handed over; any other mandate's allow is refused. */
  operatorMandates?: readonly string[];
  nonces?: NonceStore;
  clockSkewS?: number;
  currentDate?: Date;
}

export class VerdictRejected extends Error {}

/**
 * Settlement-side check of a Saifuro verdict, following
 * docs.saifuro.com/reference/verify-a-verdict: signature, issuer and expiry;
 * then the deal comparison, structure checks, operator check and the nonce
 * (recorded last, only after everything else passed).
 */
export class VerdictVerifier {
  private readonly jwks: JWTVerifyGetKey;
  private readonly nonces: NonceStore;
  private readonly acceptedSupersedes = new Set<string>();

  constructor(private readonly opts: VerifierOptions = {}) {
    this.jwks =
      opts.jwks ?? createRemoteJWKSet(new URL(SAIFURO_JWKS_URL), { cacheMaxAge: 300_000 });
    this.nonces = opts.nonces ?? new MemoryNonceStore();
  }

  async check(token: string, deal: Deal): Promise<VerdictClaims> {
    if (Buffer.byteLength(token) > MAX_TOKEN_BYTES) throw new VerdictRejected("token too large");
    if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) {
      throw new VerdictRejected("malformed token segments");
    }
    const kid = decodeProtectedHeader(token).kid ?? "";
    if (kid.startsWith("sandbox-") && !this.opts.allowSandbox) {
      throw new VerdictRejected("sandbox verdict: never a production approval");
    }

    let payload: VerdictClaims;
    try {
      const res = await jwtVerify(token, this.jwks, {
        issuer: this.opts.issuer ?? SAIFURO_ISSUER,
        algorithms: ["ES256"],
        requiredClaims: ["exp", "iat", "nonce", "verdict", "request"],
        clockTolerance: this.opts.clockSkewS ?? 0,
        currentDate: this.opts.currentDate,
      });
      payload = res.payload as unknown as VerdictClaims;
    } catch (e) {
      throw new VerdictRejected(`signature/claims: ${(e as Error).message}`);
    }

    const now = (this.opts.currentDate?.getTime() ?? Date.now()) / 1000;
    if (payload.iat > now + MAX_IAT_SKEW_S) throw new VerdictRejected("iat in the future");
    if ("aud" in payload) throw new VerdictRejected("unexpected aud claim");
    if (payload.verdict !== "allow") throw new VerdictRejected(`not an approval: ${payload.verdict}`);
    if (!payload.mandate) throw new VerdictRejected("allow without mandate");

    const r = payload.request;
    if (r.amount !== deal.amount || r.currency !== deal.currency || r.recipient !== deal.recipient) {
      throw new VerdictRejected("approval is for a different transaction");
    }
    if (this.opts.operatorMandates && !this.opts.operatorMandates.includes(payload.mandate)) {
      throw new VerdictRejected(`mandate ${payload.mandate} was not issued by this operator`);
    }
    if (payload.supersedes && this.acceptedSupersedes.has(payload.supersedes)) {
      throw new VerdictRejected(`review ${payload.supersedes} already settled`);
    }
    if (!(await this.nonces.claim(payload.nonce, (payload.exp ?? now) + (this.opts.clockSkewS ?? 0)))) {
      throw new VerdictRejected(`replayed nonce ${payload.nonce}`);
    }
    if (payload.supersedes) this.acceptedSupersedes.add(payload.supersedes);
    return payload;
  }
}
