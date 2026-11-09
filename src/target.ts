export function buildTargetUrl(base: string, restPath: string, clientSearch: string): URL | null {
  const baseUrl = new URL(base);
  const basePath = baseUrl.pathname.replace(/\/+$/, "");

  const rest = restPath.replace(/^\/+/, "");

  if (rest) {
    if (/%2e|%2f|%5c|\\|[\u0000-\u001f]/i.test(rest)) return null;
    if (rest.split("/").some((segment) => segment === "." || segment === "..")) return null;
  }

  const target = new URL(baseUrl.toString());
  if (rest) {
    target.pathname = `${basePath}/${rest}`;
  }

  const merged = new URLSearchParams(clientSearch);
  for (const key of new Set(baseUrl.searchParams.keys())) {
    merged.delete(key);
    for (const value of baseUrl.searchParams.getAll(key)) merged.append(key, value);
  }
  target.search = merged.toString();

  if (target.origin !== baseUrl.origin) return null;
  if (basePath && target.pathname !== basePath && !target.pathname.startsWith(basePath + "/")) return null;
  return target;
}
