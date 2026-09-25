/**
 * /download/<plugin> - sends the visitor straight to the current release zip.
 *
 * The free plug-ins are released on GitHub, and the zip stays there: GitHub's
 * per-asset download counter is the only download history there is. This
 * redirect only saves the visitor the trip through the release page. The asset
 * name carries the version, so "latest" is looked up rather than hard-coded,
 * and the answer is cached at the edge for an hour.
 *
 * WetWeld is not on GitHub; its zip is served from files.wetvst.com.
 */

const GITHUB = {
  wetdelay: "WetDelay",
  wetreverb: "WetReverb",
  weteq: "WetEQ",
  wetcompressor: "WetCompressor",
  wetchorus: "WetChorus",
};

// Bumped by hand at each WetWeld release, with the upload to files.wetvst.com.
const WETWELD_ZIP = "https://files.wetvst.com/WetWeld-1.0.0.zip";

async function latestZip(repo, waitUntil) {
  const api = `https://api.github.com/repos/yonie/${repo}/releases/latest`;
  const cache = caches.default;
  const key = new Request(api);
  let res = await cache.match(key);
  if (!res) {
    res = await fetch(api, {
      headers: { "User-Agent": "wetvst.com", Accept: "application/vnd.github+json" },
    });
    if (!res.ok) return null;
    res = new Response(res.body, res);
    res.headers.set("Cache-Control", "public, max-age=3600");
    waitUntil(cache.put(key, res.clone()));
  }
  const release = await res.json();
  const zip = (release.assets || []).find((a) => a.name.endsWith(".zip"));
  return zip ? zip.browser_download_url : null;
}

export async function onRequestGet({ params, waitUntil }) {
  const plugin = String(params.plugin || "").toLowerCase();
  if (plugin === "wetweld") return Response.redirect(WETWELD_ZIP, 302);

  const repo = GITHUB[plugin];
  if (!repo) return new Response("Not found", { status: 404 });

  const zip = await latestZip(repo, waitUntil);
  // No public release yet (or GitHub unreachable): the release page still works.
  return Response.redirect(zip || `https://github.com/yonie/${repo}/releases`, 302);
}
