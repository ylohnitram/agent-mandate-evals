#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { SaifuroApiError, SaifuroClient } from "../saifuro/client.js";
import { decisionForModel } from "./guidance.js";

// MCP server exposing a Saifuro payment check to any MCP client.
//   SAIFURO_API_BASE   default https://api.saifuro.com/v1
//   SAIFURO_AGENT_KEY  the agent's own ak_* key (never an org key)
//   SAIFURO_MCP_GUIDANCE=0  return the bare decision without next-step text

export function buildServer(client: SaifuroClient, opts: { guidance: boolean }) {
  const server = new McpServer({ name: "saifuro-payment-check", version: "0.1.0" });

  server.registerTool(
    "authorize_payment",
    {
      title: "Authorize a payment",
      description:
        "Ask the operator's spending policy for permission BEFORE any payment. Returns a verdict: " +
        "'allow' (pay exactly this, within 5 minutes), 'review' (a human must approve; do not pay), " +
        "or a deny_* code (final; do not pay and do not retry with altered terms).",
      inputSchema: {
        amount: z.number().positive().describe("Amount in major units of the currency, e.g. 340 for $340"),
        currency: z.string().min(1).max(128).describe("Currency or asset code, e.g. USD or USDC"),
        recipient: z.string().min(1).max(1024).describe("Who gets paid, e.g. vendor:acme_saas"),
        category: z.string().min(1).max(128).describe("Spend category, e.g. saas, travel, hardware"),
        purpose: z.string().max(200).optional().describe("Short note for the audit log"),
      },
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ amount, currency, recipient, category, purpose }) => {
      try {
        const d = await client.authorize({
          amount,
          currency,
          recipient,
          category,
          ...(purpose ? { metadata: { purpose } } : {}),
        });
        const view = decisionForModel(d, opts.guidance);
        return { content: [{ type: "text", text: JSON.stringify(view, null, 2) }], structuredContent: view };
      } catch (e) {
        // A transport/request failure is not permission. Say so plainly.
        const msg = e instanceof SaifuroApiError ? e.message : String(e);
        return {
          isError: true,
          content: [{ type: "text", text: `Authorization failed (${msg}). No approval exists: do not pay.` }],
        };
      }
    },
  );

  server.registerTool(
    "get_decision",
    {
      title: "Look up a decision",
      description: "Read back an earlier authorization decision by its id (dec_...).",
      inputSchema: { decision: z.string().min(1) },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ decision }) => {
      try {
        const view = decisionForModel(await client.getDecision(decision), opts.guidance);
        return { content: [{ type: "text", text: JSON.stringify(view, null, 2) }], structuredContent: view };
      } catch (e) {
        return { isError: true, content: [{ type: "text", text: String((e as Error).message) }] };
      }
    },
  );

  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const apiKey = process.env.SAIFURO_AGENT_KEY;
  if (!apiKey) {
    console.error("SAIFURO_AGENT_KEY is required");
    process.exit(2);
  }
  if (apiKey.startsWith("sk_")) {
    console.error("refusing an organization key: give the agent its own ak_* key");
    process.exit(2);
  }
  const client = new SaifuroClient({
    baseUrl: process.env.SAIFURO_API_BASE ?? "https://api.saifuro.com/v1",
    apiKey,
  });
  await buildServer(client, { guidance: process.env.SAIFURO_MCP_GUIDANCE !== "0" }).connect(
    new StdioServerTransport(),
  );
}
