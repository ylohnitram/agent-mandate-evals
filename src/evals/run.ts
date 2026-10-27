import "./no-tracing.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { startMockServer } from "../mock/server.js";
import { SAIFURO_JWKS_URL } from "../saifuro/verify.js";
import { runOne, type RunRecord, type Target } from "./run-one.js";
import { SCENARIOS } from "./scenarios.js";

const { values } = parseArgs({
  options: {
    models: { type: "string", default: "scripted:follower,scripted:evader" },
    scenarios: { type: "string" },
    reps: { type: "string", default: "1" },
    target: { type: "string", default: "mock" },
    guidance: { type: "string", default: "on" }, // on | off | both
    payees: { type: "string", default: "off" }, // MCP payee allowlist: on | off | both
    "max-tokens": { type: "string", default: "300000" },
    "max-turns": { type: "string", default: "10" },
    out: { type: "string", default: "results" },
  },
});

const models = values.models!.split(",").map((s) => s.trim()).filter(Boolean);
const scenarios = values.scenarios
  ? SCENARIOS.filter((s) => values.scenarios!.split(",").includes(s.id))
  : SCENARIOS;
const flag = (v: string | undefined, dflt: boolean) => (v === "both" ? [true, false] : [v === undefined ? dflt : v === "on"]);
const variants = flag(values.guidance, true).flatMap((guidance) =>
  flag(values.payees, false).map((payees) => ({ guidance, payees })),
);
const varies = { guidance: values.guidance === "both", payees: values.payees === "both" };
const reps = Number(values.reps);
const maxTokens = Number(values["max-tokens"]);

let mock: Awaited<ReturnType<typeof startMockServer>> | undefined;
let target: Target;
if (values.target === "sandbox") {
  const orgKey = process.env.SAIFURO_ORG_KEY;
  if (!orgKey?.startsWith("sk_sandbox_")) throw new Error("SAIFURO_ORG_KEY must be an sk_sandbox_ key");
  target = {
    name: "sandbox",
    baseUrl: process.env.SAIFURO_API_BASE ?? "https://api.saifuro.com/v1",
    orgKey,
    jwksUrl: SAIFURO_JWKS_URL,
  };
} else {
  mock = await startMockServer();
  target = { name: "mock", baseUrl: mock.baseUrl, orgKey: mock.orgKey, jwksUrl: mock.jwksUrl };
}

const records: RunRecord[] = [];
let spent = 0;
outer: for (const model of models) {
  for (const v of variants) {
    for (const s of scenarios) {
      for (let rep = 1; rep <= reps; rep++) {
        if (spent >= maxTokens) {
          console.error(`token budget ${maxTokens} reached, stopping`);
          break outer;
        }
        const r = await runOne(s, model, target, { ...v, rep, maxTurns: Number(values["max-turns"]) });
        spent += r.tokens.input + r.tokens.output;
        records.push(r);
        const failed = r.grade.checks.filter((c) => !c.ok).map((c) => `${c.name}${c.detail ? `: ${c.detail}` : ""}`);
        console.log(
          `${r.grade.pass ? "PASS" : "FAIL"}  ${model}  guidance=${v.guidance ? "on" : "off"} payees=${v.payees ? "on" : "off"}  ${s.id}#${rep}` +
            `  ${r.tokens.input + r.tokens.output} tok${failed.length ? `\n      ${failed.join("\n      ")}` : ""}`,
        );
      }
    }
  }
}
await mock?.close();

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
mkdirSync(values.out!, { recursive: true });
const md = summary(records, target.name);
writeFileSync(`${values.out}/${stamp}.json`, JSON.stringify({ target: target.name, records }, null, 2));
writeFileSync(`${values.out}/${stamp}.md`, md);
console.log(`\n${md}\nsaved ${values.out}/${stamp}.{json,md}`);
process.exitCode = 0;

function summary(rs: RunRecord[], targetName: string): string {
  const key = (r: RunRecord) => {
    const tags = [
      ...(varies.guidance ? [`guidance ${r.guidance ? "on" : "off"}`] : []),
      ...(varies.payees ? [`payees ${r.payees ? "on" : "off"}`] : []),
    ];
    return `${r.model}${tags.length ? ` (${tags.join(", ")})` : ""}`;
  };
  const cols = [...new Set(rs.map(key))];
  const lines = [
    `Target: ${targetName}. Cell = passed runs / runs.`,
    "",
    `| scenario | ${cols.join(" | ")} |`,
    `| --- | ${cols.map(() => "---").join(" | ")} |`,
  ];
  for (const s of [...new Set(rs.map((r) => r.scenario))]) {
    const cells = cols.map((c) => {
      const xs = rs.filter((r) => r.scenario === s && key(r) === c);
      return xs.length ? `${xs.filter((r) => r.grade.pass).length}/${xs.length}` : "–";
    });
    lines.push(`| ${s} | ${cells.join(" | ")} |`);
  }
  const totals = cols.map((c) => {
    const xs = rs.filter((r) => key(r) === c);
    const tok = xs.reduce((a, r) => a + r.tokens.input + r.tokens.output, 0);
    return `${xs.filter((r) => r.grade.pass).length}/${xs.length} (${tok} tok)`;
  });
  lines.push(`| **total** | ${totals.join(" | ")} |`);
  return lines.join("\n") + "\n";
}
