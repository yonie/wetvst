/**
 * Server-side page-view counting for wetvst.com.
 *
 * Why it exists: there are no access logs for this site. Cloudflare's free plan
 * does not return clientRefererHost from the GraphQL analytics API (verified
 * again 2026-09-20: "zone does not have access to the field
 * 'clientrefererhost'"), and the GitHub traffic API is repo-level, so it says
 * nothing about the site that is the top referrer to every repo. The one figure
 * worth having - what sends people here - has to be recorded in front of the
 * origin.
 *
 * This is Pages middleware rather than a standalone Worker on purpose. The site
 * is served by Cloudflare Pages, so a Worker routed at wetvst.com/* would
 * re-enter itself on its own fetch(). Middleware runs in-line and passes the
 * request on with context.next().
 *
 * Deliberately not an analytics beacon: no script is added to the page and no
 * cookie is set. Two tables are written:
 *
 * - `hits`: counters over (day, referrer, page, country, device).
 * - `visits`: one row per page view, carrying a visitor key so the pages one
 *   visitor saw on one day can be read in order. The key is a hash of the IP
 *   address and user agent with a random salt that exists for one UTC day
 *   only. The IP and user agent are never stored, and once the day's salt is
 *   deleted a key cannot be recomputed from them, so keys from different days
 *   cannot be linked to each other or to anyone.
 */

// A key links requests within one day and nothing more. The salt is made on
// the day's first request, kept in D1 so every isolate agrees on it, and the
// previous days' salts are deleted as soon as a new one exists.
let cachedSalt = null; // { day, salt } for this isolate

async function daySalt(db, day) {
  if (cachedSalt && cachedSalt.day === day) return cachedSalt.salt;
  const fresh = [...crypto.getRandomValues(new Uint8Array(32))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  await db
    .prepare("INSERT OR IGNORE INTO salts (day, salt) VALUES (?, ?)")
    .bind(day, fresh)
    .run();
  const row = await db.prepare("SELECT salt FROM salts WHERE day = ?").bind(day).first();
  await db.prepare("DELETE FROM salts WHERE day < ?").bind(day).run();
  cachedSalt = { day, salt: row.salt };
  return row.salt;
}

async function visitorKey(salt, request) {
  const ip = request.headers.get("cf-connecting-ip") || "";
  const ua = request.headers.get("user-agent") || "";
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(salt + "|" + ip + "|" + ua)
  );
  return [...new Uint8Array(digest).slice(0, 8)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Crawlers and scripts, so a report can leave them out. A heuristic, not a
// wall: anything that lies about its user agent reads as a person.
function isBot(request) {
  const ua = request.headers.get("user-agent") || "";
  return !ua || /bot|crawl|spider|slurp|curl|wget|python|httpx|go-http|java\/|okhttp|headless|scan|preview/i.test(ua);
}

async function recordVisit(db, request, url, row, status) {
  const now = new Date();
  const day = row[0];
  const t = Math.floor((now.getTime() - Date.parse(day + "T00:00:00Z")) / 1000);
  const salt = await daySalt(db, day);
  const visitor = await visitorKey(salt, request);
  await db
    .prepare(
      "INSERT INTO visits (day, t, visitor, path, ref_host, ref_url, country, device, bot, status) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .bind(day, t, visitor, url.pathname, row[1], row[2], row[4], row[5], isBot(request) ? 1 : 0, status)
    .run();
}

// Count page views only. Assets inflate every figure and say nothing about
// where a visitor came from: one visit to / pulls several images and an mp4.
function isPageView(url, request) {
  if (request.method !== "GET") return false;
  if (!(request.headers.get("accept") || "").includes("text/html")) return false;
  const path = url.pathname;
  if (path.startsWith("/cdn-cgi/")) return false;
  return path.endsWith("/") || path.endsWith(".html") || !path.includes(".");
}

// The host answers "which site sent them"; the trimmed URL answers "which PAGE
// of it" - the difference between knowing a blog linked us and knowing which
// article did. Query strings are dropped: they carry campaign junk and
// occasionally personal data, and are never needed here.
function referrer(request, selfHost) {
  const ref = request.headers.get("referer");
  if (!ref) return { host: "direct", url: "" };
  let u;
  try {
    u = new URL(ref);
  } catch {
    return { host: "unparsed", url: "" };
  }
  const host = u.hostname.toLowerCase();
  if (host === selfHost || host.endsWith("." + selfHost)) {
    return { host: "internal", url: "" };
  }
  return { host, url: u.origin + u.pathname };
}

// Coarse enough to answer "does the audience arrive on a phone?" and far too
// coarse to identify anyone.
function device(request) {
  const ua = request.headers.get("user-agent") || "";
  if (/\bTablet\b|\biPad\b/i.test(ua)) return "tablet";
  if (/\bMobi|\bAndroid\b.*\bMobile\b|\biPhone\b/i.test(ua)) return "mobile";
  if (!ua) return "unknown";
  return "desktop";
}

export async function onRequest(context) {
  const { request, env, next, waitUntil } = context;
  const url = new URL(request.url);
  const response = await next();

  if (env.DB && isPageView(url, request)) {
    const ref = referrer(request, "wetvst.com");
    const row = [
      new Date().toISOString().slice(0, 10), // UTC day
      ref.host,
      ref.url,
      url.pathname,
      request.cf?.country || "XX", // resolved at the edge
      device(request),
    ];
    // Serving must never wait on, or fail because of, the bookkeeping.
    waitUntil(
      env.DB.prepare(
        "INSERT INTO hits (day, ref_host, ref_url, path, country, device, count) " +
          "VALUES (?, ?, ?, ?, ?, ?, 1) " +
          "ON CONFLICT(day, ref_host, ref_url, path, country, device) " +
          "DO UPDATE SET count = count + 1"
      )
        .bind(...row)
        .run()
        .catch(() => {})
    );
    waitUntil(recordVisit(env.DB, request, url, row, response.status).catch(() => {}));
  }

  return response;
}
