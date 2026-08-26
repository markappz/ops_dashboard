/**
 * AI client wrapper. Mirrors FitScript's server/lib/bedrock.ts.
 *
 * AWS Bedrock is the ONLY AI path. There is deliberately no direct-Anthropic
 * fallback: ops reads FitScript's database, so its prompts can carry PHI, and
 * Bedrock is the route covered by the AWS BAA. A fallback would let a missing
 * credential silently reroute that traffic to a vendor outside the agreement.
 * See FitScript DECISIONS.md 2026-08-26.
 *
 * No keys are passed: the SDK resolves them through fromNodeProviderChain,
 * which reads env vars first and then the ECS container credential provider.
 * That is what lets the task role work without a static access key.
 *
 * Cost pricing tables match FitScript so writes to the shared `ai_costs`
 * table (in the same RDS) compute consistently across both services.
 */
import AnthropicBedrock from "@anthropic-ai/bedrock-sdk";

const region = process.env.AWS_REGION || "us-east-1";

console.log(`[OPS AI] Using AWS Bedrock (${region}) via the default credential chain`);

const client = new AnthropicBedrock({ awsRegion: region });

export { client as anthropic };

export const BEDROCK_MODELS = {
  HIGH_IQ: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
  FAST: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
} as const;

// Bare model IDs are retained only so historical `ai_costs` rows written while
// the direct-API path existed still price correctly. Nothing emits them now.
export const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "us.anthropic.claude-sonnet-4-5-20250929-v1:0": { input: 3.0, output: 15.0 },
  "us.anthropic.claude-haiku-4-5-20251001-v1:0": { input: 0.25, output: 1.25 },
  "claude-sonnet-4-5-20250929": { input: 3.0, output: 15.0 },
  "claude-haiku-4-5-20251001": { input: 0.25, output: 1.25 },
};

/**
 * Credentials are resolved by the SDK at call time, so there is nothing to
 * check synchronously — the previous env-var test reported "not configured"
 * whenever the app ran on a task role instead of a static key, which would have
 * silently disabled all seventeen AI call sites behind it. A genuinely missing
 * credential now surfaces as an error from the call rather than a quiet 503.
 */
export function isAIConfigured(): boolean {
  return true;
}
