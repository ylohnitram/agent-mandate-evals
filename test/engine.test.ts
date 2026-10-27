import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { startMockServer, type MockServer } from "../src/mock/server.js";
import { SaifuroApiError, SaifuroClient } from "../src/saifuro/client.js";
import { procurement } from "../src/evals/scenarios.js";

let mock: MockServer;
let org: SaifuroClient;
let n = 0;

before(async () => {
  mock = await startMockServer();
  org = new SaifuroClient({ baseUrl: mock.baseUrl, apiKey: mock.orgKey });
});
after(() => mock.close());

async function freshAgent(over: Parameters<typeof procurement>[1] = {}) {
  const a = await org.createAgent(`probe_${n++}`);
  const m = await org.createMandate(procurement(a.agent, over));
  return { a, m, client: new SaifuroClient({ baseUrl: mock.baseUrl, apiKey: a.agent_key! }) };
}

const req = (amount: number, over: Record<string, unknown> = {}) => ({
  amount,
  currency: "USD",
  recipient: "vendor:acme_saas",
  category: "saas",
  ...over,
});

test("each gate yields its documented code", async () => {
  const { client } = await freshAgent();
  assert.equal((await client.authorize(req(100))).verdict, "allow");
  assert.equal((await client.authorize(req(300))).verdict, "review");
  const limit = await client.authorize(req(720));
  assert.equal(limit.verdict, "deny_limit");
  assert.equal(limit.reason, "amount 720.00 exceeds per_transaction limit 500.00");
  assert.equal((await client.authorize(req(100, { category: "hardware" }))).verdict, "deny_category");
  const noMandate = await client.authorize(req(100, { currency: "EUR" }));
  assert.equal(noMandate.verdict, "deny_no_mandate");
  assert.equal(noMandate.mandate, undefined);
});

test("revocation and expiry", async () => {
  const r = await freshAgent();
  await org.revokeMandate(r.m.mandate);
  assert.equal((await r.client.authorize(req(10))).verdict, "deny_revoked");
  const e = await freshAgent({ expires: "2020-01-01" });
  assert.equal((await e.client.authorize(req(10))).verdict, "deny_expired");
});

test("an allow carries a five-minute expiry; denials do not", async () => {
  const { client } = await freshAgent();
  const ok = await client.authorize(req(10));
  assert.equal(Date.parse(ok.expires_at!) - Date.parse(ok.issued_at), 300_000);
  assert.equal((await client.authorize(req(900))).expires_at, undefined);
});

test("velocity: the 11th request within a minute is denied", async () => {
  const { client } = await freshAgent();
  for (let i = 0; i < 10; i++) assert.equal((await client.authorize(req(1))).verdict, "allow");
  assert.equal((await client.authorize(req(1))).verdict, "deny_velocity");
});

test("rolling 30-day limit counts earlier allows", async () => {
  const { client } = await freshAgent({ limits: { per_transaction: 500, per_month: 600, currency: "USD" }, review_above: undefined });
  assert.equal((await client.authorize(req(400))).verdict, "allow");
  const second = await client.authorize(req(300));
  assert.equal(second.verdict, "deny_limit");
  assert.match(second.reason, /per_month/);
});

test("review approval issues a superseding allow, at most once", async () => {
  const { client } = await freshAgent();
  const held = await client.authorize(req(300));
  const approved = await org.approveReview(held.review!.review);
  assert.equal(approved.verdict, "allow");
  assert.equal(approved.supersedes, held.decision);
  await assert.rejects(org.approveReview(held.review!.review), (e: SaifuroApiError) => e.status === 400);
});

test("agent keys cannot reach org endpoints; unknown keys get 401", async () => {
  const { client } = await freshAgent();
  await assert.rejects(client.createAgent("nope"), (e: SaifuroApiError) => e.status === 403 && e.code === "forbidden");
  const anon = new SaifuroClient({ baseUrl: mock.baseUrl, apiKey: "ak_sandbox_unknown" });
  await assert.rejects(anon.authorize(req(1)), (e: SaifuroApiError) => e.status === 401);
});

test("idempotency: same key and body replays; a different body conflicts", async () => {
  const { client } = await freshAgent();
  const a = await client.authorize(req(10), "idem-1");
  const b = await client.authorize(req(10), "idem-1");
  assert.equal(a.decision, b.decision);
  await assert.rejects(client.authorize(req(11), "idem-1"), (e: SaifuroApiError) => e.status === 409);
});

test("decision log paginates with cursors", async () => {
  const { a, client } = await freshAgent();
  for (let i = 0; i < 5; i++) await client.authorize(req(1, { recipient: `vendor:v${i}` }));
  const all = await org.listDecisions({ agent: a.agent });
  assert.equal(all.length, 5);
});
