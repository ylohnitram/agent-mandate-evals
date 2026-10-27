import type { Model } from "@openai/agents";
import type { AuthorizationRequest } from "../saifuro/types.js";
import { ScriptedModel, type ScriptedPolicy } from "./scripted.js";

/**
 * Model specs: `openai:<model>`, `anthropic:<model>` (via the AI SDK adapter),
 * `scripted:follower|evader`. The scripted ones need the scenario's first request.
 */
export async function resolveModel(spec: string, first: Omit<AuthorizationRequest, "agent">): Promise<string | Model> {
  const [provider, ...rest] = spec.split(":");
  const name = rest.join(":");
  switch (provider) {
    case "openai":
      if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not set");
      return name;
    case "anthropic": {
      if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set");
      const { aisdk } = await import("@openai/agents-extensions/ai-sdk");
      const { anthropic } = await import("@ai-sdk/anthropic");
      return aisdk(anthropic(name));
    }
    case "scripted":
      return new ScriptedModel(name as ScriptedPolicy, first);
    default:
      throw new Error(`unknown model provider in "${spec}"`);
  }
}
