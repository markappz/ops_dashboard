/**
 * Helper for reading + writing keys inside the prod/ops-secrets
 * AWS Secrets Manager JSON.
 *
 * When an integration credential is updated from the dashboard:
 *   1. We merge the new value into the secret JSON in AWS Secrets Manager
 *      (so the next container restart sees it).
 *   2. We ALSO set process.env[key] in the running container immediately
 *      (so we don't need an ECS redeploy to start using the new value).
 *
 * Requires the running container's IAM creds to have:
 *   secretsmanager:GetSecretValue + secretsmanager:UpdateSecret on
 *   prod/ops-secrets.
 */
import {
  SecretsManagerClient,
  GetSecretValueCommand,
  UpdateSecretCommand,
} from "@aws-sdk/client-secrets-manager";

const SECRET_ID = process.env.OPS_SECRETS_ID || "prod/ops-secrets";
const REGION = process.env.AWS_REGION || "us-east-1";

let client: SecretsManagerClient | null = null;
function getClient(): SecretsManagerClient {
  if (!client) {
    client = new SecretsManagerClient({ region: REGION });
  }
  return client;
}

export function isSecretsManagerConfigured(): boolean {
  return !!(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY);
}

/**
 * Read the entire secret JSON. Returns the parsed object.
 * Throws if the secret doesn't exist or perms are missing.
 */
async function readSecret(): Promise<Record<string, string>> {
  const out = await getClient().send(
    new GetSecretValueCommand({ SecretId: SECRET_ID }),
  );
  const raw = out.SecretString;
  if (!raw) throw new Error("Secret has no SecretString");
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`Secret is not valid JSON: ${(e as Error).message}`);
  }
}

/**
 * Update one or more fields inside the secret JSON.
 * Other fields are preserved. Also reflects updates into process.env
 * immediately so the running container picks them up without restart.
 */
export async function writeSecretFields(
  updates: Record<string, string>,
): Promise<void> {
  if (!isSecretsManagerConfigured()) {
    throw new Error(
      "AWS Secrets Manager not configured (AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY missing)",
    );
  }
  const current = await readSecret();
  const merged = { ...current, ...updates };
  await getClient().send(
    new UpdateSecretCommand({
      SecretId: SECRET_ID,
      SecretString: JSON.stringify(merged),
    }),
  );
  // Reflect into the running process so handlers using process.env.X
  // pick up the new value immediately.
  for (const [k, v] of Object.entries(updates)) {
    process.env[k] = v;
  }
}

/**
 * Force-reload from AWS Secrets Manager into process.env without writing.
 * Useful after an out-of-band rotation (someone updated the secret via
 * AWS Console or CLI) and you want the running container to pick it up
 * without redeploying.
 */
export async function reloadSecretIntoEnv(): Promise<{ keys: string[] }> {
  const current = await readSecret();
  for (const [k, v] of Object.entries(current)) {
    if (typeof v === "string") process.env[k] = v;
  }
  return { keys: Object.keys(current) };
}
