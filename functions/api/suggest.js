/**
 * POST /api/suggest - "What should we build next?" from the front page.
 *
 * Stores the text only, with the day and the visitor's country, in the same D1
 * database as the page counts. No email field, no name, no IP: the form asks
 * for nothing personal, so nothing personal is kept. Read the replies with
 * SELECT * FROM suggestions ORDER BY id DESC.
 */

const MAX = 1000;

export async function onRequestPost({ request, env }) {
  const form = await request.formData().catch(() => null);
  const text = String((form && form.get("idea")) || "").trim().slice(0, MAX);
  // A filled honeypot is a bot; answer as if it worked.
  const bot = form && String(form.get("website") || "") !== "";

  if (text && !bot && env.DB) {
    await env.DB.prepare(
      "INSERT INTO suggestions (day, country, text) VALUES (?, ?, ?)"
    )
      .bind(new Date().toISOString().slice(0, 10), request.cf?.country || "XX", text)
      .run()
      .catch(() => {});
  }

  // The page sends this with fetch and shows its own thank-you; without
  // script, the browser lands back on the section.
  if ((request.headers.get("accept") || "").includes("application/json")) {
    return Response.json({ ok: true });
  }
  return Response.redirect(new URL("/?thanks=1#next", request.url).toString(), 303);
}
