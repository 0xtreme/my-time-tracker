import "./styles.css";

import type { AppState, Project, WorkSession, TimerMode, CopyMode, ProjectPanelView } from "./types";
import { authStyles, mountAuth, signOut } from "./cloud-auth";
import { cloudConfigured, ConflictError, createQueue, message } from "./cloud-sync";
import { fromRows, normalise, store, toRows, type TrackerRows } from "./cloud";

const STORAGE_KEY = "time-session-tracker:v1";
// With cloud configured, records live in Supabase; only the per-device heartbeat stays here.
const LAST_SEEN_KEY = "time-session-tracker:last-seen";
const HEARTBEAT_MS = 30_000;
const RUN_LIMIT_MS = 7 * 24 * 60 * 60 * 1000;
const PROJECT_COLORS = ["#2563eb", "#0f766e", "#9333ea", "#c2410c", "#be123c", "#4d7c0f"];

const appElement = document.querySelector<HTMLDivElement>("#app");

if (!appElement) {
  throw new Error("App root was not found.");
}

const app: HTMLDivElement = appElement;

let state = cloudConfigured ? createInitialState() : loadState();
let selectedProjectId = "all";
let projectPanelView: ProjectPanelView = "active";
let recoveryVisible = cloudConfigured ? false : shouldShowRecovery(state);
let notice = "";

type SyncState = "loading" | "saved" | "saving" | "error";
let synced: TrackerRows | null = null;
let syncState: SyncState = "loading";
let legacy: AppState | null = null;
let legacyUploaded = false;
const queue = createQueue();

if (cloudConfigured) {
  const style = document.createElement("style");
  style.textContent = authStyles;
  document.head.append(style);
  mountAuth(app, "Session Tracker").then(() => reloadCloud());
} else {
  render();
}

setInterval(() => {
  touchLastSeen();
  renderTimerValues();
}, HEARTBEAT_MS);

setInterval(renderTimerValues, 1000);

window.addEventListener("beforeunload", touchLastSeen);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    touchLastSeen();
  }
});

function loadState(): AppState {
  return parseStored(window.localStorage.getItem(STORAGE_KEY)) ?? createInitialState();
}

function parseStored(raw: string | null): AppState | null {
  const fallback = createInitialState();

  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as AppState;
    if (!Array.isArray(parsed.projects) || !Array.isArray(parsed.sessions)) {
      return null;
    }

    return {
      schemaVersion: 1,
      projects: parsed.projects.length ? parsed.projects : fallback.projects,
      sessions: parsed.sessions,
      settings: {
        timerMode: parsed.settings?.timerMode === "parallel" ? "parallel" : "exclusive",
        staleAfterMinutes: Number(parsed.settings?.staleAfterMinutes) || 15,
        theme: parsed.settings?.theme === "dark" ? "dark" : "light",
      },
      lastSeenAt: parsed.lastSeenAt || nowIso(),
    };
  } catch {
    return null;
  }
}

function createInitialState(): AppState {
  const createdAt = nowIso();

  return {
    schemaVersion: 1,
    projects: [
      { id: makeId("project"), name: "Project 1", createdAt, color: PROJECT_COLORS[0], archived: false },
      { id: makeId("project"), name: "Project 2", createdAt, color: PROJECT_COLORS[1], archived: false },
      { id: makeId("project"), name: "Project 3", createdAt, color: PROJECT_COLORS[2], archived: false },
    ],
    sessions: [],
    settings: {
      timerMode: "exclusive",
      staleAfterMinutes: 15,
      theme: "light",
    },
    lastSeenAt: createdAt,
  };
}

function saveState(options: { heartbeat?: boolean } = {}) {
  const nextState = {
    ...state,
    lastSeenAt: options.heartbeat === false ? state.lastSeenAt : nowIso(),
  };

  if (cloudConfigured && !synced) return; // signed out or loading: keep the last real heartbeat
  state = nextState;
  if (!cloudConfigured) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(nextState));
    return;
  }
  window.localStorage.setItem(LAST_SEEN_KEY, nextState.lastSeenAt);
  pushCloud();
}

// Saves the difference between the last confirmed cloud rows and the current state.
function pushCloud() {
  if (!synced) return;
  const target = toRows(state);
  queue.run(async () => {
    if (!synced) return;
    const { upserts, deletes } = store.diff(synced, target);
    if (!store.count(upserts) && !Object.values(deletes).some((ids) => ids.length)) return;
    setSync("saving");
    try {
      await store.push(synced, target);
      synced = target;
      setSync("saved");
    } catch (error) {
      if (error instanceof ConflictError) {
        await reloadCloud("Changed in another window or device. The latest cloud data is loaded; your last change was not saved.");
      } else {
        notice = `Not saved to the cloud: ${message(error)} Your changes are kept in this window and retried on the next change.`;
        setSync("error");
        render();
      }
    }
  });
}

async function reloadCloud(note = "") {
  queue.reset();
  synced = null;
  setSync("loading");
  try {
    const rows = await store.load();
    const lastSeenAt = window.localStorage.getItem(LAST_SEEN_KEY) || nowIso();
    synced = rows;
    if (!rows.projects.length && !rows.sessions.length) {
      // First run in the cloud: start with the default projects, as the local app does.
      state = { ...createInitialState(), lastSeenAt };
      pushCloud();
    } else {
      state = fromRows(rows, lastSeenAt);
    }
    legacy = parseStored(window.localStorage.getItem(STORAGE_KEY));
    recoveryVisible = shouldShowRecovery(state);
    notice = note;
    setSync("saved");
  } catch (error) {
    notice = `Could not load your cloud records: ${message(error)}`;
    setSync("error");
  }
  render();
}

// Records saved in this browser before cloud sync that the cloud does not have yet.
function legacyMissing() {
  if (!legacy || !synced) return null;
  const missing = store.missing(normalise(legacy));
  return { projects: missing.projects.length, sessions: missing.sessions.length, total: missing.projects.length + missing.sessions.length };
}

async function uploadLegacy() {
  if (!legacy) return;
  const local = normalise(legacy);
  queue.run(async () => {
    setSync("saving");
    try {
      await store.merge(local);
      await reloadCloud();
      legacyUploaded = legacyMissing()?.total === 0;
      notice = legacyUploaded ? "Browser records uploaded and verified in the cloud." : "Upload finished, but some browser records are still missing from the cloud. The browser copy has been kept.";
    } catch (error) {
      notice = `Upload failed: ${message(error)} The browser copy has been kept.`;
      setSync("error");
    }
    render();
  });
}

function setSync(next: SyncState) {
  syncState = next;
  const element = app.querySelector<HTMLElement>("[data-sync]");
  if (element) element.textContent = syncLabel();
}

function syncLabel() {
  return { loading: "Loading…", saved: "Saved to cloud", saving: "Saving…", error: "Not saved" }[syncState];
}

function renderCloudBar() {
  if (!cloudConfigured) return "";
  const missing = legacyMissing();
  const banner = legacyUploaded
    ? `<div class="notice">Upload verified: the cloud holds every record from this browser. <button data-action="cloud-remove-local">Remove browser copy</button></div>`
    : missing && missing.total
      ? `<div class="notice">This browser has ${missing.sessions} sessions and ${missing.projects} projects from before cloud sync that are not in the cloud yet. <button data-action="cloud-upload">Upload to cloud</button></div>`
      : "";
  return banner;
}

function touchLastSeen() {
  saveState();
}

function render() {
  document.documentElement.dataset.theme = state.settings.theme;
  const activeSessions = getActiveSessions();
  const longestActiveRunMs = longestActiveRunDurationMs();
  const totalToday = state.sessions
    .filter((session) => isSameLocalDay(session.startAt, nowIso()))
    .reduce((sum, session) => sum + sessionDurationMs(session), 0);

  app.innerHTML = `
    <main class="shell">
      <header class="topbar">
        <div class="brand">
          ${renderBrandIcon()}
          <h1>Session Tracker</h1>
        </div>
        <div class="topbar__stats" aria-label="Current tracker summary">
          <span>${activeSessions.length} running</span>
          <span><strong data-week-cutoff>${formatCountdown(msUntilNextWeeklyCutoffUtc())}</strong> to week cutoff</span>
          <span class="${longestActiveRunMs >= RUN_LIMIT_MS ? "is-warning" : ""}"><strong data-longest-run>${activeSessions.length ? formatLongDuration(longestActiveRunMs) : "None"}</strong> active run</span>
          <span><strong data-total-today>${formatDuration(totalToday)}</strong> today</span>
          ${cloudConfigured ? `<span data-sync>${syncLabel()}</span><button data-action="sign-out">Sign out</button>` : ""}
          <button
            class="theme-toggle"
            data-action="toggle-theme"
            aria-label="${state.settings.theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}"
            title="${state.settings.theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}"
          >
            ${renderThemeIcon()}
          </button>
        </div>
      </header>

      ${notice ? `<div class="notice">${escapeHtml(notice)}</div>` : ""}
      ${renderCloudBar()}
      ${renderRunLimitWarning()}
      ${renderRecoveryBanner()}

      <section class="workspace">
        <aside class="project-panel" aria-label="Projects">
          <div class="panel-heading">
            <div>
              <h2>Projects</h2>
              <p>${state.settings.timerMode === "exclusive" ? "Starting one project ends the previous running session." : "Projects can run at the same time."}</p>
            </div>
            <button class="icon-button" data-action="add-project" title="Add project" aria-label="Add project">+</button>
          </div>
          <div class="mode-toggle" role="group" aria-label="Project mode and archive view">
            <button class="${projectPanelView === "active" && state.settings.timerMode === "exclusive" ? "is-active" : ""}" data-action="set-mode" data-mode="exclusive">Single active</button>
            <button class="${projectPanelView === "active" && state.settings.timerMode === "parallel" ? "is-active" : ""}" data-action="set-mode" data-mode="parallel">Parallel</button>
            <button class="${projectPanelView === "archived" ? "is-active" : ""}" data-action="show-archived">Archived</button>
          </div>
          <div class="project-list">
            ${projectPanelView === "archived" ? renderArchivedProjects() : renderActiveProjects()}
          </div>
        </aside>

        <section class="session-panel" aria-label="Session log">
          <div class="session-toolbar">
            <div>
              <h2>Sessions</h2>
              <p>Local timezone: ${escapeHtml(getLocalTimeZone())}. UTC is shown for every completed window.</p>
            </div>
            <div class="toolbar-actions">
              <button data-action="end-all" ${activeSessions.length ? "" : "disabled"}>End all</button>
              <button data-action="copy-local" ${filteredSessions().length ? "" : "disabled"}>Copy local</button>
              <button data-action="copy-utc" ${filteredSessions().length ? "" : "disabled"}>Copy UTC</button>
              <button data-action="export-json" title="Save an offline JSON backup file">Save file</button>
              <label class="file-button" title="Upload an offline JSON backup file">
                Upload file
                <input type="file" data-action="import-json" accept="application/json" />
              </label>
            </div>
          </div>

          <div class="filters" role="group" aria-label="Filter sessions">
            <button class="${selectedProjectId === "all" ? "is-active" : ""}" data-action="select-project" data-project-id="all">All</button>
            ${state.projects.map((project) => `
              <button class="${selectedProjectId === project.id ? "is-active" : ""}" data-action="select-project" data-project-id="${project.id}">
                ${escapeHtml(project.name)}
              </button>
            `).join("")}
          </div>

          <div class="sessions">
            ${renderSessions()}
          </div>
        </section>
      </section>
    </main>
  `;

  bindEvents();
  renderTimerValues();
}

function renderBrandIcon() {
  return `
    <svg class="brand-mark" viewBox="0 0 64 64" aria-hidden="true">
      <rect width="64" height="64" rx="14"></rect>
      <path d="M32 13a19 19 0 1 0 0 38 19 19 0 0 0 0-38Zm0 5a14 14 0 1 1 0 28 14 14 0 0 1 0-28Z"></path>
      <path d="M32 22v11l8 5"></path>
      <path d="M15 49h34"></path>
    </svg>
  `;
}

function renderThemeIcon() {
  if (state.settings.theme === "dark") {
    return `
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="4"></circle>
        <path d="M12 2v2.5M12 19.5V22M4.93 4.93l1.77 1.77M17.3 17.3l1.77 1.77M2 12h2.5M19.5 12H22M4.93 19.07l1.77-1.77M17.3 6.7l1.77-1.77"></path>
      </svg>
    `;
  }

  return `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M21 12.8A8.3 8.3 0 1 1 11.2 3a6.6 6.6 0 0 0 9.8 9.8Z"></path>
    </svg>
  `;
}

function renderActiveProjects() {
  const activeProjects = state.projects.filter((project) => !project.archived);
  if (!activeProjects.length) {
    return `
      <div class="empty-state compact">
        <h3>No active projects</h3>
        <p>Restore an archived project or add a new one.</p>
      </div>
    `;
  }

  return activeProjects.map(renderProjectCard).join("");
}

function renderProjectCard(project: Project) {
  const active = state.sessions.find((session) => session.projectId === project.id && !session.endAt);
  const hasSessions = countProjectSessions(project.id) > 0;
  const totalProjectMs = projectDurationMs(project.id);
  const activeSegmentMs = active ? sessionDurationMs(active) : 0;

  return `
    <article class="project-card ${active ? "is-running" : ""}" style="--accent:${project.color}">
      <div class="project-card__top">
        <span class="project-dot" aria-hidden="true"></span>
        <input class="project-name" data-action="rename-project" data-project-id="${project.id}" value="${escapeAttribute(project.name)}" aria-label="Project name" />
      </div>
      <div class="project-meta">
        <span data-timer-for="${project.id}">${formatDuration(totalProjectMs)}</span>
        <span data-running-for="${project.id}">${active ? `running ${formatDuration(activeSegmentMs)}` : `${countProjectSessions(project.id)} sessions`}</span>
      </div>
      <div class="project-actions">
        <button class="primary" data-action="${active ? "pause-project" : "start-project"}" data-project-id="${project.id}">
          ${active ? "Pause" : hasSessions ? "Resume" : "Start"}
        </button>
        <button data-action="quick-note" data-project-id="${project.id}" ${active ? "" : "disabled"}>Note</button>
        <button class="ghost" data-action="archive-project" data-project-id="${project.id}" ${active ? "disabled" : ""}>Archive</button>
      </div>
    </article>
  `;
}

function renderArchivedProjects() {
  const archivedProjects = state.projects.filter((project) => project.archived);
  if (!archivedProjects.length) {
    return `
      <div class="empty-state compact">
        <h3>No archived projects</h3>
        <p>Archived projects will appear here.</p>
      </div>
    `;
  }

  return `
    ${archivedProjects.map((project) => `
      <article class="archived-project" style="--accent:${project.color}">
        <span class="project-pill" style="--accent:${project.color}">${escapeHtml(project.name)}</span>
        <button data-action="restore-project" data-project-id="${project.id}">Restore</button>
      </article>
    `).join("")}
  `;
}

function renderRecoveryBanner() {
  if (!recoveryVisible) {
    return "";
  }

  const lastSeen = new Date(state.lastSeenAt);
  const gap = Date.now() - lastSeen.getTime();
  const activeCount = getActiveSessions().length;

  if (!activeCount) {
    return "";
  }

  return `
    <section class="recovery" aria-label="Timer recovery">
      <div>
        <strong>${activeCount} session${activeCount === 1 ? "" : "s"} ${activeCount === 1 ? "was" : "were"} running while this tab was away.</strong>
        <p>Last browser activity was ${formatLocalDateTime(lastSeen.toISOString())}, about ${formatDuration(gap)} ago.</p>
      </div>
      <div class="recovery-actions">
        <button data-action="keep-running">Keep running</button>
        <button data-action="stop-at-last-seen">End at last activity</button>
        <button class="primary" data-action="stop-at-now">End now</button>
      </div>
    </section>
  `;
}

function renderRunLimitWarning() {
  const overdueSession = getActiveSessions()
    .map((session) => ({ session, durationMs: sessionDurationMs(session) }))
    .filter(({ durationMs }) => durationMs >= RUN_LIMIT_MS)
    .sort((a, b) => b.durationMs - a.durationMs)[0];

  if (!overdueSession) {
    return "";
  }

  const project = getProject(overdueSession.session.projectId);
  const name = project?.name || "A project";

  return `
    <section class="warning-banner" aria-label="Seven day run warning">
      <strong>${escapeHtml(name)} has been running for ${formatLongDuration(overdueSession.durationMs)}.</strong>
      <span>Finish or pause it before a 7-day running window causes expiry issues.</span>
    </section>
  `;
}

function renderSessions() {
  const sessions = filteredSessions();

  if (!sessions.length) {
    return `
      <div class="empty-state">
        <h3>No sessions yet</h3>
        <p>Start a project to create the first copyable work window.</p>
      </div>
    `;
  }

  return `
    <div class="session-list" aria-label="Work sessions">
      ${sessions.map(renderSessionRow).join("")}
    </div>
  `;
}

function renderSessionRow(session: WorkSession) {
  const project = getProject(session.projectId);
  const endValue = session.endAt ? toLocalInputValue(session.endAt) : "";
  const duration = sessionDurationMs(session);
  const status = session.endAt ? "Completed" : "Running";
  const canEditEnd = Boolean(session.endAt && isLatestSessionForProject(session));

  return `
    <article class="session-card">
      <div class="session-card__head">
        <span class="project-pill" style="--accent:${project?.color || "#475569"}">${escapeHtml(project?.name || "Deleted project")}</span>
        <div class="session-summary">
          <span class="session-status ${session.endAt ? "" : "is-running"}">${status}</span>
          <strong data-session-duration="${session.id}">${formatDuration(duration)}</strong>
        </div>
        <div class="row-actions">
          <button class="ghost" data-action="delete-session" data-session-id="${session.id}">Delete</button>
        </div>
      </div>
      <div class="time-grid">
        <label class="time-field">
          <span>Local start</span>
          <output>${toLocalInputValue(session.startAt)}</output>
        </label>
        <label class="time-field">
          <span>Local end</span>
          ${session.endAt
            ? canEditEnd
              ? `<input type="text" inputmode="numeric" data-action="edit-session-end" data-session-id="${session.id}" value="${endValue}" placeholder="DD/MM/YYYY HH:mm:ss" />`
              : `<output>${endValue}</output>`
            : "<output>Running</output>"}
        </label>
        <div class="time-field">
          <span>UTC start</span>
          <output>${formatUtcDateTime(session.startAt)}</output>
        </div>
        <div class="time-field">
          <span>UTC end</span>
          <output>${session.endAt ? formatUtcDateTime(session.endAt) : "Running"}</output>
        </div>
      </div>
      <label class="note-field">
        <span>Note</span>
        <input class="note-input" data-action="edit-note" data-session-id="${session.id}" value="${escapeAttribute(session.note)}" placeholder="Optional note" />
      </label>
    </article>
  `;
}

function bindEvents() {
  app.querySelectorAll<HTMLElement>("[data-action]").forEach((element) => {
    const action = element.dataset.action;

    if (action === "rename-project" || action === "edit-note") {
      element.addEventListener("input", handleInput);
      return;
    }

    if (action === "edit-session-end") {
      element.addEventListener("change", handleInput);
      return;
    }

    if (action === "import-json") {
      element.addEventListener("change", importJson);
      return;
    }

    element.addEventListener("click", handleClick);
  });
}

function handleClick(event: Event) {
  const target = event.currentTarget as HTMLElement;
  const action = target.dataset.action;
  const projectId = target.dataset.projectId;
  const sessionId = target.dataset.sessionId;

  switch (action) {
    case "cloud-upload":
      void uploadLegacy();
      return;
    case "cloud-remove-local":
      window.localStorage.removeItem(STORAGE_KEY);
      legacy = null;
      legacyUploaded = false;
      notice = "Browser copy removed.";
      render();
      return;
    case "sign-out":
      queue.reset();
      synced = null;
      void signOut().then(() => location.reload());
      return;
    case "add-project":
      addProject();
      break;
    case "archive-project":
      if (projectId) archiveProject(projectId);
      break;
    case "restore-project":
      if (projectId) restoreProject(projectId);
      break;
    case "start-project":
      if (projectId) startProject(projectId);
      break;
    case "pause-project":
      if (projectId) stopProject(projectId);
      break;
    case "quick-note":
      if (projectId) addQuickNote(projectId);
      break;
    case "set-mode":
      setMode(target.dataset.mode === "parallel" ? "parallel" : "exclusive");
      break;
    case "show-archived":
      projectPanelView = "archived";
      render();
      break;
    case "toggle-theme":
      toggleTheme();
      break;
    case "select-project":
      selectedProjectId = projectId || "all";
      render();
      break;
    case "end-all":
      endAll(nowIso());
      break;
    case "copy-local":
      void copySessions("local");
      break;
    case "copy-utc":
      void copySessions("utc");
      break;
    case "export-json":
      exportJson();
      break;
    case "delete-session":
      if (sessionId) deleteSession(sessionId);
      break;
    case "keep-running":
      recoveryVisible = false;
      touchLastSeen();
      render();
      break;
    case "stop-at-last-seen":
      endAll(state.lastSeenAt);
      recoveryVisible = false;
      break;
    case "stop-at-now":
      endAll(nowIso());
      recoveryVisible = false;
      break;
  }
}

function handleInput(event: Event) {
  const target = event.currentTarget as HTMLInputElement;
  const action = target.dataset.action;
  const projectId = target.dataset.projectId;
  const sessionId = target.dataset.sessionId;

  if (action === "rename-project" && projectId) {
    const project = getProject(projectId);
    if (project) {
      project.name = target.value.trim() || "Untitled project";
      saveState();
    }
    return;
  }

  const session = sessionId ? getSession(sessionId) : undefined;

  if (!session) {
    return;
  }

  if (action === "edit-note") {
    session.note = target.value;
    saveState();
  }

  if (action === "edit-session-end") {
    if (!isLatestSessionForProject(session) || !session.endAt) {
      render();
      return;
    }

    const parsed = target.value ? fromLocalInputValue(target.value) : null;
    if (!parsed) {
      render();
      return;
    }

    session.endAt = parsed;
    saveState();
    render();
  }
}

function addProject() {
  const projectNumber = state.projects.length + 1;
  state.projects.push({
    id: makeId("project"),
    name: `Project ${projectNumber}`,
    createdAt: nowIso(),
    color: PROJECT_COLORS[state.projects.length % PROJECT_COLORS.length],
    archived: false,
  });
  projectPanelView = "active";
  saveState();
  render();
}

function archiveProject(projectId: string) {
  const project = getProject(projectId);
  if (!project) return;

  project.archived = true;
  if (selectedProjectId === projectId) {
    selectedProjectId = "all";
  }
  saveState();
  render();
}

function restoreProject(projectId: string) {
  const project = getProject(projectId);
  if (!project) return;

  project.archived = false;
  projectPanelView = "active";
  saveState();
  render();
}

function startProject(projectId: string) {
  const timestamp = nowIso();

  if (state.settings.timerMode === "exclusive") {
    state.sessions.forEach((session) => {
      if (!session.endAt) {
        session.endAt = timestamp;
      }
    });
  }

  state.sessions.unshift({
    id: makeId("session"),
    projectId,
    startAt: timestamp,
    endAt: null,
    note: "",
  });
  recoveryVisible = false;
  saveState();
  render();
}

function stopProject(projectId: string) {
  const active = state.sessions.find((session) => session.projectId === projectId && !session.endAt);
  if (active) {
    stopSession(active.id, nowIso());
  }
}

function stopSession(sessionId: string, endAt: string) {
  const session = getSession(sessionId);
  if (!session) return;

  session.endAt = endAt;
  saveState();
  render();
}

function endAll(endAt: string) {
  state.sessions.forEach((session) => {
    if (!session.endAt) {
      session.endAt = endAt;
    }
  });
  saveState();
  render();
}

function deleteSession(sessionId: string) {
  state.sessions = state.sessions.filter((session) => session.id !== sessionId);
  saveState();
  render();
}

function addQuickNote(projectId: string) {
  const active = state.sessions.find((session) => session.projectId === projectId && !session.endAt);
  if (!active) return;

  const note = window.prompt("Session note", active.note);
  if (note !== null) {
    active.note = note;
    saveState();
    render();
  }
}

function setMode(mode: TimerMode) {
  projectPanelView = "active";
  state.settings.timerMode = mode;
  if (mode === "exclusive") {
    const active = getActiveSessions();
    active.slice(1).forEach((session) => {
      session.endAt = nowIso();
    });
  }
  saveState();
  render();
}

function toggleTheme() {
  state.settings.theme = state.settings.theme === "dark" ? "light" : "dark";
  saveState();
  render();
}

async function copySessions(mode: CopyMode) {
  const isLocal = mode === "local";
  const rows = [
    ["Project", "Start", "End", "Duration", "Note"],
    ...filteredSessions().map((session) => {
      const project = getProject(session.projectId);
      return [
        project?.name || "Deleted project",
        isLocal ? formatLocalDateTime(session.startAt) : formatUtcDateTime(session.startAt),
        session.endAt ? (isLocal ? formatLocalDateTime(session.endAt) : formatUtcDateTime(session.endAt)) : "Running",
        formatDuration(sessionDurationMs(session)),
        session.note,
      ];
    }),
  ];

  const tsv = rows.map((row) => row.map((cell) => cell.replace(/\t|\n/g, " ")).join("\t")).join("\n");
  await navigator.clipboard.writeText(tsv);
  notice = `Copied ${isLocal ? "local" : "UTC"} times for the visible sessions.`;
  render();
}

function exportJson() {
  const payload = JSON.stringify(state, null, 2);
  const blob = new Blob([payload], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `time-sessions-${new Date().toISOString().slice(0, 10)}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function importJson(event: Event) {
  const input = event.currentTarget as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;

  const reader = new FileReader();
  reader.addEventListener("load", () => {
    try {
      const imported = JSON.parse(String(reader.result)) as AppState;
      if (!Array.isArray(imported.projects) || !Array.isArray(imported.sessions)) {
        throw new Error("Invalid import shape.");
      }
      state = {
        schemaVersion: 1,
        projects: imported.projects,
        sessions: imported.sessions,
        settings: {
          timerMode: imported.settings?.timerMode === "parallel" ? "parallel" : "exclusive",
          staleAfterMinutes: Number(imported.settings?.staleAfterMinutes) || 15,
          theme: imported.settings?.theme === "dark" ? "dark" : "light",
        },
        lastSeenAt: nowIso(),
      };
      selectedProjectId = "all";
      recoveryVisible = shouldShowRecovery(state);
      saveState();
      notice = "Imported sessions from JSON.";
      render();
    } catch {
      notice = "Import failed. Choose a JSON export from this tracker.";
      render();
    }
  });
  reader.readAsText(file);
}

function filteredSessions() {
  const sessions = selectedProjectId === "all"
    ? state.sessions
    : state.sessions.filter((session) => session.projectId === selectedProjectId);

  return [...sessions].sort((a, b) => new Date(b.startAt).getTime() - new Date(a.startAt).getTime());
}

function getProject(projectId: string) {
  return state.projects.find((project) => project.id === projectId);
}

function getSession(sessionId: string) {
  return state.sessions.find((session) => session.id === sessionId);
}

function getActiveSessions() {
  return state.sessions.filter((session) => !session.endAt);
}

function countProjectSessions(projectId: string) {
  return state.sessions.filter((session) => session.projectId === projectId).length;
}

function isLatestSessionForProject(session: WorkSession) {
  const latest = state.sessions
    .filter((candidate) => candidate.projectId === session.projectId)
    .sort((a, b) => new Date(b.startAt).getTime() - new Date(a.startAt).getTime())[0];

  return latest?.id === session.id;
}

function sessionDurationMs(session: WorkSession) {
  const start = new Date(session.startAt).getTime();
  const end = session.endAt ? new Date(session.endAt).getTime() : Date.now();
  return Math.max(0, end - start);
}

function projectDurationMs(projectId: string) {
  return state.sessions
    .filter((session) => session.projectId === projectId)
    .reduce((sum, session) => sum + sessionDurationMs(session), 0);
}

function longestActiveRunDurationMs() {
  return getActiveSessions().reduce((longest, session) => Math.max(longest, sessionDurationMs(session)), 0);
}

function renderTimerValues() {
  const activeSessions = getActiveSessions();
  const longestActiveRunMs = longestActiveRunDurationMs();
  const totalToday = state.sessions
    .filter((session) => isSameLocalDay(session.startAt, nowIso()))
    .reduce((sum, session) => sum + sessionDurationMs(session), 0);

  const weekCutoffElement = app.querySelector<HTMLElement>("[data-week-cutoff]");
  if (weekCutoffElement) {
    weekCutoffElement.textContent = formatCountdown(msUntilNextWeeklyCutoffUtc());
  }

  const longestRunElement = app.querySelector<HTMLElement>("[data-longest-run]");
  if (longestRunElement) {
    longestRunElement.textContent = activeSessions.length ? formatLongDuration(longestActiveRunMs) : "None";
    longestRunElement.parentElement?.classList.toggle("is-warning", longestActiveRunMs >= RUN_LIMIT_MS);
  }

  const totalTodayElement = app.querySelector<HTMLElement>("[data-total-today]");
  if (totalTodayElement) {
    totalTodayElement.textContent = formatDuration(totalToday);
  }

  state.projects.forEach((project) => {
    const active = state.sessions.find((session) => session.projectId === project.id && !session.endAt);
    const timer = app.querySelector<HTMLElement>(`[data-timer-for="${project.id}"]`);
    if (timer) {
      timer.textContent = formatDuration(projectDurationMs(project.id));
    }
    const runningFor = app.querySelector<HTMLElement>(`[data-running-for="${project.id}"]`);
    if (runningFor && active) {
      runningFor.textContent = `running ${formatDuration(sessionDurationMs(active))}`;
    }
  });

  state.sessions.forEach((session) => {
    if (!session.endAt) {
      const duration = app.querySelector<HTMLElement>(`[data-session-duration="${session.id}"]`);
      if (duration) {
        duration.textContent = formatDuration(sessionDurationMs(session));
      }
    }
  });
}

function shouldShowRecovery(nextState: AppState) {
  const lastSeen = new Date(nextState.lastSeenAt).getTime();
  const staleMs = nextState.settings.staleAfterMinutes * 60_000;
  return nextState.sessions.some((session) => !session.endAt) && Date.now() - lastSeen > staleMs;
}

function isSameLocalDay(leftIso: string, rightIso: string) {
  const left = new Date(leftIso);
  const right = new Date(rightIso);
  return left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate();
}

function nowIso() {
  return new Date().toISOString();
}

function makeId(prefix: string) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function getLocalTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "Local browser time";
}

function formatLocalDateTime(iso: string) {
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}

function formatUtcDateTime(iso: string) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(iso)).replace(",", "") + " UTC";
}

function msUntilNextWeeklyCutoffUtc(now = new Date()) {
  const utcDay = now.getUTCDay();
  const daysUntilMonday = (8 - utcDay) % 7 || 7;
  const cutoff = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + daysUntilMonday, 0, 0, 0, 0);
  return Math.max(0, cutoff - now.getTime());
}

function formatCountdown(milliseconds: number) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (days) {
    return `${days}d ${hours.toString().padStart(2, "0")}h ${minutes.toString().padStart(2, "0")}m ${seconds.toString().padStart(2, "0")}s`;
  }

  return `${hours}h ${minutes.toString().padStart(2, "0")}m ${seconds.toString().padStart(2, "0")}s`;
}

function formatLongDuration(milliseconds: number) {
  const totalMinutes = Math.max(0, Math.floor(milliseconds / 60_000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;

  if (days) {
    return `${days}d ${hours.toString().padStart(2, "0")}h ${minutes.toString().padStart(2, "0")}m`;
  }

  return `${hours}h ${minutes.toString().padStart(2, "0")}m`;
}

function formatDuration(milliseconds: number) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours) {
    return `${hours}h ${minutes.toString().padStart(2, "0")}m`;
  }

  return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
}

function toLocalInputValue(iso: string) {
  const date = new Date(iso);
  return [
    date.getDate().toString().padStart(2, "0"),
    (date.getMonth() + 1).toString().padStart(2, "0"),
    date.getFullYear().toString(),
  ].join("/") + ` ${date.getHours().toString().padStart(2, "0")}:${date.getMinutes().toString().padStart(2, "0")}:${date.getSeconds().toString().padStart(2, "0")}`;
}

function fromLocalInputValue(value: string) {
  if (!value) {
    return null;
  }

  const legacyValue = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (legacyValue) {
    const [, year, month, day, hour, minute, second = "0"] = legacyValue;
    return new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)).toISOString();
  }

  const localValue = value.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!localValue) {
    return null;
  }

  const [, day, month, year, hour, minute, second = "0"] = localValue;
  return new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)).toISOString();
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "\"": "&quot;",
      "'": "&#039;",
    };
    return entities[char];
  });
}

function escapeAttribute(value: string) {
  return escapeHtml(value);
}
