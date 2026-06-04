import express, { type Express, type Request, type Response } from "express";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { gunzipSync } from "node:zlib";
import AdmZip from "adm-zip";
import { XMLParser } from "fast-xml-parser";
import multer from "multer";
import { pool } from "./db";

// ─── Schema bootstrap (idempotent) ─────────────────────────────────

async function ensureDmarcTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS dmarc_reports (
      id UUID PRIMARY KEY,
      report_id TEXT NOT NULL,
      org_name TEXT NOT NULL,
      org_email TEXT,
      domain TEXT NOT NULL,
      date_range_start TIMESTAMP NOT NULL,
      date_range_end TIMESTAMP NOT NULL,
      policy_p TEXT,
      policy_adkim TEXT,
      policy_aspf TEXT,
      policy_pct INTEGER,
      total_messages INTEGER NOT NULL DEFAULT 0,
      ingested_at TIMESTAMP NOT NULL DEFAULT NOW(),
      UNIQUE (org_name, report_id)
    );
    CREATE INDEX IF NOT EXISTS dmarc_reports_date_idx
      ON dmarc_reports(date_range_start DESC);
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS dmarc_records (
      id UUID PRIMARY KEY,
      report_id UUID NOT NULL REFERENCES dmarc_reports(id) ON DELETE CASCADE,
      source_ip TEXT NOT NULL,
      count INTEGER NOT NULL,
      disposition TEXT,
      dkim_evaluated TEXT,
      spf_evaluated TEXT,
      header_from TEXT,
      dkim_domain TEXT,
      dkim_result TEXT,
      dkim_selector TEXT,
      spf_domain TEXT,
      spf_result TEXT,
      spf_scope TEXT
    );
    CREATE INDEX IF NOT EXISTS dmarc_records_report_id_idx
      ON dmarc_records(report_id);
    CREATE INDEX IF NOT EXISTS dmarc_records_source_ip_idx
      ON dmarc_records(source_ip);
  `);
}

// ─── XML extraction + parsing ──────────────────────────────────────

function extractXmlFromBuffer(filename: string, buf: Buffer): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".gz")) {
    return gunzipSync(buf).toString("utf-8");
  }
  if (lower.endsWith(".zip")) {
    const zip = new AdmZip(buf);
    const entries = zip.getEntries();
    const xmlEntry = entries.find((e) => e.entryName.toLowerCase().endsWith(".xml"));
    if (!xmlEntry) throw new Error(".zip contained no .xml file");
    return xmlEntry.getData().toString("utf-8");
  }
  if (lower.endsWith(".xml")) {
    return buf.toString("utf-8");
  }
  // Best-effort: detect by magic bytes
  if (buf[0] === 0x1f && buf[1] === 0x8b) return gunzipSync(buf).toString("utf-8");
  if (buf[0] === 0x50 && buf[1] === 0x4b) {
    const zip = new AdmZip(buf);
    const xml = zip.getEntries().find((e) => e.entryName.toLowerCase().endsWith(".xml"));
    if (xml) return xml.getData().toString("utf-8");
  }
  return buf.toString("utf-8");
}

interface ParsedReport {
  reportId: string;
  orgName: string;
  orgEmail: string | null;
  domain: string;
  startUnix: number;
  endUnix: number;
  policyP: string | null;
  policyAdkim: string | null;
  policyAspf: string | null;
  policyPct: number | null;
  records: ParsedRecord[];
}

interface ParsedRecord {
  sourceIp: string;
  count: number;
  disposition: string | null;
  dkimEvaluated: string | null;
  spfEvaluated: string | null;
  headerFrom: string | null;
  dkimDomain: string | null;
  dkimResult: string | null;
  dkimSelector: string | null;
  spfDomain: string | null;
  spfResult: string | null;
  spfScope: string | null;
}

function s(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return String(v);
}
function n(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const num = Number(v);
  return Number.isFinite(num) ? num : null;
}
function arr<T>(v: T | T[] | undefined): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function parseDmarcXml(xml: string): ParsedReport {
  const parser = new XMLParser({
    ignoreAttributes: false,
    parseAttributeValue: false,
    trimValues: true,
  });
  const root = parser.parse(xml);
  const feedback = root.feedback;
  if (!feedback) throw new Error("not a DMARC aggregate report (no <feedback> root)");

  const meta = feedback.report_metadata || {};
  const policy = feedback.policy_published || {};
  const range = meta.date_range || {};

  const records: ParsedRecord[] = arr<any>(feedback.record).map((rec) => {
    const row = rec.row || {};
    const evaluated = row.policy_evaluated || {};
    const ids = rec.identifiers || {};
    const auth = rec.auth_results || {};
    const dkim = arr<any>(auth.dkim)[0] || {};
    const spf = arr<any>(auth.spf)[0] || {};
    return {
      sourceIp: s(row.source_ip) || "",
      count: n(row.count) || 0,
      disposition: s(evaluated.disposition),
      dkimEvaluated: s(evaluated.dkim),
      spfEvaluated: s(evaluated.spf),
      headerFrom: s(ids.header_from),
      dkimDomain: s(dkim.domain),
      dkimResult: s(dkim.result),
      dkimSelector: s(dkim.selector),
      spfDomain: s(spf.domain),
      spfResult: s(spf.result),
      spfScope: s(spf.scope),
    };
  });

  return {
    reportId: s(meta.report_id) || randomUUID(),
    orgName: s(meta.org_name) || "unknown",
    orgEmail: s(meta.email),
    domain: s(policy.domain) || "unknown",
    startUnix: n(range.begin) || 0,
    endUnix: n(range.end) || 0,
    policyP: s(policy.p),
    policyAdkim: s(policy.adkim),
    policyAspf: s(policy.aspf),
    policyPct: n(policy.pct),
    records,
  };
}

async function storeReport(parsed: ParsedReport): Promise<{ id: string; inserted: boolean; records: number }> {
  const id = randomUUID();
  const totalMessages = parsed.records.reduce((sum, r) => sum + r.count, 0);
  const insert = await pool.query<{ id: string }>(
    `INSERT INTO dmarc_reports
       (id, report_id, org_name, org_email, domain,
        date_range_start, date_range_end,
        policy_p, policy_adkim, policy_aspf, policy_pct, total_messages)
     VALUES ($1, $2, $3, $4, $5, to_timestamp($6), to_timestamp($7), $8, $9, $10, $11, $12)
     ON CONFLICT (org_name, report_id) DO NOTHING
     RETURNING id`,
    [
      id, parsed.reportId, parsed.orgName, parsed.orgEmail, parsed.domain,
      parsed.startUnix, parsed.endUnix,
      parsed.policyP, parsed.policyAdkim, parsed.policyAspf, parsed.policyPct,
      totalMessages,
    ],
  );
  if (insert.rows.length === 0) {
    return { id: "", inserted: false, records: 0 };
  }
  const reportId = insert.rows[0].id;
  // Bulk-insert records (chunk if very large)
  for (const rec of parsed.records) {
    await pool.query(
      `INSERT INTO dmarc_records
         (id, report_id, source_ip, count, disposition,
          dkim_evaluated, spf_evaluated, header_from,
          dkim_domain, dkim_result, dkim_selector,
          spf_domain, spf_result, spf_scope)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        randomUUID(), reportId, rec.sourceIp, rec.count, rec.disposition,
        rec.dkimEvaluated, rec.spfEvaluated, rec.headerFrom,
        rec.dkimDomain, rec.dkimResult, rec.dkimSelector,
        rec.spfDomain, rec.spfResult, rec.spfScope,
      ],
    );
  }
  return { id: reportId, inserted: true, records: parsed.records.length };
}

// ─── Routes ─────────────────────────────────────────────────────────

export function registerDmarcRoutes(app: Express) {
  ensureDmarcTables().catch((err) =>
    console.warn("[OPS][DMARC] table init failed:", (err as Error).message),
  );

  // Upload one or more reports. Accepts raw body (a single .xml/.gz/.zip)
  // OR a JSON array of base64-encoded files for batch uploads from the UI.
  app.post(
    "/api/ops/dmarc/upload",
    express.raw({ type: ["application/*", "text/*"], limit: "20mb" }) as any,
    async (req: Request, res: Response) => {
      try {
        const filename = String(req.query.filename || "upload.xml");
        const buf = req.body as Buffer;
        if (!Buffer.isBuffer(buf) || buf.length === 0) {
          return res.status(400).json({ error: "empty body — POST file bytes as raw body" });
        }
        const xml = extractXmlFromBuffer(filename, buf);
        const parsed = parseDmarcXml(xml);
        const result = await storeReport(parsed);
        res.json({
          ok: true,
          filename,
          report_id: parsed.reportId,
          org_name: parsed.orgName,
          domain: parsed.domain,
          window_days:
            parsed.endUnix && parsed.startUnix
              ? Math.round((parsed.endUnix - parsed.startUnix) / 86400)
              : null,
          stored_id: result.id || null,
          inserted: result.inserted,
          duplicate: !result.inserted,
          records_count: result.records,
          total_messages: parsed.records.reduce((s, r) => s + r.count, 0),
        });
      } catch (e) {
        console.warn("[OPS][DMARC] upload failed:", (e as Error).message);
        res.status(400).json({ error: (e as Error).message });
      }
    },
  );

  // Aggregate dashboard: messages / alignment / top senders for the window.
  app.get("/api/ops/dmarc/aggregate", async (req: Request, res: Response) => {
    const days = Math.min(Math.max(parseInt(String(req.query.days || "30")), 1), 365);
    const cutoff = new Date(Date.now() - days * 86400_000);

    try {
      const summary = await pool.query<{
        reports_count: string;
        total_messages: string;
        aligned_messages: string;
        dmarc_pass: string;
        dkim_pass: string;
        spf_pass: string;
        quarantine: string;
        reject: string;
      }>(
        `SELECT
           COUNT(DISTINCT r.id)::text AS reports_count,
           COALESCE(SUM(rec.count), 0)::text AS total_messages,
           COALESCE(SUM(rec.count) FILTER (WHERE rec.dkim_evaluated = 'pass' AND rec.spf_evaluated = 'pass'), 0)::text AS aligned_messages,
           COALESCE(SUM(rec.count) FILTER (WHERE rec.dkim_evaluated = 'pass' OR rec.spf_evaluated = 'pass'), 0)::text AS dmarc_pass,
           COALESCE(SUM(rec.count) FILTER (WHERE rec.dkim_evaluated = 'pass'), 0)::text AS dkim_pass,
           COALESCE(SUM(rec.count) FILTER (WHERE rec.spf_evaluated = 'pass'), 0)::text AS spf_pass,
           COALESCE(SUM(rec.count) FILTER (WHERE rec.disposition = 'quarantine'), 0)::text AS quarantine,
           COALESCE(SUM(rec.count) FILTER (WHERE rec.disposition = 'reject'), 0)::text AS reject
         FROM dmarc_reports r
         LEFT JOIN dmarc_records rec ON rec.report_id = r.id
         WHERE r.date_range_start >= $1`,
        [cutoff],
      );

      const bySender = await pool.query<{
        source_ip: string;
        header_from: string | null;
        messages: string;
        pct_aligned: string;
        dkim_pass_pct: string;
        spf_pass_pct: string;
      }>(
        `SELECT
           rec.source_ip,
           rec.header_from,
           SUM(rec.count)::text AS messages,
           ROUND(100.0 * COALESCE(SUM(rec.count) FILTER (WHERE rec.dkim_evaluated = 'pass' AND rec.spf_evaluated = 'pass'), 0) / NULLIF(SUM(rec.count),0), 2)::text AS pct_aligned,
           ROUND(100.0 * COALESCE(SUM(rec.count) FILTER (WHERE rec.dkim_evaluated = 'pass'), 0) / NULLIF(SUM(rec.count),0), 2)::text AS dkim_pass_pct,
           ROUND(100.0 * COALESCE(SUM(rec.count) FILTER (WHERE rec.spf_evaluated = 'pass'), 0) / NULLIF(SUM(rec.count),0), 2)::text AS spf_pass_pct
         FROM dmarc_reports r
         JOIN dmarc_records rec ON rec.report_id = r.id
         WHERE r.date_range_start >= $1
         GROUP BY rec.source_ip, rec.header_from
         ORDER BY SUM(rec.count) DESC
         LIMIT 20`,
        [cutoff],
      );

      const byOrg = await pool.query<{ org_name: string; reports: string; messages: string }>(
        `SELECT
           r.org_name,
           COUNT(*)::text AS reports,
           COALESCE(SUM(rec.count), 0)::text AS messages
         FROM dmarc_reports r
         LEFT JOIN dmarc_records rec ON rec.report_id = r.id
         WHERE r.date_range_start >= $1
         GROUP BY r.org_name
         ORDER BY SUM(rec.count) DESC NULLS LAST
         LIMIT 10`,
        [cutoff],
      );

      const recent = await pool.query<{
        id: string;
        org_name: string;
        domain: string;
        date_range_start: string;
        date_range_end: string;
        total_messages: number;
        policy_p: string | null;
      }>(
        `SELECT id, org_name, domain,
           to_char(date_range_start, 'YYYY-MM-DD') AS date_range_start,
           to_char(date_range_end, 'YYYY-MM-DD') AS date_range_end,
           total_messages, policy_p
         FROM dmarc_reports
         WHERE date_range_start >= $1
         ORDER BY date_range_start DESC
         LIMIT 25`,
        [cutoff],
      );

      const s0 = summary.rows[0];
      const total = parseInt(s0.total_messages);
      const aligned = parseInt(s0.aligned_messages);
      res.json({
        window_days: days,
        generated_at: new Date().toISOString(),
        summary: {
          reports_count: parseInt(s0.reports_count),
          total_messages: total,
          aligned_messages: aligned,
          aligned_pct: total > 0 ? Math.round((aligned / total) * 10000) / 100 : null,
          dkim_pass_pct: total > 0 ? Math.round((parseInt(s0.dkim_pass) / total) * 10000) / 100 : null,
          spf_pass_pct: total > 0 ? Math.round((parseInt(s0.spf_pass) / total) * 10000) / 100 : null,
          quarantine: parseInt(s0.quarantine),
          reject: parseInt(s0.reject),
        },
        senders: bySender.rows.map((row) => ({
          source_ip: row.source_ip,
          header_from: row.header_from,
          messages: parseInt(row.messages),
          pct_aligned: row.pct_aligned ? parseFloat(row.pct_aligned) : null,
          dkim_pass_pct: row.dkim_pass_pct ? parseFloat(row.dkim_pass_pct) : null,
          spf_pass_pct: row.spf_pass_pct ? parseFloat(row.spf_pass_pct) : null,
        })),
        reporting_orgs: byOrg.rows.map((row) => ({
          org_name: row.org_name,
          reports: parseInt(row.reports),
          messages: parseInt(row.messages),
        })),
        recent_reports: recent.rows.map((row) => ({
          id: row.id,
          org_name: row.org_name,
          domain: row.domain,
          date_range_start: row.date_range_start,
          date_range_end: row.date_range_end,
          total_messages: row.total_messages,
          policy_p: row.policy_p,
        })),
      });
    } catch (e) {
      console.error("[OPS][DMARC] aggregate failed:", (e as Error).message);
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // Delete one report (for cleanup if something gets ingested wrong)
  app.delete("/api/ops/dmarc/reports/:id", async (req, res) => {
    try {
      const r = await pool.query("DELETE FROM dmarc_reports WHERE id = $1 RETURNING id", [
        req.params.id,
      ]);
      res.json({ deleted: r.rowCount === 1 });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // ─── Public webhook for Mailgun inbound (Phase 2) ───────────────
  // Mailgun forwards inbound mail to here as multipart/form-data. We verify
  // its HMAC signature, then run every attachment through the same parser
  // as the manual upload path. Add a Mailgun Route at the Mailgun UI level
  // pointing dmarc@email.fitscript.me → https://ops.fitscript.me/api/dmarc/inbound
  // then update the DMARC rua= to include that mailto:.
  //
  // Required env: MAILGUN_WEBHOOK_SIGNING_KEY (from Mailgun dashboard →
  // Sending → Domain settings → Webhooks → Signing Key).
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 20 } });
  app.post(
    "/api/dmarc/inbound",
    upload.any() as any,
    async (req: Request, res: Response) => {
      const signingKey = process.env.MAILGUN_WEBHOOK_SIGNING_KEY;
      if (!signingKey) {
        console.error("[OPS][DMARC] inbound: MAILGUN_WEBHOOK_SIGNING_KEY not set");
        return res.status(503).json({ error: "webhook signing key not configured" });
      }

      // Mailgun signature scheme: HMAC-SHA256(timestamp + token, signing_key)
      const timestamp = String(req.body?.timestamp || "");
      const token = String(req.body?.token || "");
      const signature = String(req.body?.signature || "");
      if (!timestamp || !token || !signature) {
        return res.status(401).json({ error: "missing Mailgun signature fields" });
      }
      // Replay-window guard: reject anything older than 15min
      const tsNum = parseInt(timestamp);
      if (!Number.isFinite(tsNum) || Math.abs(Date.now() / 1000 - tsNum) > 900) {
        return res.status(401).json({ error: "stale timestamp" });
      }
      const computed = createHmac("sha256", signingKey).update(timestamp + token).digest("hex");
      const sigBuf = Buffer.from(signature, "hex");
      const cmpBuf = Buffer.from(computed, "hex");
      if (sigBuf.length !== cmpBuf.length || !timingSafeEqual(sigBuf, cmpBuf)) {
        return res.status(401).json({ error: "bad signature" });
      }

      // Mailgun (parsed mode) sends attachments as multer files with .buffer.
      const files = (req.files as Express.Multer.File[]) || [];
      const recipient = String(req.body?.recipient || "");
      const sender = String(req.body?.sender || req.body?.from || "");

      const results: Array<{ filename: string; status: string; detail: string }> = [];
      for (const f of files) {
        try {
          const xml = extractXmlFromBuffer(f.originalname || f.fieldname || "report", f.buffer);
          const parsed = parseDmarcXml(xml);
          const stored = await storeReport(parsed);
          results.push({
            filename: f.originalname || f.fieldname,
            status: stored.inserted ? "ingested" : "duplicate",
            detail: `${parsed.orgName} · ${parsed.domain} · ${parsed.records.length} records`,
          });
        } catch (e) {
          results.push({
            filename: f.originalname || f.fieldname,
            status: "failed",
            detail: (e as Error).message,
          });
        }
      }

      // ALWAYS return 200 to Mailgun — non-2xx triggers retries which
      // would just keep failing on bad attachments. Log details internally.
      console.log(
        `[OPS][DMARC] inbound from ${sender} → ${recipient}: ${files.length} files, ` +
          `${results.filter((r) => r.status === "ingested").length} ingested, ` +
          `${results.filter((r) => r.status === "duplicate").length} dup, ` +
          `${results.filter((r) => r.status === "failed").length} failed`,
      );
      res.json({ ok: true, files: files.length, results });
    },
  );
}

