const API_BASE = window.ROUTEWAY_API_BASE;

const TOKEN_KEY = "routeway_session";
function loadToken() {
  try { return sessionStorage.getItem(TOKEN_KEY); } catch { return null; }
}
function saveToken(token) {
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {}
}

const state = {
  sessionToken: loadToken(),
  csrf: null,
  user: null,
  projects: [],
  selectedProjectId: null,
  editingRouteId: null,
  routes: [],
  tokensByRoute: {},
};

const el = (id) => document.getElementById(id);
const banner = el("banner");

function showBanner(message) {
  banner.textContent = `${message} (tap to dismiss)`;
  banner.hidden = false;
  clearTimeout(showBanner.timer);
  showBanner.timer = setTimeout(() => {
    banner.hidden = true;
  }, 6000);
}

banner.addEventListener("click", () => {
  banner.hidden = true;
  clearTimeout(showBanner.timer);
});

async function withLoading(button, label, fn) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = label;
  try {
    await fn();
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

async function api(path, options = {}) {
  const headers = { "content-type": "application/json", ...(options.headers || {}) };
  if (state.csrf && options.method && options.method !== "GET") {
    headers["x-csrf-token"] = state.csrf;
  }
  if (state.sessionToken) {
    headers["authorization"] = `Bearer ${state.sessionToken}`;
  }

  let response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers,
      credentials: "include",
    });
  } catch {
    showBanner(`Could not reach the server, or the browser blocked its response. Open ${API_BASE}/api/debug to see which part is failing.`);
    throw new Error("network_error");
  }

  let data = null;
  const text = await response.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }

  if (!response.ok) {
    const message = data?.error?.message || `Request failed with status ${response.status}.`;
    if (response.status !== 401) showBanner(message);
    const error = new Error(message);
    error.code = data?.error?.code;
    error.status = response.status;
    throw error;
  }

  return data;
}

function switchAuthTab(tab) {
  const isLogin = tab === "login";
  el("tabLogin").classList.toggle("is-active", isLogin);
  el("tabSignup").classList.toggle("is-active", !isLogin);
  el("authSubmit").textContent = isLogin ? "Sign in" : "Create account";
  el("authForm").dataset.mode = tab;
  el("authPassword").autocomplete = isLogin ? "current-password" : "new-password";
}

async function handleAuthSubmit(event) {
  event.preventDefault();
  const mode = el("authForm").dataset.mode || "login";
  const email = el("authEmail").value.trim();
  const password = el("authPassword").value;
  const path = mode === "login" ? "/api/login" : "/api/signup";

  await withLoading(el("authSubmit"), mode === "login" ? "Signing in..." : "Creating account...", async () => {
    try {
      const data = await api(path, { method: "POST", body: JSON.stringify({ email, password }) });
      state.csrf = data.csrf;
      state.user = data.user;
      state.sessionToken = data.sessionToken || null;
      saveToken(state.sessionToken);
      await enterApp();
    } catch {}
  });
}

async function handleLogout() {
  try {
    await api("/api/logout", { method: "POST" });
  } catch {
  }
  state.csrf = null;
  state.user = null;
  state.sessionToken = null;
  saveToken(null);
  el("appView").hidden = true;
  el("accountBox").hidden = true;
  el("authView").hidden = false;
}

async function enterApp() {
  el("authView").hidden = true;
  el("appView").hidden = false;
  el("accountBox").hidden = false;
  el("accountEmail").textContent = state.user.email;
  await loadProjects();
}

async function loadProjects() {
  const data = await api("/api/projects");
  state.projects = data.projects;
  renderProjectList();
  if (state.projects.length === 0) {
    el("emptyProjects").hidden = false;
    el("projectDetail").hidden = true;
  } else if (!state.selectedProjectId) {
    selectProject(state.projects[0].id);
  }
}

function renderProjectList() {
  const list = el("projectList");
  list.innerHTML = "";
  for (const project of state.projects) {
    const item = document.createElement("li");
    item.textContent = project.paused ? `${project.name} (paused)` : project.name;
    item.classList.toggle("is-selected", project.id === state.selectedProjectId);
    item.addEventListener("click", () => selectProject(project.id));
    list.appendChild(item);
  }
}

async function selectProject(projectId) {
  state.selectedProjectId = projectId;
  renderProjectList();
  el("emptyProjects").hidden = true;
  el("projectDetail").hidden = false;
  const project = state.projects.find((p) => p.id === projectId);
  el("projectName").textContent = project ? project.name : "";
  el("pauseProjectButton").textContent = project && project.paused ? "Resume" : "Pause";
  el("projectStatus").hidden = !(project && project.paused);
  el("tokenReveal").hidden = true;
  el("newRouteForm").hidden = true;
  await loadRoutes();
}

async function loadRoutes() {
  const data = await api(`/api/projects/${state.selectedProjectId}/routes`);
  state.routes = data.routes;
  renderRouteList();
}

function renderRouteList() {
  const list = el("routeList");
  list.innerHTML = "";
  el("emptyRoutes").hidden = state.routes.length > 0;

  for (const route of state.routes) {
    const node = el("routeRowTemplate").content.cloneNode(true);
    const row = node.querySelector(".route-row");
    row.dataset.routeId = route.id;

    node.querySelector(".status-dot").classList.toggle("is-paused", Boolean(route.paused));
    node.querySelector(".route-label").textContent = route.label;
    const urlEl = node.querySelector(".route-url");
    urlEl.textContent = route.target_url;
    urlEl.title = route.target_url;
    node.querySelector(".route-badge").hidden = !route.paused;
    const chipList = node.querySelector(".route-chips");
    for (const chip of routeChips(route)) {
      const item = document.createElement("li");
      item.className = chip.secure ? "chip chip-secure" : "chip";
      item.textContent = chip.text;
      chipList.appendChild(item);
    }
    node.querySelector(".route-usage").textContent = describeUsage(route.stats);
    node.querySelector(".edit-route").addEventListener("click", () => startEditRoute(route));
    const deleteButton = node.querySelector(".delete-route");
    deleteButton.addEventListener("click", () => deleteRouteAction(route, deleteButton));

    const pauseButton = node.querySelector(".toggle-pause");
    pauseButton.textContent = route.paused ? "Resume" : "Pause";
    pauseButton.addEventListener("click", () => togglePause(route, pauseButton));

    node.querySelector(".show-tokens").addEventListener("click", (event) =>
      toggleTokenSublist(route.id, event.currentTarget.closest(".route-row"))
    );
    node.querySelector(".show-activity").addEventListener("click", (event) =>
      toggleActivity(route.id, event.currentTarget.closest(".route-row"))
    );

    list.appendChild(node);
  }
}

async function deleteRouteAction(route, button) {
  if (!confirm(`Delete route "${route.label}" and all its tokens? Anything using those tokens will stop working.`)) return;
  await withLoading(button, "Deleting...", async () => {
    try {
      await api(`/api/routes/${route.id}`, { method: "DELETE" });
      await loadRoutes();
    } catch {}
  });
}

async function renameProject() {
  const project = state.projects.find((p) => p.id === state.selectedProjectId);
  const name = prompt("New project name", project ? project.name : "");
  if (!name || !name.trim()) return;
  try {
    await api(`/api/projects/${state.selectedProjectId}`, { method: "PATCH", body: JSON.stringify({ name: name.trim() }) });
    await loadProjects();
    selectProject(state.selectedProjectId);
  } catch {}
}

async function toggleProjectPause() {
  const project = state.projects.find((p) => p.id === state.selectedProjectId);
  if (!project) return;
  try {
    await api(`/api/projects/${project.id}`, { method: "PATCH", body: JSON.stringify({ paused: !project.paused }) });
    await loadProjects();
    selectProject(project.id);
  } catch {}
}

async function deleteProjectAction() {
  const project = state.projects.find((p) => p.id === state.selectedProjectId);
  if (!project) return;
  if (!confirm(`Delete project "${project.name}" with all its routes and tokens? This cannot be undone.`)) return;
  try {
    await api(`/api/projects/${project.id}`, { method: "DELETE" });
    state.selectedProjectId = null;
    await loadProjects();
  } catch {}
}

async function togglePause(route, button) {
  await withLoading(button, "...", async () => {
    await api(`/api/routes/${route.id}/pause`, {
      method: "POST",
      body: JSON.stringify({ paused: !route.paused }),
    });
    await loadRoutes();
  });
}

function describeStatus(status) {
  if (status >= 500) return "err";
  if (status >= 400) return "warn";
  return "ok";
}

async function toggleActivity(routeId, rowEl) {
  const panel = rowEl.querySelector(".activity-panel");
  if (!panel.hidden) {
    panel.hidden = true;
    return;
  }
  panel.innerHTML = "";
  let entries = [];
  try {
    entries = (await api(`/api/routes/${routeId}/activity`)).entries || [];
  } catch {
    return;
  }
  const list = document.createElement("ul");
  list.className = "activity-list";
  if (!entries.length) {
    const empty = document.createElement("li");
    empty.className = "panel-empty";
    empty.textContent = "No requests recorded yet.";
    list.appendChild(empty);
  }
  for (const entry of entries) {
    const item = document.createElement("li");
    item.className = "activity-row";
    const status = document.createElement("span");
    status.className = `badge status-${describeStatus(entry.status)}`;
    status.textContent = entry.status;
    const main = document.createElement("span");
    main.className = "activity-main";
    main.textContent = `${entry.method} ${entry.path || "/"}`;
    const meta = document.createElement("span");
    meta.className = "activity-meta";
    const parts = [new Date(entry.at).toLocaleTimeString(), `${entry.ms} ms`];
    if (entry.country) parts.push(entry.country);
    if (entry.note) parts.push(entry.note);
    meta.textContent = parts.join(" · ");
    item.append(status, main, meta);
    list.appendChild(item);
  }
  panel.appendChild(list);
  panel.hidden = false;
}

async function toggleTokenSublist(routeId, rowEl) {
  const sublist = rowEl.querySelector(".token-sublist");
  if (!sublist.hidden) {
    sublist.hidden = true;
    return;
  }
  const data = await api(`/api/routes/${routeId}/tokens`);
  state.tokensByRoute[routeId] = data.tokens;
  renderTokenSublist(routeId, sublist);
  sublist.hidden = false;
}

function renderTokenSublist(routeId, sublist) {
  sublist.innerHTML = "";
  const tokens = state.tokensByRoute[routeId] || [];

  const list = document.createElement("ul");
  list.className = "token-list";
  for (const token of tokens) {
    const node = el("tokenRowTemplate").content.cloneNode(true);
    const status = node.querySelector(".token-status");
    const expired = token.expires_at && token.expires_at < Date.now();
    status.textContent = token.revoked ? "revoked" : expired ? "expired" : "active";
    status.classList.add(token.revoked || expired ? "badge-off" : "badge-on");
    const expiry = token.expires_at ? `expires ${new Date(token.expires_at).toLocaleDateString()}` : "no expiry";
    node.querySelector(".token-label").textContent = token.label || "Unnamed token";
    node.querySelector(".token-created").textContent = `Created ${new Date(token.created_at).toLocaleDateString()} · ${expiry}`;
    const revokeButton = node.querySelector(".revoke-token");
    if (token.revoked) {
      revokeButton.hidden = true;
    } else {
      revokeButton.addEventListener("click", () =>
        withLoading(revokeButton, "Revoking...", () => revokeToken(routeId, token.id, sublist))
      );
    }
    list.appendChild(node);
  }
  if (!tokens.length) {
    const empty = document.createElement("li");
    empty.className = "panel-empty";
    empty.textContent = "No tokens yet.";
    list.appendChild(empty);
  }
  sublist.appendChild(list);

  const issue = document.createElement("div");
  issue.className = "token-issue";

  const labelInput = document.createElement("input");
  labelInput.type = "text";
  labelInput.maxLength = 40;
  labelInput.placeholder = "Label, for example production web";
  labelInput.className = "control token-issue-label";
  issue.appendChild(labelInput);

  const expirySelect = document.createElement("select");
  expirySelect.className = "control";
  for (const [value, label] of [["", "Never expires"], ["1", "Expires in 1 day"], ["7", "Expires in 7 days"], ["30", "Expires in 30 days"], ["90", "Expires in 90 days"]]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    expirySelect.appendChild(option);
  }
  issue.appendChild(expirySelect);

  const addButton = document.createElement("button");
  addButton.type = "button";
  addButton.className = "button button-small button-primary";
  addButton.textContent = "Issue token";
  addButton.addEventListener("click", () =>
    withLoading(addButton, "Issuing...", () => issueToken(routeId, sublist, expirySelect.value, labelInput.value.trim()))
  );
  issue.appendChild(addButton);
  sublist.appendChild(issue);
}

async function issueToken(routeId, sublist, expiresInDays, label) {
  const body = {};
  if (expiresInDays) body.expiresInDays = Number(expiresInDays);
  if (label) body.label = label;
  const data = await api(`/api/routes/${routeId}/tokens`, { method: "POST", body: JSON.stringify(body) });
  const existing = state.tokensByRoute[routeId] || [];
  state.tokensByRoute[routeId] = [{ id: data.tokenId, revoked: 0, created_at: Date.now(), expires_at: data.expiresAt, label: data.label }, ...existing];
  renderTokenSublist(routeId, sublist);
  showTokenReveal(data.token, state.routes.find((r) => r.id === routeId) && { targetUrl: state.routes.find((r) => r.id === routeId).target_url });
}

async function revokeToken(routeId, tokenId, sublist) {
  await api(`/api/tokens/${tokenId}/revoke`, { method: "POST" });
  const data = await api(`/api/routes/${routeId}/tokens`);
  state.tokensByRoute[routeId] = data.tokens;
  renderTokenSublist(routeId, sublist);
}

function showTokenReveal(token, route) {
  el("tokenRevealValue").textContent = token;
  const base = `${API_BASE}/proxy/${token}`;
  let path = "/";
  let method = "GET";
  let body = "";
  if (route && route.targetUrl && /openai|anthropic/.test(route.targetUrl)) {
    path = route.targetUrl.includes("anthropic") ? "/messages" : "/chat/completions";
    method = "POST";
    body = `,\n  headers: { "Content-Type": "application/json" },\n  body: JSON.stringify({ /* request body */ })`;
  }
  el("tokenSnippet").textContent =
    `const res = await fetch("${base}${path}", {\n  method: "${method}"${body}\n});\nconst data = await res.json();`;
  el("tokenReveal").hidden = false;
}

const PRESETS = {
  openai: { label: "openai", url: "https://api.openai.com/v1", injectAs: "header", key: "Authorization", secretHint: "Bearer sk-...", timeout: 60 },
  anthropic: { label: "anthropic", url: "https://api.anthropic.com/v1", injectAs: "header", key: "x-api-key", secretHint: "sk-ant-...", timeout: 60 },
  gemini: { label: "gemini", url: "https://generativelanguage.googleapis.com", injectAs: "query", key: "key", secretHint: "Your Gemini API key" },
  openweather: { label: "openweather", url: "https://api.openweathermap.org", injectAs: "query", key: "appid", secretHint: "Your OpenWeather API key" },
};

function applyPreset() {
  const preset = PRESETS[el("routePreset").value];
  if (!preset) return;
  el("routeLabel").value = preset.label;
  el("routeTargetUrl").value = preset.url;
  el("routeInjectAs").value = preset.injectAs;
  el("routeInjectKey").value = preset.key;
  el("routeSecret").placeholder = preset.secretHint;
  el("routeTimeout").value = preset.timeout || 30;
}

function headersToLines(stored) {
  if (!stored) return "";
  try {
    return Object.entries(JSON.parse(stored)).map(([name, value]) => `${name}: ${value}`).join("\n");
  } catch {
    return "";
  }
}

function countItems(value) {
  return value ? value.split(",").filter(Boolean).length : 0;
}

function routeChips(route) {
  const chips = [
    { text: `${route.inject_as === "header" ? "Header" : "Query"} · ${route.inject_key}` },
    { text: `${route.rate_limit_per_minute}/min` },
  ];
  if (route.client_rate_limit_per_minute) chips.push({ text: `${route.client_rate_limit_per_minute}/min per caller`, secure: true });
  chips.push({ text: `${route.timeout_seconds}s timeout` });
  if (route.retries) chips.push({ text: `${route.retries} ${route.retries === 1 ? "retry" : "retries"}` });
  if (route.allowed_methods) chips.push({ text: route.allowed_methods.split(",").join(" "), secure: true });
  const paths = countItems(route.allowed_paths);
  if (paths) chips.push({ text: `${paths} path ${paths === 1 ? "rule" : "rules"}`, secure: true });
  const origins = countItems(route.allowed_origin);
  if (origins) chips.push({ text: `${origins} ${origins === 1 ? "origin" : "origins"}`, secure: true });
  if (route.allowed_ips) chips.push({ text: "IP allowlist", secure: true });
  if (route.require_human) chips.push({ text: "Human check", secure: true });
  const headers = route.extra_headers ? Object.keys(JSON.parse(route.extra_headers)).length : 0;
  if (headers) chips.push({ text: `${headers} upstream ${headers === 1 ? "header" : "headers"}` });
  return chips;
}

function describeUsage(stats) {
  if (!stats) return "";
  if (!stats.total) return "no requests yet";
  return `${stats.total.toLocaleString()} requests · last ${new Date(stats.lastUsedAt).toLocaleString()}`;
}

const LOCKED_ROUTE_FIELDS = ["routePreset", "routeLabel", "routeTargetUrl", "routeInjectAs", "routeInjectKey"];

function resetRouteForm() {
  state.editingRouteId = null;
  el("newRouteForm").reset();
  for (const id of LOCKED_ROUTE_FIELDS) el(id).disabled = false;
  el("routeSecret").required = true;
  el("routeSecret").placeholder = "Bearer sk-...";
  el("routeSubmit").textContent = "Create route";
  document.querySelectorAll("#newRouteForm .form-section").forEach((section, index) => {
    section.open = index === 0;
  });
}

function startEditRoute(route) {
  resetRouteForm();
  state.editingRouteId = route.id;
  el("routeLabel").value = route.label;
  el("routeTargetUrl").value = route.target_url;
  el("routeInjectAs").value = route.inject_as;
  el("routeInjectKey").value = route.inject_key;
  el("routeAllowedOrigin").value = route.allowed_origin || "";
  el("routeAllowedMethods").value = route.allowed_methods || "";
  el("routeAllowedPaths").value = route.allowed_paths || "";
  el("routeAllowedIps").value = route.allowed_ips || "";
  el("routeExtraHeaders").value = headersToLines(route.extra_headers);
  el("routeClientRate").value = route.client_rate_limit_per_minute || 0;
  el("routeRequireHuman").checked = Boolean(route.require_human);
  for (const section of document.querySelectorAll("#newRouteForm .form-section")) section.open = true;
  el("routeRateLimit").value = route.rate_limit_per_minute;
  el("routeTimeout").value = route.timeout_seconds;
  el("routeRetries").value = String(route.retries);
  for (const id of LOCKED_ROUTE_FIELDS) el(id).disabled = true;
  el("routeSecret").required = false;
  el("routeSecret").placeholder = "Leave blank to keep the current secret";
  el("routeSubmit").textContent = "Save changes";
  el("tokenReveal").hidden = true;
  el("newRouteForm").hidden = false;
  el("newRouteForm").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

async function handleNewProjectSubmit(event) {
  event.preventDefault();
  const button = event.target.querySelector('button[type="submit"]');
  const name = el("newProjectName").value.trim();
  await withLoading(button, "Creating...", async () => {
    try {
      const data = await api("/api/projects", { method: "POST", body: JSON.stringify({ name }) });
      el("newProjectForm").hidden = true;
      el("newProjectName").value = "";
      await loadProjects();
      selectProject(data.project.id);
    } catch {}
  });
}

async function handleNewRouteSubmit(event) {
  event.preventDefault();
  const button = event.target.querySelector('button[type="submit"]');
  const settings = {
    allowedOrigin: el("routeAllowedOrigin").value.trim(),
    allowedMethods: el("routeAllowedMethods").value.trim(),
    allowedPaths: el("routeAllowedPaths").value.trim(),
    allowedIps: el("routeAllowedIps").value.trim(),
    extraHeaders: el("routeExtraHeaders").value.trim(),
    clientRateLimitPerMinute: Number(el("routeClientRate").value),
    requireHuman: el("routeRequireHuman").checked,
    rateLimitPerMinute: Number(el("routeRateLimit").value),
    timeoutSeconds: Number(el("routeTimeout").value),
    retries: Number(el("routeRetries").value),
  };
  const secret = el("routeSecret").value;
  const editingId = state.editingRouteId;

  await withLoading(button, editingId ? "Saving..." : "Creating...", async () => {
    try {
      if (editingId) {
        await api(`/api/routes/${editingId}`, { method: "PATCH", body: JSON.stringify(settings) });
        if (secret) {
          await api(`/api/routes/${editingId}/secret`, { method: "POST", body: JSON.stringify({ secret }) });
        }
        el("newRouteForm").hidden = true;
        resetRouteForm();
        await loadRoutes();
        return;
      }

      const data = await api(`/api/projects/${state.selectedProjectId}/routes`, {
        method: "POST",
        body: JSON.stringify({
          label: el("routeLabel").value.trim(),
          targetUrl: el("routeTargetUrl").value.trim(),
          injectAs: el("routeInjectAs").value,
          injectKey: el("routeInjectKey").value.trim(),
          secret,
          ...settings,
        }),
      });
      el("newRouteForm").hidden = true;
      resetRouteForm();
      await loadRoutes();
      showTokenReveal(data.token, data.route);
    } catch {}
  });
}

function wireStaticEvents() {
  el("tabLogin").addEventListener("click", () => switchAuthTab("login"));
  el("tabSignup").addEventListener("click", () => switchAuthTab("signup"));
  el("authForm").addEventListener("submit", handleAuthSubmit);
  el("logoutButton").addEventListener("click", handleLogout);

  el("newProjectButton").addEventListener("click", () => {
    el("newProjectForm").hidden = false;
    el("newProjectName").focus();
  });
  el("cancelNewProject").addEventListener("click", () => {
    el("newProjectForm").hidden = true;
  });
  el("newProjectForm").addEventListener("submit", handleNewProjectSubmit);

  el("renameProjectButton").addEventListener("click", renameProject);
  el("pauseProjectButton").addEventListener("click", toggleProjectPause);
  el("deleteProjectButton").addEventListener("click", deleteProjectAction);
  el("newRouteButton").addEventListener("click", () => {
    resetRouteForm();
    el("tokenReveal").hidden = true;
    el("newRouteForm").hidden = false;
  });
  el("cancelNewRoute").addEventListener("click", () => {
    el("newRouteForm").hidden = true;
    resetRouteForm();
  });
  el("newRouteForm").addEventListener("submit", handleNewRouteSubmit);

  el("routePreset").addEventListener("change", applyPreset);
  el("copySnippetButton").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(el("tokenSnippet").textContent);
      el("copySnippetButton").textContent = "Copied";
    } catch {
      showBanner("Could not copy automatically. Select the example text and copy it manually.");
    }
    setTimeout(() => {
      el("copySnippetButton").textContent = "Copy example";
    }, 1500);
  });

  el("copyTokenButton").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(el("tokenRevealValue").textContent);
      el("copyTokenButton").textContent = "Copied";
    } catch {
      showBanner("Could not copy automatically. Select the token text and copy it manually.");
    }
    setTimeout(() => {
      el("copyTokenButton").textContent = "Copy";
    }, 1500);
  });
}

async function init() {
  wireStaticEvents();
  switchAuthTab("login");
  try {
    const data = await api("/api/me");
    state.csrf = data.csrf;
    state.user = data.user;
    await enterApp();
  } catch {
    state.sessionToken = null;
    saveToken(null);
    el("authView").hidden = false;
  }
}

init();
