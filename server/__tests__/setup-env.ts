/**
 * Runs BEFORE the test modules are imported (vitest setupFiles), so server
 * modules that read env at import time see the scratch config — never the
 * shared RDS and never a real Retell key.
 */
const DB_URL = process.env.CC_TEST_DATABASE_URL || "postgresql://localhost:5432/ops_callcenter_dev";
process.env.DATABASE_URL = `${DB_URL}?sslmode=disable`;
process.env.RETELL_API_KEY = "key_test_0000000000000000000000000000";
delete process.env.RETELL_WEBHOOK_API_KEY;
delete process.env.RETELL_TOOL_AUTH_SECRET;
delete process.env.CC_VERIFY_WEBHOOK_URL;
process.env.RP_SITE_API_URL = "https://site.test";
process.env.RP_SITE_OPS_TOKEN = "test-token";
process.env.OPS_SESSION_SECRET = "test-session-secret-at-least-32-chars!!";
process.env.CC_VERIFY_HASH_SECRET = "test-verify-hash-secret";
