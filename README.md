# Time Session Tracker

A local-first web app for tracking project work sessions and copying start/end times in both local time and UTC.

## Product Decision

The app is static, which is how GitHub Pages serves it. When built with Supabase settings, projects, sessions and settings are stored in a private Supabase database (schema `timetrack`, migrations in the `db` repo). Opening the app then requires sign-in and an authenticator code. Without those settings it runs browser-only, as before.

Recommended hosting for the current version: **GitHub Pages**.

Use Vercel later if the app adds authenticated sync, server-side storage, team sharing, protected preview deployments, or OAuth callbacks. Those features would change the privacy model and require a proper backend design.

## Features

- Create and rename projects.
- Start and end project sessions.
- Pause and resume project work with clean session windows.
- Single-active mode: starting one project automatically ends the current running session.
- Parallel mode: multiple project sessions can run at the same time.
- Local and UTC timestamps for each work window.
- Editable latest session end time and session notes.
- Weekly UTC cutoff countdown and long-running session warning.
- Copy visible sessions as local-time or UTC tab-separated text for project tools and spreadsheets.
- Save and restore offline JSON backup files from the user's machine.
- Browser-close recovery for timers left running.

## Storage

**Cloud mode** (`.env.local` locally; repository variables `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` for Pages):
- Records load from and save to Supabase. The publishable key grants nothing by itself: every table is owner-only and requires an MFA session.
- The header shows `Saved to cloud`, `Saving…` or `Not saved`. An edit made at the same time in another window is reported and reloaded, not overwritten.
- Only the per-device activity heartbeat used for stale-timer recovery stays in this browser.
- Records saved in a browser before cloud sync appear as **Upload to cloud**. The upload only adds what the cloud lacks. After it is verified, the browser copy can be removed.

**Browser-only mode** (no Supabase settings, e.g. a fresh clone):
- Session data is saved to `localStorage`. Running timers are stored as timestamps, so a timer can be reconstructed after reopening the app.
- Private/incognito windows and browser data clearing can remove local data. Export JSON backups when records matter.

In both modes, if the tab was closed or inactive for a long gap, the app asks whether to keep the timer running, end it at the last browser activity, or end it now.

Use **Save file** to download an offline JSON backup and **Upload file** to load that file back into the app. The browser cannot reliably save or upload a file automatically when the tab closes, so backup is an explicit user action.

## Development

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
```

The production build is generated in `dist/`.

## Deployment

GitHub Pages can host the static `dist/` output. The included workflow builds and publishes the app from `main`.

Vercel can also deploy the project as a Vite static app. No server functions are required.
