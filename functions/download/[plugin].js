/**
 * /download/<plugin> - serves the current release zip from wetvst.com.
 *
 * The free plug-ins are released on GitHub, and the file stays there: GitHub's
 * per-asset download counter is the only download history there is. So the zip
 * is streamed THROUGH this function rather than copied here - the visitor sees
 * wetvst.com, and every download still reaches GitHub and still counts. The
 * body is passed through untouched, which costs no CPU time. The asset name
 * carries the version, so "latest" is looked up rather than hard-coded, and
 * that lookup (not the zip) is cached at the edge for an hour.
 *
 * The premium plug-ins are not on GitHub; their zips are served from files.wetvst.com.
 */

const GITHUB = {
  wetdelay: "WetDelay",
  wetreverb: "WetReverb",
  weteq: "WetEQ",
  wetcompressor: "WetCompressor",
  wetchorus: "WetChorus",
};

// Premium plug-ins: the current zip of each, updated by hand at each release together
// with the upload to files.wetvst.com. This line is the only thing that changes.
const PREMIUM = {
  wetweld: "https://files.wetvst.com/WetWeld-1.0.0.zip",
};

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
  return (release.assets || []).find((a) => a.name.endsWith(".zip")) || null;
}

export async function onRequestGet({ params, waitUntil }) {
  const plugin = String(params.plugin || "").toLowerCase();
  if (PREMIUM[plugin]) return Response.redirect(PREMIUM[plugin], 302);

  const repo = GITHUB[plugin];
  if (!repo) return new Response("Not found", { status: 404 });

  const zip = await latestZip(repo, waitUntil);
  // No public release yet (or GitHub unreachable): the release page still works.
  if (!zip) return Response.redirect(`https://github.com/yonie/${repo}/releases`, 302);

  const file = await fetch(zip.browser_download_url, { headers: { "User-Agent": "wetvst.com" } });
  if (!file.ok) return Response.redirect(zip.browser_download_url, 302);
  return new Response(file.body, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${zip.name}"`,
      ...(file.headers.get("content-length") && { "Content-Length": file.headers.get("content-length") }),
      "Cache-Control": "no-store",
    },
  });
}
