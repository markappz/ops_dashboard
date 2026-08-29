// Wire ops to the new realpeptides.co in one shot:
//   1. mint the shared RP_SITE_OPS_TOKEN (or keep the existing one on a re-run)
//   2. add RP_SITE_API_URL + RP_SITE_OPS_TOKEN to Secrets Manager prod/ops-secrets
//   3. register a new task-def revision with the two secret refs and point the
//      service at it (the console's revision-dropdown trap, avoided in code)
//   4. print the token to hand the dev team — they set it as OPS_SUMMARY_TOKEN
// Run from ~/Projects/ops-dashboard:  node scripts/wire-rp-site.mjs
import crypto from "crypto";
import { readFileSync } from "fs";
import { SecretsManagerClient, GetSecretValueCommand, PutSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { ECSClient, DescribeServicesCommand, DescribeTaskDefinitionCommand, RegisterTaskDefinitionCommand, UpdateServiceCommand } from "@aws-sdk/client-ecs";

const CLUSTER = "fitscript-cluster";
const SERVICE = "fitscript-ops-task-service-vnvy470x";
const SECRET_ID = "prod/ops-secrets";
const SITE_URL = "https://www.realpeptides.co";

const env = Object.fromEntries(readFileSync(".env", "utf8").split("\n").filter((l) => l.includes("=") && !l.startsWith("#")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
const creds = { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY };
const sm = new SecretsManagerClient({ region: "us-east-1", credentials: creds });
const ecs = new ECSClient({ region: "us-east-1", credentials: creds });

// 1+2. Secret JSON: keep an existing token on re-runs so the devs' copy stays valid.
const cur = await sm.send(new GetSecretValueCommand({ SecretId: SECRET_ID }));
const json = JSON.parse(cur.SecretString);
const token = json.RP_SITE_OPS_TOKEN || crypto.randomBytes(32).toString("hex");
const already = !!json.RP_SITE_OPS_TOKEN;
json.RP_SITE_OPS_TOKEN = token;
json.RP_SITE_API_URL = SITE_URL;
await sm.send(new PutSecretValueCommand({ SecretId: SECRET_ID, SecretString: JSON.stringify(json) }));
console.log(`secret updated (${already ? "kept existing token" : "minted new token"})`);

// 3. New task-def revision with the two refs, service pointed at it.
const svc = await ecs.send(new DescribeServicesCommand({ cluster: CLUSTER, services: [SERVICE] }));
const tdArn = svc.services[0].taskDefinition;
const { taskDefinition: td } = await ecs.send(new DescribeTaskDefinitionCommand({ taskDefinition: tdArn }));
const container = td.containerDefinitions[0];
const secretArnBase = container.secrets[0].valueFrom.replace(/:[A-Z_]+::$/, "");
for (const name of ["RP_SITE_API_URL", "RP_SITE_OPS_TOKEN"]) {
  if (!container.secrets.some((s) => s.name === name)) {
    container.secrets.push({ name, valueFrom: `${secretArnBase}:${name}::` });
  }
}
const reg = await ecs.send(new RegisterTaskDefinitionCommand({
  family: td.family,
  taskRoleArn: td.taskRoleArn,
  executionRoleArn: td.executionRoleArn,
  networkMode: td.networkMode,
  containerDefinitions: td.containerDefinitions,
  requiresCompatibilities: td.requiresCompatibilities,
  cpu: td.cpu,
  memory: td.memory,
  runtimePlatform: td.runtimePlatform,
}));
const newArn = reg.taskDefinition.taskDefinitionArn;
await ecs.send(new UpdateServiceCommand({ cluster: CLUSTER, service: SERVICE, taskDefinition: newArn, forceNewDeployment: true }));
console.log(`service → ${newArn.split("/").pop()} (deployment rolling; ~3 min)`);

console.log(`\nSend the dev team this token (their env var OPS_SUMMARY_TOKEN — do NOT commit it):\n\n  ${token}\n`);
