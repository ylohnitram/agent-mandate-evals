import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createLocalJWKSet } from "jose";
import { startMockServer } from "../src/mock/server.js";
import { SaifuroClient } from "../src/saifuro/client.js";
import { VerdictVerifier } from "../src/saifuro/verify.js";
import { procurement } from "../src/evals/scenarios.js";

// The sample verdict published on docs.saifuro.com/reference/verify-a-verdict,
// signed with Saifuro's production key `verdict-2026-09`. It predates signed
// currency and expired on 2026-09-03 08:48 UTC.
const DOCS_TOKEN =
  "eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6InZlcmRpY3QtMjAyNi0wOSJ9.eyJpc3MiOiJodHRwczovL3ZlcmRpY3RzLnNhaWZ1cm8uY29tIiwianRpIjoiZGVjXzViMmUiLCJpYXQiOjE3ODg0MjQ5ODAsImV4cCI6MTc4ODQyNTI4MCwidmVyZGljdCI6ImFsbG93IiwibWFuZGF0ZSI6Im1uZF83ZjNhIiwicG9saWN5X3ZlcnNpb24iOiJwb2xfMjAyNi0wOC0xMi4zIiwibm9uY2UiOiJuXzlkMDJjNmU0IiwicmVxdWVzdCI6eyJhZ2VudCI6ImFndF9wcm9jdXJlbWVudF8wMSIsImFtb3VudCI6MzQwLCJyZWNpcGllbnQiOiJ2ZW5kb3I6YWNtZV9zYWFzIiwiY2F0ZWdvcnkiOiJzYWFzIn19.oV4a02jtE2oEKvnSXxQ-YqJcpp8UvFZiuh3AeTb5Iy5Ony9jC1AA7EX-YPSKDuSFPxSNS4SlXLtU9-j0J36cbQ";
const jwks = createLocalJWKSet(
  JSON.parse(readFileSync(new URL("./fixtures/saifuro-jwks-2026-10.json", import.meta.url), "utf8")),
);
const deal = { amount: 340, currency: "USD", recipient: "vendor:acme_saas" };
const whileAlive = new Date("2026-09-03T08:45:00Z");

test("docs token: signature verifies against Saifuro's published key, then fails the currency check", async () => {
  const v = new VerdictVerifier({ jwks, currentDate: whileAlive });
  // Getting as far as the deal comparison means signature, issuer and expiry all passed.
  await assert.rejects(v.check(DOCS_TOKEN, deal), /different transaction/);
});

test("docs token: rejected today because it expired", async () => {
  await assert.rejects(new VerdictVerifier({ jwks }).check(DOCS_TOKEN, deal), /signature\/claims.*exp/);
});

test("docs token: any edit to the payload breaks the signature", async () => {
  const [h, p, s] = DOCS_TOKEN.split(".");
  const claims = JSON.parse(Buffer.from(p!, "base64url").toString());
  claims.request.amount = 3400;
  const forged = `${h}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${s}`;
  await assert.rejects(
    new VerdictVerifier({ jwks, currentDate: whileAlive }).check(forged, { ...deal, amount: 3400 }),
    /signature/,
  );
});

async function mockAllow(amount = 120) {
  const mock = await startMockServer();
  const org = new SaifuroClient({ baseUrl: mock.baseUrl, apiKey: mock.orgKey });
  const a = await org.createAgent("verify_probe");
  const m = await org.createMandate(procurement(a.agent));
  const agent = new SaifuroClient({ baseUrl: mock.baseUrl, apiKey: a.agent_key! });
  const d = await agent.authorize({ amount, currency: "USD", recipient: "vendor:docuflow", category: "saas" });
  return { mock, d, mandate: m.mandate, jwks: createLocalJWKSet(await (await fetch(mock.jwksUrl)).json()) };
}

test("sandbox-signed verdicts are refused unless sandbox is explicitly allowed", async () => {
  const { mock, d, jwks } = await mockAllow();
  try {
    const terms = { amount: 120, currency: "USD", recipient: "vendor:docuflow" };
    await assert.rejects(new VerdictVerifier({ jwks }).check(d.verdict_token, terms), /sandbox verdict/);
    const claims = await new VerdictVerifier({ jwks, allowSandbox: true }).check(d.verdict_token, terms);
    assert.equal(claims.verdict, "allow");
  } finally {
    await mock.close();
  }
});

test("an approval settles once, only for its own terms and its operator's mandates", async () => {
  const { mock, d, mandate, jwks } = await mockAllow();
  try {
    const terms = { amount: 120, currency: "USD", recipient: "vendor:docuflow" };
    const other = new VerdictVerifier({ jwks, allowSandbox: true, operatorMandates: ["mnd_someone_else"] });
    await assert.rejects(other.check(d.verdict_token, terms), /not issued by this operator/);

    const v = new VerdictVerifier({ jwks, allowSandbox: true, operatorMandates: [mandate] });
    await assert.rejects(v.check(d.verdict_token, { ...terms, amount: 1200 }), /different transaction/);
    await assert.rejects(v.check(d.verdict_token, { ...terms, recipient: "vendor:evil" }), /different transaction/);
    await v.check(d.verdict_token, terms);
    await assert.rejects(v.check(d.verdict_token, terms), /replayed nonce/);
  } finally {
    await mock.close();
  }
});
