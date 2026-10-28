import { createStore, type Row, type Rows } from "./cloud-sync";
import type { AppState } from "./types";

// Time tracker persistence in Supabase (schema `timetrack`). lastSeenAt stays per-device.
export const store = createStore("timetrack", ["projects", "sessions", "settings"] as const);
export type TrackerRows = Rows<(typeof store.tables)[number]>;

const iso = (v: unknown) => new Date(String(v)).toISOString();

export function toRows(state: AppState): TrackerRows {
  return {
    projects: state.projects.map((p) => ({ id: p.id, name: p.name, color: p.color, archived: p.archived, created_at: p.createdAt })),
    sessions: state.sessions.map((s) => ({ id: s.id, project_id: s.projectId, start_at: s.startAt, end_at: s.endAt, note: s.note })),
    settings: [{ id: "settings", timer_mode: state.settings.timerMode, stale_after_minutes: state.settings.staleAfterMinutes, theme: state.settings.theme }],
  };
}

// Timestamps are normalised to the app's ISO form so unchanged rows compare equal.
export function fromRows(rows: TrackerRows, lastSeenAt: string): AppState {
  const settings: Row | undefined = rows.settings[0];
  return {
    schemaVersion: 1,
    projects: rows.projects
      .map((p) => ({ id: p.id, name: String(p.name), color: String(p.color), archived: Boolean(p.archived), createdAt: iso(p.created_at) }))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    sessions: rows.sessions.map((s) => ({ id: s.id, projectId: String(s.project_id), startAt: iso(s.start_at), endAt: s.end_at == null ? null : iso(s.end_at), note: String(s.note ?? "") })),
    settings: {
      timerMode: settings?.timer_mode === "parallel" ? "parallel" : "exclusive",
      staleAfterMinutes: Number(settings?.stale_after_minutes) || 15,
      theme: settings?.theme === "dark" ? "dark" : "light",
    },
    lastSeenAt,
  };
}

// Normalises a state the same way a cloud round trip would, for comparisons.
export const normalise = (state: AppState): TrackerRows => toRows(fromRows(toRows(state), state.lastSeenAt));
