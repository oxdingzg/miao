// dl.mtty.dev — a GitHub-shaped release mirror for miao.
//
// Operators on networks that cannot reach github.com still install and
// upgrade through the published `install` script and `miao upgrade`; both
// speak GitHub release paths, so this worker mirrors the repository's
// release surface instead of inventing a second URL scheme. Only two path
// families are proxied — everything else is refused, keeping the worker
// from becoming a general github.com proxy:
//
//   /releases/latest            resolves the tag here and redirects to the
//                               mirror's own tag path, so `curl -I` Location
//                               parsing and `curl -w %{url_effective}` both
//                               end on a mirror URL
//   /releases/download/v<ver>/<asset>
//                               streams the asset from GitHub; redirects to
//                               the signed object store are followed here so
//                               the client never touches a GitHub host
//   /releases/tag/v<ver>        the release page (small, used by the
//                               updater's redirect follow)
//   /raw/main/install{,.ps1}    the install scripts, served straight from
//                               raw.githubusercontent.com
//
// Deploy from this directory with a Cloudflare account that owns the
// mtty.dev zone: `wrangler deploy` binds dl.mtty.dev as a custom domain.
export default {
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    const origin = `${url.protocol}//${url.host}`;

    if (path === "/releases/latest") {
      const upstream = await fetch("https://github.com/oxdingzg/miao/releases/latest", {
        redirect: "manual",
      });
      const location = upstream.headers.get("location");
      if (!location) {
        return new Response("mirror: upstream did not redirect", { status: 502 });
      }
      const tag = location.split("/").pop();
      return Response.redirect(`${origin}/releases/tag/${tag}`, 302);
    }

    let upstream;
    if (path.startsWith("/releases/")) {
      upstream = `https://github.com/oxdingzg/miao${path}`;
    } else if (path === "/raw/main/install" || path === "/raw/main/install.ps1") {
      upstream = `https://raw.githubusercontent.com/oxdingzg/miao/main${path.slice("/raw/main".length)}`;
    } else {
      return new Response("not found", { status: 404 });
    }

    const response = await fetch(upstream, {
      redirect: "follow",
      headers: filtered(request.headers),
    });
    const headers = new Headers(response.headers);
    headers.set("x-mirror-upstream", new URL(response.url).host);
    return new Response(response.body, {
      status: response.status,
      headers,
    });
  },
};

// GitHub answers a browser-ish Accept the same as a bare one; drop the
// forwarding hop count so the origin sees this worker as the client.
function filtered(headers) {
  const clean = new Headers();
  for (const name of ["accept", "user-agent", "range", "if-none-match", "if-modified-since"]) {
    const value = headers.get(name);
    if (value) clean.set(name, value);
  }
  return clean;
}
