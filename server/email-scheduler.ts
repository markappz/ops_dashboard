import { pool } from "./db";
import { fireRpPlan } from "./realpeptides-marketing";

/**
 * Scheduled broadcast firing (2026-10-02, Paul: "get the scheduled sends ready and in queue").
 *
 * Every minute: RP plans a human explicitly set to status='scheduled' with a send_date,
 * send_time and timezone fire when their wall-clock moment arrives IN THAT TIMEZONE. The
 * human approval is setting the status (the UI shows the live recipient count at that
 * moment); this loop is just the alarm clock.
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

function wallClock(tz: string, d = new Date()): string {
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
  const { rows } = await pool.query(
    `SELECT id, title, subject, html, audience_id,
            send_date::text AS send_date, send_time, COALESCE(send_tz, $1) AS send_tz
       FROM ops_email_plans
      WHERE company = 'realpeptides' AND status = 'scheduled'
        AND send_date IS NOT NULL AND send_time IS NOT NULL`,
    [DEFAULT_TZ],
  );
  for (const p of rows) {
    const schedAt = `${p.send_date} ${String(p.send_time).slice(0, 5)}`;
    const now = wallClock(p.send_tz);
    if (now < schedAt) continue;

    const threeHoursAgo = wallClock(p.send_tz, new Date(Date.now() - 3 * 3600_000));
    if (schedAt < threeHoursAgo) {
      await pool.query(`UPDATE ops_email_plans SET status = 'missed', updated_at = NOW() WHERE id = $1 AND status = 'scheduled'`, [p.id]);
      console.error(`[OPS][SCHEDULER] plan ${p.id} "${p.title}" was due ${schedAt} ${p.send_tz} — >3h late, marked missed (never auto-fires stale)`);
      continue;
    }

    const claim = await pool.query(
      `UPDATE ops_email_plans SET status = 'sending', updated_at = NOW() WHERE id = $1 AND status = 'scheduled' RETURNING id`,
      [p.id],
    );
    if (!claim.rows[0]) continue; // another task got it

    if (!p.subject || !p.html) {
      await pool.query(`UPDATE ops_email_plans SET status = 'send_failed', updated_at = NOW() WHERE id = $1`, [p.id]);
      console.error(`[OPS][SCHEDULER] plan ${p.id} missing subject/html — marked send_failed`);
      continue;
    }

    try {
      const out = await fireRpPlan(p, "scheduler");
      console.log(`[OPS][SCHEDULER] plan ${p.id} "${p.title}" fired at ${schedAt} ${p.send_tz}: ${out.sent}/${out.of} (${out.tag})`);
    } catch (e: any) {
      await pool.query(`UPDATE ops_email_plans SET status = 'send_failed', updated_at = NOW() WHERE id = $1`, [p.id]);
      console.error(`[OPS][SCHEDULER] plan ${p.id} "${p.title}" FAILED: ${e.message} — marked send_failed, no auto-retry`);
    }
  }
}

export function startEmailSchedulerLoop(): void {
  setInterval(() => {
    tick().catch((e) => console.error(`[OPS][SCHEDULER] tick crashed: ${e.message}`));
  }, 60_000);
  console.log("[OPS][SCHEDULER] scheduled-send loop armed (60s, RP plans only)");
}
