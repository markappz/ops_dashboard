/**
 * FitScript Tracking Pixel — first-party visitor tracking
 *
 * Drop this into the main FitScript app's client to capture:
 *   - Every page view with UTM parameters
 *   - Visitor identity (persistent cookie)
 *   - Session tracking
 *   - Signup/login identification
 *   - Custom events (quiz, checkout, etc.)
 *
 * Usage in FitScript's App.tsx or main.tsx:
 *   import { initTracking, trackEvent, identifyUser } from "./lib/tracking";
 *   initTracking(); // call once on app mount
 *   identifyUser(userId); // call on login/signup
 *   trackEvent("quiz_started", { category: "weight-loss" }); // custom events
 */

const TRACK_ENDPOINT = "/api/t";
const IDENTIFY_ENDPOINT = "/api/t/identify";
const COOKIE_NAME = "fs_vid";
const SESSION_KEY = "fs_sid";
const UTM_KEY = "fs_utm";
const COOKIE_DAYS = 730; // 2 years

// ─── Cookie helpers ────────────────────────────────────────────────

function setCookie(name: string, value: string, days: number) {
  const expires = new Date(Date.now() + days * 86400000).toUTCString();
  document.cookie = `${name}=${value};expires=${expires};path=/;SameSite=Lax`;
}

function getCookie(name: string): string | null {
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

function generateId(): string {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// ─── Visitor & Session ─────────────────────────────────────────────

function getVisitorId(): string {
  let vid = getCookie(COOKIE_NAME);
  if (!vid) {
    vid = generateId();
    setCookie(COOKIE_NAME, vid, COOKIE_DAYS);
  }
  return vid;
}

function getSessionId(): string {
  let sid = sessionStorage.getItem(SESSION_KEY);
  if (!sid) {
    sid = generateId();
    sessionStorage.setItem(SESSION_KEY, sid);
  }
  return sid;
}

// ─── UTM Parsing ───────────────────────────────────────────────────

interface UTMData {
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_content?: string;
  utm_term?: string;
  gclid?: string;
  fbclid?: string;
  ttclid?: string;
}

function parseUTMs(): UTMData {
  // Check if we already have UTMs stored for this session
  const stored = sessionStorage.getItem(UTM_KEY);
  if (stored) return JSON.parse(stored);

  // Parse from URL
  const params = new URLSearchParams(window.location.search);
  const utm: UTMData = {};

  for (const key of ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "gclid", "fbclid", "ttclid"]) {
    const val = params.get(key);
    if (val) (utm as any)[key] = val;
  }

  // If no UTM source, infer from referrer
  if (!utm.utm_source && document.referrer) {
    try {
      const ref = new URL(document.referrer);
      if (ref.hostname.includes("google")) { utm.utm_source = "google"; utm.utm_medium = "organic"; }
      else if (ref.hostname.includes("facebook") || ref.hostname.includes("fb.")) { utm.utm_source = "facebook"; utm.utm_medium = "social"; }
      else if (ref.hostname.includes("instagram")) { utm.utm_source = "instagram"; utm.utm_medium = "social"; }
      else if (ref.hostname.includes("tiktok")) { utm.utm_source = "tiktok"; utm.utm_medium = "social"; }
      else if (ref.hostname.includes("youtube")) { utm.utm_source = "youtube"; utm.utm_medium = "social"; }
      else if (ref.hostname.includes("twitter") || ref.hostname.includes("x.com")) { utm.utm_source = "twitter"; utm.utm_medium = "social"; }
      else if (ref.hostname.includes("linkedin")) { utm.utm_source = "linkedin"; utm.utm_medium = "social"; }
      else if (!ref.hostname.includes("fitscript")) { utm.utm_source = ref.hostname; utm.utm_medium = "referral"; }
    } catch {}
  }

  // Store for the session so we don't re-parse on every page
  if (Object.keys(utm).length > 0) {
    sessionStorage.setItem(UTM_KEY, JSON.stringify(utm));
  }

  return utm;
}

// ─── Device Detection ──────────────────────────────────────────────

function getDeviceType(): string {
  const ua = navigator.userAgent;
  if (/tablet|ipad/i.test(ua)) return "tablet";
  if (/mobile|iphone|android/i.test(ua)) return "mobile";
  return "desktop";
}

// ─── Send Event ────────────────────────────────────────────────────

function sendEvent(eventType: string, extra?: Record<string, any>) {
  const utm = parseUTMs();
  const payload = {
    visitor_id: getVisitorId(),
    session_id: getSessionId(),
    event_type: eventType,
    page_url: window.location.pathname,
    referrer: document.referrer,
    device_type: getDeviceType(),
    ...utm,
    event_data: extra || {},
  };

  // Use sendBeacon for reliability (survives page navigation)
  if (navigator.sendBeacon) {
    navigator.sendBeacon(TRACK_ENDPOINT, JSON.stringify(payload));
  } else {
    fetch(TRACK_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      keepalive: true,
    }).catch(() => {}); // silent fail
  }
}

// ─── Public API ────────────────────────────────────────────────────

/**
 * Initialize tracking. Call once on app mount.
 * Tracks the initial page view and sets up navigation tracking.
 */
export function initTracking() {
  // Track initial page view
  sendEvent("page_view");

  // Track subsequent navigations (SPA)
  let lastPath = window.location.pathname;
  const observer = new MutationObserver(() => {
    if (window.location.pathname !== lastPath) {
      lastPath = window.location.pathname;
      sendEvent("page_view");
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });

  // Also listen for popstate (back/forward)
  window.addEventListener("popstate", () => {
    if (window.location.pathname !== lastPath) {
      lastPath = window.location.pathname;
      sendEvent("page_view");
    }
  });
}

/**
 * Track a custom event.
 */
export function trackEvent(eventType: string, data?: Record<string, any>) {
  sendEvent(eventType, data);
}

/**
 * Identify a user — call on signup or login.
 * Links all previous anonymous touchpoints to this user.
 */
export function identifyUser(userId: string) {
  const payload = {
    visitor_id: getVisitorId(),
    user_id: userId,
  };

  fetch(IDENTIFY_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }).catch(() => {});
}

/**
 * Track a revenue event — call when payment succeeds.
 */
export function trackRevenue(userId: string, amount: number, eventType = "payment") {
  fetch("/api/t/revenue", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user_id: userId, amount, event_type: eventType }),
  }).catch(() => {});
}

/**
 * Get the current visitor ID (for debugging).
 */
export function getVisitorIdPublic(): string {
  return getVisitorId();
}
