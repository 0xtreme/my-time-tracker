export type TimerMode = "exclusive" | "parallel";
export type Theme = "light" | "dark";
export type CopyMode = "local" | "utc";
export type ProjectPanelView = "active" | "archived";

export type Project = {
  id: string;
  name: string;
  createdAt: string;
  color: string;
  archived: boolean;
};

export type WorkSession = {
  id: string;
  projectId: string;
  startAt: string;
  endAt: string | null;
  note: string;
};

export type Settings = {
  timerMode: TimerMode;
  staleAfterMinutes: number;
  theme: Theme;
};

export type AppState = {
  schemaVersion: 1;
  projects: Project[];
  sessions: WorkSession[];
  settings: Settings;
  lastSeenAt: string;
};

