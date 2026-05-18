/**
 * Writes one row to the shared `ai_costs` table for every Bedrock/Anthropic
 * call originating from the ops dashboard. Mirrors FitScript's logAiCost.
 *
 * Surfaces from this repo use the prefix `ops_` (e.g. `ops_email_compose`)
 * so they don't collide with FitScript-side surface names.
 */
import { randomUUID } from "crypto";
import { pool } from "./db";
import { MODEL_PRICING } from "./lib/bedrock";

type LogArgs = {
  userId?: string | null;
  surface: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  latencyMs?: number;
  metadata?: Record<string, unknown>;
};

function computeCostUsd(args: LogArgs): number {
  const pricing = MODEL_PRICING[args.model];
  if (!pricing) {
    console.warn(`[OPS AI COST] Unknown model pricing for ${args.model}`);
    return 0;
  }
  const inputRate = pricing.input / 1_000_000;
  const outputRate = pricing.output / 1_000_000;
  // Cache reads bill at 10% of input. Cache writes at 2.0x for 1h TTL.
  const cacheRead = (args.cacheReadTokens || 0) * inputRate * 0.1;
  const cacheWrite = (args.cacheWriteTokens || 0) * inputRate * 2.0;
  const fresh = args.inputTokens * inputRate;
  const output = args.outputTokens * outputRate;
  return fresh + cacheRead + cacheWrite + output;
}

export async function logAiCost(args: LogArgs): Promise<void> {
  try {
    const costUsd = computeCostUsd(args);
    await pool.query(
      `INSERT INTO ai_costs
       (id, user_id, surface, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, latency_ms, metadata, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())`,
      [
        randomUUID(),
        args.userId ?? null,
        args.surface,
        args.model,
        args.inputTokens,
        args.outputTokens,
        args.cacheReadTokens ?? 0,
        args.cacheWriteTokens ?? 0,
        costUsd,
        args.latencyMs ?? null,
        args.metadata ? JSON.stringify(args.metadata) : null,
      ],
    );
  } catch (e) {
    // Never throw into the user response path.
    console.warn("[OPS AI COST] log failed:", (e as Error).message);
  }
}
