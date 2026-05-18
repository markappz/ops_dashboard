/**
 * AI client wrapper. Mirrors FitScript's server/lib/bedrock.ts shape:
 * Bedrock if AWS creds present, direct Anthropic API if ANTHROPIC_API_KEY,
 * otherwise stub that errors loudly on first call.
 *
 * Cost pricing tables match FitScript so writes to the shared `ai_costs`
 * table (in the same RDS) compute consistently across both services.
 */
import AnthropicBedrock from "@anthropic-ai/bedrock-sdk";
import Anthropic from "@anthropic-ai/sdk";

const hasAWSCredentials =
  !!process.env.AWS_ACCESS_KEY_ID && !!process.env.AWS_SECRET_ACCESS_KEY;

let client: AnthropicBedrock | Anthropic;

if (hasAWSCredentials) {
  const region = process.env.AWS_REGION || "us-east-1";
  console.log(`[OPS AI] Using AWS Bedrock (${region})`);
  client = new AnthropicBedrock({
    awsAccessKey: process.env.AWS_ACCESS_KEY_ID!,
    awsSecretKey: process.env.AWS_SECRET_ACCESS_KEY!,
    awsRegion: region,
  });
} else if (process.env.ANTHROPIC_API_KEY) {
  console.log("[OPS AI] Using direct Anthropic API");
  client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
} else {
  console.warn(
    "[OPS AI] No AI credentials. Set AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY or ANTHROPIC_API_KEY.",
  );
  client = new Anthropic({ apiKey: "missing" });
}

export { client as anthropic };

export const BEDROCK_MODELS = {
  HIGH_IQ: hasAWSCredentials
    ? "us.anthropic.claude-sonnet-4-5-20250929-v1:0"
    : "claude-sonnet-4-5-20250929",
  FAST: hasAWSCredentials
    ? "us.anthropic.claude-haiku-4-5-20251001-v1:0"
    : "claude-haiku-4-5-20251001",
} as const;

export const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "us.anthropic.claude-sonnet-4-5-20250929-v1:0": { input: 3.0, output: 15.0 },
  "us.anthropic.claude-haiku-4-5-20251001-v1:0": { input: 0.25, output: 1.25 },
  "claude-sonnet-4-5-20250929": { input: 3.0, output: 15.0 },
  "claude-haiku-4-5-20251001": { input: 0.25, output: 1.25 },
};

export function isAIConfigured(): boolean {
  return hasAWSCredentials || !!process.env.ANTHROPIC_API_KEY;
}
