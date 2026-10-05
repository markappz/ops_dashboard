import { pool } from "./db";
import { firePlan } from "./realpeptides-marketing";
import { ENGINES, engineCompanies } from "./brand-engines";

/** Loud failure alert straight to Paul's inbox (Paul 10-04, after the open-180d fire failed
 * silently: "we need to fix this so it doesn't happen again"). Rides the bridge's test-send
 * pipe; alert failures only log — they never mask the original error. */
async function alertFailure(subject: string, lines: string[], brandLabel: string): Promise<void> {
  try {
    const to = process.env.OPS_ALERT_EMAIL || "paulclotar@gmail.com";
    const html = `<div style="font-family:Arial,sans-serif;padding:18px;border:3px solid #dc2626;border-radius:8px"><h2 style="color:#dc2626;margin:0 0 10px">⚠️ Scheduled send needs attention</h2>${lines.map((l) => `<p style="margin:4px 0;font-size:14px">${l}</p>`).join("")}<p style="margin:14px 0 0;font-size:13px">Fix or reschedule: ops → ${brandLabel} → Broadcasts → Drafts &amp; scheduled.</p></div>`;
    const { sendOpsAlert } = await import("./realpeptides-marketing");
    await sendOpsAlert(to, subject, html);
  } catch (e: any) {
    console.error(`[OPS][SCHEDULER] alert email failed too: ${e.message}`);
  }
}

/**
 * Scheduled broadcast firing (2026-10-02, Paul: "get the scheduled sends ready and in queue").
 *
 * Every minute: plans for any ENGINE brand (brand-engines registry — RP, pawgen, PeptideU once
 * their env is staged) that a human explicitly set to status='scheduled' with a send_date,
 * send_time and timezone fire when their wall-clock moment arrives IN THAT TIMEZONE. The
 * human approval is setting the status (the UI shows the live recipient count at that
 * moment); this loop is just the alarm clock. Resend-era brands (fitscript) also use
 * status='scheduled' after a push — Resend fires those itself, so they are never selected here.
 *
 * Safety rails, in order:
 *  - CLAIM: status flips scheduled→sending atomically; whichever ECS task wins the UPDATE
 *    sends, the loser sees zero rows (rolling deploys run two tasks side by side).
 *  - MISSED: a plan more than 3 hours past due refuses to fire and is marked 'missed' —
 *    after downtime, a stale 9am blast at 2pm is a decision for a human, not a loop.
 *  - FAILED: a bridge error marks 'send_failed' (never back to scheduled: no retry storms
 *    against a 9k-recipient segment).
 *
 * DST-safe by construction: we compare wall-clock STRINGS — "now, formatted in the plan's
 * timezone" against "send_date send_time" — so the comparison always happens in the
 * plan's own local clock. sv-SE gives ISO-shaped YYYY-MM-DD HH:mm.
 */

const DEFAULT_TZ = "America/New_York"; // the UI's historical "Time (ET)" label

export function wallClock(tz: string, d = new Date()): string {
  try {
    return new Intl.DateTimeFormat("sv-SE", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false,
    }).format(d).replace(",", "");
  } catch {
    return wallClock(DEFAULT_TZ, d);
  }
}

async function tick(): Promise<void> {
  const companies = engineCompanies();
  if (!companies.length) return;
  const { rows } = await pool.query(
    `SELECT id, company, title, subject, html, audience_id,
            send_date::text AS send_date, send_time, COALESCE(send_tz, $1) AS send_tz
       FROM ops_email_plans
      WHERE company = ANY($2::text[]) AND status = 'scheduled'
        AND send_date IS NOT NULL AND send_time IS NOT NULL`,
    [DEFAULT_TZ, companies],
  );
  for (const p of rows) {
    const label = ENGINES[p.company]?.label ?? p.company;
    const schedAt = `${p.send_date} ${String(p.send_time).slice(0, 5)}`;
    const now = wallClock(p.send_tz);
    if (now < schedAt) continue;

    const threeHoursAgo = wallClock(p.send_tz, new Date(Date.now() - 3 * 3600_000));
    if (schedAt < threeHoursAgo) {
      await pool.query(`UPDATE ops_email_plans SET status = 'missed', updated_at = NOW() WHERE id = $1 AND status = 'scheduled'`, [p.id]);
      console.error(`[OPS][SCHEDULER] ${p.company} plan ${p.id} "${p.title}" was due ${schedAt} ${p.send_tz} — >3h late, marked missed (never auto-fires stale)`);
      await alertFailure(`Scheduled campaign MISSED: ${p.title}`, [`${label} plan ${p.id} was due ${schedAt} ${p.send_tz} but the scheduler was down past its window.`, `It did NOT send and will not auto-fire stale.`], label);
      continue;
    }

    const claim = await pool.query(
      `UPDATE ops_email_plans SET status = 'sending', updated_at = NOW() WHERE id = $1 AND status = 'scheduled' RETURNING id`,
      [p.id],
    );
    if (!claim.rows[0]) continue; // another task got it

    if (!p.subject || !p.html) {
      await pool.query(`UPDATE ops_email_plans SET status = 'send_failed', updated_at = NOW() WHERE id = $1`, [p.id]);
      console.error(`[OPS][SCHEDULER] ${p.company} plan ${p.id} missing subject/html — marked send_failed`);
      continue;
    }

    try {
      const out = await firePlan(p.company, p, "scheduler");
      console.log(`[OPS][SCHEDULER] ${p.company} plan ${p.id} "${p.title}" fired at ${schedAt} ${p.send_tz}: ${out.sent}/${out.of} (${out.tag})`);
    } catch (e: any) {
      await pool.query(`UPDATE ops_email_plans SET status = 'send_failed', updated_at = NOW() WHERE id = $1`, [p.id]);
      console.error(`[OPS][SCHEDULER] ${p.company} plan ${p.id} "${p.title}" FAILED: ${e.message} — marked send_failed, no auto-retry`);
      await alertFailure(`Scheduled campaign FAILED: ${p.title}`, [`${label} plan ${p.id} ("${p.subject}") failed at fire time.`, `Error: ${String(e.message).slice(0, 300)}`, `Zero or partial sends possible — check the ledger before retrying.`], label);
    }
  }
}

export function startEmailSchedulerLoop(): void {
  setInterval(() => {
    tick().catch((e) => console.error(`[OPS][SCHEDULER] tick crashed: ${e.message}`));
  }, 60_000);
  console.log(`[OPS][SCHEDULER] scheduled-send loop armed (60s, engine brands: ${engineCompanies().join(", ") || "none configured"})`);
}
