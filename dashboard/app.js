const API_BASE = window.ROUTEWAY_API_BASE;

const state = {
  csrf: null,
  user: null,
  projects: [],
  selectedProjectId: null,
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

  let response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers,
      credentials: "include",
    });
  } catch {
    showBanner("Could not reach the server. Check your connection and try again.");
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
      await enterApp();
    } catch {
      /* banner already shown by api() */
    }
  });
}

async function handleLogout() {
  try {
    await api("/api/logout", { method: "POST" });
  } catch {
    /* ignore */
  }
  state.csrf = null;
  state.user = null;
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
    item.textContent = project.name;
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
    node.querySelector(".route-inject").textContent = `${route.inject_as}: ${route.inject_key}`;
    node.querySelector(".route-rate").textContent = `${route.rate_limit_per_minute}/min`;

    const pauseButton = node.querySelector(".toggle-pause");
    pauseButton.textContent = route.paused ? "Resume" : "Pause";
    pauseButton.addEventListener("click", () => togglePause(route, pauseButton));

    node.querySelector(".show-tokens").addEventListener("click", (event) =>
      toggleTokenSublist(route.id, event.currentTarget.closest(".route-row"))
    );

    list.appendChild(node);
  }
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

  for (const token of tokens) {
    const node = el("tokenRowTemplate").content.cloneNode(true);
    node.querySelector(".token-status").textContent = token.revoked ? "revoked" : "active";
    node.querySelector(".token-created").textContent = new Date(token.created_at).toLocaleString();
    const revokeButton = node.querySelector(".revoke-token");
    if (token.revoked) {
      revokeButton.disabled = true;
      revokeButton.textContent = "Revoked";
    } else {
      revokeButton.addEventListener("click", () =>
        withLoading(revokeButton, "Revoking...", () => revokeToken(routeId, token.id, sublist))
      );
    }
    sublist.appendChild(node);
  }

  const addButton = document.createElement("button");
  addButton.type = "button";
  addButton.className = "button button-small";
  addButton.textContent = "Issue new token";
  addButton.addEventListener("click", () => withLoading(addButton, "Issuing...", () => issueToken(routeId, sublist)));
  sublist.appendChild(addButton);
}

async function issueToken(routeId, sublist) {
  const data = await api(`/api/routes/${routeId}/tokens`, { method: "POST" });
  const existing = state.tokensByRoute[routeId] || [];
  state.tokensByRoute[routeId] = [{ id: data.tokenId, revoked: 0, created_at: Date.now() }, ...existing];
  renderTokenSublist(routeId, sublist);
  showTokenReveal(data.token);
}

async function revokeToken(routeId, tokenId, sublist) {
  await api(`/api/tokens/${tokenId}/revoke`, { method: "POST" });
  const data = await api(`/api/routes/${routeId}/tokens`);
  state.tokensByRoute[routeId] = data.tokens;
  renderTokenSublist(routeId, sublist);
}

function showTokenReveal(token) {
  el("tokenRevealValue").textContent = token;
  el("tokenReveal").hidden = false;
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
    } catch {
      /* banner already shown by api() */
    }
  });
}

async function handleNewRouteSubmit(event) {
  event.preventDefault();
  const button = event.target.querySelector('button[type="submit"]');
  const body = {
    label: el("routeLabel").value.trim(),
    targetUrl: el("routeTargetUrl").value.trim(),
    injectAs: el("routeInjectAs").value,
    injectKey: el("routeInjectKey").value.trim(),
    secret: el("routeSecret").value,
    allowedOrigin: el("routeAllowedOrigin").value.trim() || undefined,
    rateLimitPerMinute: Number(el("routeRateLimit").value),
  };

  await withLoading(button, "Creating...", async () => {
    try {
      const data = await api(`/api/projects/${state.selectedProjectId}/routes`, {
        method: "POST",
        body: JSON.stringify(body),
      });

      el("newRouteForm").hidden = true;
      el("newRouteForm").reset();
      await loadRoutes();
      showTokenReveal(data.token);
    } catch {
      /* banner already shown by api() */
    }
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

  el("newRouteButton").addEventListener("click", () => {
    el("tokenReveal").hidden = true;
    el("newRouteForm").hidden = false;
  });
  el("cancelNewRoute").addEventListener("click", () => {
    el("newRouteForm").hidden = true;
  });
  el("newRouteForm").addEventListener("submit", handleNewRouteSubmit);

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
    el("authView").hidden = false;
  }
}

init();
