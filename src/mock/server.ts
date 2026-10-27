import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { SAIFURO_ISSUER } from "../saifuro/verify.js";
import { ApiError, PolicyEngine, type UnsignedDecision } from "./engine.js";

export interface MockServer {
  url: string;
  baseUrl: string;
  jwksUrl: string;
  orgKey: string;
  engine: PolicyEngine;
  close(): Promise<void>;
}

const MAX_BODY = 64 * 1024;
const KID = "sandbox-mock-1";

/** Local stand-in for https://api.saifuro.com/v1 with sandbox-keyed verdicts. */
export async function startMockServer(port = 0): Promise<MockServer> {
  const { publicKey, privateKey } = await generateKeyPair("ES256");
  const jwk = { ...(await exportJWK(publicKey)), use: "sig", alg: "ES256", kid: KID };

  const sign = (d: UnsignedDecision) => {
    const iat = Math.floor(Date.parse(d.issued_at) / 1000);
    return new SignJWT({
      verdict: d.verdict,
      ...(d.mandate ? { mandate: d.mandate } : {}),
      policy_version: d.policy_version,
      nonce: d.nonce,
      request: d.request,
      ...(d.supersedes ? { supersedes: d.supersedes } : {}),
    })
      .setProtectedHeader({ alg: "ES256", typ: "JWT", kid: KID })
      .setIssuer(SAIFURO_ISSUER)
      .setJti(d.decision)
      .setIssuedAt(iat)
      .setExpirationTime(iat + 300)
      .sign(privateKey);
  };

  const engine = new PolicyEngine(sign);
  const idempotency = new Map<string, { bodyHash: string; status: number; payload: unknown }>();

  const server = createServer((req, res) => {
    handle(req, res).catch((e) => {
      const err = e instanceof ApiError ? e : new ApiError(500, "server_error", String(e));
      send(res, err.status, { error: { code: err.code, message: err.message, request_id: res.getHeader("x-request-id") } });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse) {
    res.setHeader("x-request-id", `req_${randomBytes(8).toString("hex")}`);
    const url = new URL(req.url ?? "/", "http://mock");
    const method = req.method ?? "GET";

    if (method === "GET" && url.pathname === "/.well-known/jwks.json") {
      return send(res, 200, { keys: [jwk] });
    }
    if (!url.pathname.startsWith("/v1/")) throw new ApiError(404, "not_found", `no route ${url.pathname}`);

    const key = /^Bearer (\S+)$/.exec(req.headers.authorization ?? "")?.[1];
    const isOrg = key === engine.orgKey;
    const agent = key && !isOrg ? engine.agentForKey(key) : undefined;
    if (!isOrg && !agent) throw new ApiError(401, "unauthorized", "Missing or revoked key.");
    const requireOrg = () => {
      if (!isOrg) throw new ApiError(403, "forbidden", "This endpoint needs an organization key");
    };

    const raw = method === "POST" ? await readBody(req) : "";
    let body: Record<string, unknown> = {};
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        throw new ApiError(400, "invalid_request", "body is not valid JSON");
      }
    }

    // Idempotency: same key + same body replays the stored answer; a different body is a 409.
    const idemKey = req.headers["idempotency-key"];
    const idemSlot = typeof idemKey === "string" && method === "POST" ? `${key}:${idemKey}` : undefined;
    const bodyHash = createHash("sha256").update(raw).digest("hex");
    if (idemSlot) {
      const prior = idempotency.get(idemSlot);
      if (prior && prior.bodyHash !== bodyHash) {
        throw new ApiError(409, "idempotency_conflict", "Idempotency-Key reused with a different body");
      }
      if (prior) return send(res, prior.status, prior.payload);
    }

    const respond = (status: number, payload: unknown) => {
      if (idemSlot) idempotency.set(idemSlot, { bodyHash, status, payload });
      send(res, status, payload);
    };

    const seg = url.pathname.split("/").slice(2); // after "v1"
    const route = `${method} /${seg.map((s, i) => (i % 2 === 1 ? ":id" : s)).join("/")}`;
    const pid = seg[1] ?? "";

    try {
      switch (route) {
        case "POST /authorizations": {
          const agentId = isOrg ? String(body.agent ?? "") : agent!.agent;
          if (isOrg && !agentId) throw new ApiError(400, "invalid_request", "agent is required with an organization key");
          return respond(201, await engine.authorize(agentId, body as never));
        }
        case "GET /decisions/:id":
          return send(res, 200, engine.getDecision(pid, isOrg ? undefined : agent!.agent));
        case "GET /decisions": {
          const filter = Object.fromEntries(url.searchParams);
          if (!isOrg) filter.agent = agent!.agent;
          const all = engine.listDecisions(filter);
          const limit = Number(filter.limit ?? 20);
          if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
            throw new ApiError(400, "invalid_request", "limit must be an integer between 1 and 100");
          }
          const offset = filter.cursor ? Number(Buffer.from(filter.cursor.slice(4), "base64url").toString()) : 0;
          const data = all.slice(offset, offset + limit);
          const hasMore = offset + limit < all.length;
          return send(res, 200, {
            data,
            has_more: hasMore,
            ...(hasMore ? { next_cursor: `cur_${Buffer.from(String(offset + limit)).toString("base64url")}` } : {}),
          });
        }
        case "POST /agents":
          requireOrg();
          return respond(201, publicAgent(engine.createAgent(String(body.name ?? "")), true));
        case "POST /agents/:id/disable":
          requireOrg();
          return respond(200, publicAgent(engine.setAgentStatus(pid, "disabled")));
        case "POST /agents/:id/enable":
          requireOrg();
          return respond(200, publicAgent(engine.setAgentStatus(pid, "active")));
        case "POST /mandates":
          requireOrg();
          return respond(201, engine.createMandate(body as never));
        case "POST /mandates/:id/revoke":
          requireOrg();
          return respond(200, engine.revokeMandate(pid));
        case "POST /reviews/:id/approve":
          requireOrg();
          return respond(201, await engine.approveReview(pid));
        case "POST /reviews/:id/deny":
          requireOrg();
          return respond(200, engine.denyReview(pid));
        default:
          throw new ApiError(400, "invalid_request", `${method} is not supported on ${url.pathname}`);
      }
    } catch (e) {
      // 4xx answers other than 401/403/429 are stored under the Idempotency-Key, like the real API.
      if (e instanceof ApiError && e.status >= 400 && e.status < 500 && ![401, 403, 429].includes(e.status)) {
        respond(e.status, { error: { code: e.code, message: e.message, request_id: res.getHeader("x-request-id") } });
        return;
      }
      throw e;
    }
  }

  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    baseUrl: `${url}/v1`,
    jwksUrl: `${url}/.well-known/jwks.json`,
    orgKey: engine.orgKey,
    engine,
    close: () => new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

function publicAgent(a: { agent: string; name: string; status: string; created_at: string; key: string }, withKey = false) {
  const { key, ...rest } = a;
  return withKey ? { ...rest, agent_key: key } : rest;
}

function send(res: ServerResponse, status: number, payload: unknown) {
  if (res.headersSent) return;
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new ApiError(400, "invalid_request", "body over 64 KB"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
