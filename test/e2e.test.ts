import "../src/evals/no-tracing.js";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startMockServer, type MockServer } from "../src/mock/server.js";
import { SaifuroClient } from "../src/saifuro/client.js";
import { runOne, type Target } from "../src/evals/run-one.js";
import { procurement, SCENARIOS } from "../src/evals/scenarios.js";

let mock: MockServer;
let target: Target;

before(async () => {
  mock = await startMockServer();
  target = { name: "mock", baseUrl: mock.baseUrl, orgKey: mock.orgKey, jwksUrl: mock.jwksUrl };
});
after(() => mock.close());

test("MCP server: lists the tools and returns a guided decision", async () => {
  const org = new SaifuroClient({ baseUrl: mock.baseUrl, apiKey: mock.orgKey });
  const a = await org.createAgent("mcp_probe");
  await org.createMandate(procurement(a.agent));

  const client = new Client({ name: "test", version: "0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", "src/mcp/server.ts"],
      env: { PATH: process.env.PATH ?? "", SAIFURO_API_BASE: mock.baseUrl, SAIFURO_AGENT_KEY: a.agent_key! },
    }),
  );
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ["authorize_payment", "get_decision"]);
    const res = await client.callTool({
      name: "authorize_payment",
      arguments: { amount: 720, currency: "USD", recipient: "vendor:acme_saas", category: "saas" },
    });
    const view = res.structuredContent as Record<string, string>;
    assert.equal(view.verdict, "deny_limit");
    assert.match(view.next_step!, /Do not retry/);
    assert.equal("verdict_token" in view, false, "the signed token stays out of the model's context");
  } finally {
    await client.close();
  }
});

test("MCP server: a payee outside the allowlist never reaches the API", async () => {
  const org = new SaifuroClient({ baseUrl: mock.baseUrl, apiKey: mock.orgKey });
  const a = await org.createAgent("mcp_payees");
  await org.createMandate(procurement(a.agent));
  const client = new Client({ name: "test", version: "0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", "src/mcp/server.ts"],
      env: {
        PATH: process.env.PATH ?? "",
        SAIFURO_API_BASE: mock.baseUrl,
        SAIFURO_AGENT_KEY: a.agent_key!,
        SAIFURO_ALLOWED_RECIPIENTS: "vendor:acme_saas",
      },
    }),
  );
  try {
    const args = { amount: 60, currency: "USD", category: "saas" };
    const refused = await client.callTool({ name: "authorize_payment", arguments: { ...args, recipient: "vendor:acme_billing_eu" } });
    assert.equal(refused.isError, true);
    const ok = await client.callTool({ name: "authorize_payment", arguments: { ...args, recipient: "vendor:acme_saas" } });
    assert.equal((ok.structuredContent as Record<string, string>).verdict, "allow");
    const log = await org.listDecisions({ agent: a.agent });
    assert.deepEqual(log.map((d) => d.request.recipient), ["vendor:acme_saas"]);
  } finally {
    await client.close();
  }
});

test("MCP server refuses an organization key", async () => {
  const client = new Client({ name: "test", version: "0" });
  await assert.rejects(
    client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: ["--import", "tsx", "src/mcp/server.ts"],
        env: { PATH: process.env.PATH ?? "", SAIFURO_AGENT_KEY: mock.orgKey },
        stderr: "ignore",
      }),
    ),
  );
});

test("graders: a rule-following agent passes every scenario", async () => {
  for (const s of SCENARIOS) {
    const r = await runOne(s, "scripted:follower", target, { guidance: true, rep: 1 });
    assert.ok(r.grade.pass, `${s.id}: ${JSON.stringify(r.grade.checks.filter((c) => !c.ok))}`);
    assert.equal(r.grade.firstVerdict, s.verdict, s.id);
  }
});

test("graders: an evading agent fails every scenario where evasion is possible", async () => {
  const failed: string[] = [];
  for (const s of SCENARIOS) {
    const r = await runOne(s, "scripted:evader", target, { guidance: true, rep: 1 });
    if (!r.grade.pass) failed.push(s.id);
  }
  assert.deepEqual(
    failed,
    SCENARIOS.filter((s) => !["allow_pays_once", "review_escalates"].includes(s.id)).map((s) => s.id),
  );
});
