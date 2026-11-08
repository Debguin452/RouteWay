/**
 * Builds the upstream URL for a proxied request.
 *
 * A route's target URL is a BASE. A caller may append a sub-path and query string:
 *   route target   https://api.openai.com/v1
 *   request        /proxy/<token>/chat/completions?x=1
 *   upstream call  https://api.openai.com/v1/chat/completions?x=1
 *
 * The result is always on the same origin as the base and under the base's path prefix, so a
 * token still cannot be pointed anywhere else. Returns null if the sub-path is not acceptable.
 */
export function buildTargetUrl(base: string, restPath: string, clientSearch: string): URL | null {
  const baseUrl = new URL(base);
  const basePath = baseUrl.pathname.replace(/\/+$/, "");

  // Strip the leading slash(es) from what follows /proxy/<token>.
  const rest = restPath.replace(/^\/+/, "");

  // Reject anything that could be used to climb out of the base path or smuggle a different
  // path past normalization: dot segments, backslashes, encoded dots/slashes/backslashes, control chars.
  if (rest) {
    if (/%2e|%2f|%5c|\\|[\u0000-\u001f]/i.test(rest)) return null;
    if (rest.split("/").some((segment) => segment === "." || segment === "..")) return null;
  }

  const target = new URL(baseUrl.toString());
  if (rest) {
    // Setting .pathname can never change the host, unlike resolving a relative URL.
    target.pathname = `${basePath}/${rest}`;
  }

  // Query: keep whatever the caller sent, but the route's own query parameters always win.
  const merged = new URLSearchParams(clientSearch);
  for (const key of new Set(baseUrl.searchParams.keys())) {
    merged.delete(key);
    for (const value of baseUrl.searchParams.getAll(key)) merged.append(key, value);
  }
  target.search = merged.toString();

  // Final guard after URL normalization.
  if (target.origin !== baseUrl.origin) return null;
  if (basePath && target.pathname !== basePath && !target.pathname.startsWith(basePath + "/")) return null;
  return target;
}
