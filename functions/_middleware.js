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
 * Deliberately not an analytics beacon: no script is added to the page, and no
 * cookie, identifier, IP address or full user agent is stored. Rows are
 * counters over (day, referrer, page, country, device), so no visitor is
 * identifiable from the table.
 *
 * The consequence of holding no identifier, and it is the right trade: this
 * counts HITS, not PEOPLE. Unique visitors need a cookie or a fingerprint.
 * GitHub's figures carry uniques because GitHub sets its own - never compare
 * the two series as though they measured the same thing.
 */

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
  }

  return response;
}
