// SES failover setup (run by Paul via `!`): creates the three sending-domain
// identities (Easy DKIM) + a send-only IAM user, and prints the DKIM CNAME
// records to add in DNS. The IAM secret is WRITTEN TO A FILE (~/.ses-send-key.json),
// never printed. Safe to re-run: existing identities/users are reused.
// Run: node scripts/setup-ses.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const req = createRequire("/Users/paul/Projects/ops-dashboard/noop.js");
const { SESv2Client, CreateEmailIdentityCommand, GetEmailIdentityCommand } = req("@aws-sdk/client-sesv2");
const { IAMClient, CreateUserCommand, PutUserPolicyCommand, CreateAccessKeyCommand, ListAccessKeysCommand } = req("@aws-sdk/client-iam");

const REGION = "us-east-1";
const DOMAINS = ["pawgen.com", "peptideu.co", "realpeptides.co"];
const ses = new SESv2Client({ region: REGION });

for (const domain of DOMAINS) {
  let tokens;
  try {
    const out = await ses.send(new CreateEmailIdentityCommand({ EmailIdentity: domain }));
    tokens = out.DkimAttributes?.Tokens ?? [];
    console.log(`\n${domain}: identity created`);
  } catch (e) {
    if (e.name !== "AlreadyExistsException") throw e;
    const out = await ses.send(new GetEmailIdentityCommand({ EmailIdentity: domain }));
    tokens = out.DkimAttributes?.Tokens ?? [];
    console.log(`\n${domain}: identity already exists (status: ${out.VerifiedForSendingStatus ? "VERIFIED" : "pending DNS"})`);
  }
  console.log(`  DKIM CNAMEs for ${domain}:`);
  for (const t of tokens) console.log(`    ${t}._domainkey.${domain}  CNAME  ${t}.dkim.amazonses.com`);
}

const iam = new IAMClient({ region: REGION });
const USER = "ses-sender";
try {
  await iam.send(new CreateUserCommand({ UserName: USER }));
  console.log(`\nIAM user ${USER} created`);
} catch (e) {
  if (e.name !== "EntityAlreadyExistsException") throw e;
  console.log(`\nIAM user ${USER} already exists`);
}
await iam.send(new PutUserPolicyCommand({
  UserName: USER,
  PolicyName: "ses-send-only",
  PolicyDocument: JSON.stringify({
    Version: "2012-10-17",
    Statement: [{ Effect: "Allow", Action: ["ses:SendEmail", "ses:SendRawEmail"], Resource: "*" }],
  }),
}));
const existing = await iam.send(new ListAccessKeysCommand({ UserName: USER }));
const keyFile = path.join(os.homedir(), ".ses-send-key.json");
if (existing.AccessKeyMetadata?.length && fs.existsSync(keyFile)) {
  console.log(`access key already exists and ${keyFile} is present — reusing`);
} else {
  const key = await iam.send(new CreateAccessKeyCommand({ UserName: USER }));
  fs.writeFileSync(keyFile, JSON.stringify({
    SES_ACCESS_KEY_ID: key.AccessKey.AccessKeyId,
    SES_SECRET_ACCESS_KEY: key.AccessKey.SecretAccessKey,
    SES_REGION: REGION,
  }, null, 2), { mode: 0o600 });
  console.log(`send-only access key written to ${keyFile} (never printed)`);
}
console.log("\nNEXT: add the DKIM CNAMEs above in DNS, then request SES production access in the console.");
