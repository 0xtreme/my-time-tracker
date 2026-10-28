// Shared cloud persistence for personal apps. Copied into each app as src/cloud-sync.ts;
// keep the copies identical and change this template first.
//
// Each app maps its state to rows per table (`{ id, ...columns }`) and back. Keep the
// last-saved baseline in that app shape (toRows(fromRows(await load()))), not the raw rows
// from load(), which carry owner/revision columns and Postgres timestamp formats. This module
// loads the rows (paged), writes only the differences, checks revisions so concurrent edits
// surface as conflicts, and merges records still held in a browser by id without overwriting
// cloud rows. Every table must be secured with core.secure_table (owner-only, MFA required).
import { createClient } from '@supabase/supabase-js';

// import.meta.env is absent when code is bundled outside Vite (e.g. Node tests): browser-only mode.
const env = (import.meta.env ?? {}) as Record<string, string | undefined>;
const url = env.VITE_SUPABASE_URL;
const key = env.VITE_SUPABASE_PUBLISHABLE_KEY;
export const cloudConfigured = Boolean(url && key);
export const supabase = cloudConfigured ? createClient(url!, key!) : null;

export type Row = { id: string } & Record<string, unknown>;
export type Rows<T extends string> = Record<T, Row[]>;
export class ConflictError extends Error {}

const PAGE = 1000;
const CHUNK = 500;

// Key-order-independent comparison (jsonb reorders object keys).
export const stable = (v: unknown): string => v && typeof v === 'object' && !Array.isArray(v)
  ? '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stable((v as Record<string, unknown>)[k])).join(',') + '}'
  : Array.isArray(v) ? '[' + v.map(stable).join(',') + ']' : JSON.stringify(v ?? null);

export const message = (e: unknown) => e instanceof Error ? e.message : 'Unknown error';

// `tables` must be in foreign-key order: parents before children.
export function createStore<T extends string>(schema: string, tables: readonly T[]) {
  const revisions = new Map<string, number>();
  const ref = (t: T, id: string) => `${t}:${id}`;
  const db = () => { if (!supabase) throw new Error('Cloud storage is not configured.'); return supabase.schema(schema) };
  const empty = () => Object.fromEntries(tables.map(t => [t, []])) as unknown as Rows<T>;

  async function load(): Promise<Rows<T>> {
    const rows = empty();
    revisions.clear();
    for (const t of tables) {
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await db().from(t).select('*').is('deleted_at', null).order('id').range(from, from + PAGE - 1);
        if (error) throw new Error(`Could not load ${t}: ${error.message}`);
        for (const r of data as Row[]) { rows[t].push(r); revisions.set(ref(t, r.id), Number(r.revision)) }
        if (data.length < PAGE) break;
      }
    }
    return rows;
  }

  function diff(prev: Rows<T>, next: Rows<T>) {
    const upserts = empty(), deletes = Object.fromEntries(tables.map(t => [t, [] as string[]])) as Record<T, string[]>;
    for (const t of tables) {
      const before = new Map(prev[t].map(r => [r.id, stable(r)]));
      const after = new Set(next[t].map(r => r.id));
      upserts[t] = next[t].filter(r => before.get(r.id) !== stable(r));
      deletes[t] = prev[t].filter(r => !after.has(r.id)).map(r => r.id);
    }
    return { upserts, deletes };
  }

  async function insert(t: T, rows: Row[], ignoreDuplicates: boolean) {
    for (let i = 0; i < rows.length; i += CHUNK) {
      const batch = rows.slice(i, i + CHUNK).map(r => ({ ...r, deleted_at: null }));
      const { data, error } = await db().from(t).upsert(batch, { onConflict: 'id', ignoreDuplicates }).select('id,revision');
      if (error) throw new Error(`Could not save ${t}: ${error.message}`);
      for (const r of data as Row[]) revisions.set(ref(t, r.id), Number(r.revision));
    }
  }

  async function update(t: T, id: string, values: Record<string, unknown>) {
    const { data, error } = await db().from(t).update(values).eq('id', id).eq('revision', revisions.get(ref(t, id))!).select('id,revision');
    if (error) throw new Error(`Could not save ${t}: ${error.message}`);
    if (!data.length) throw new ConflictError('This record changed in another window or device.');
    revisions.set(ref(t, id), Number((data[0] as Row).revision));
  }

  // Writes the difference between the last confirmed cloud rows and the new rows.
  async function push(prev: Rows<T>, next: Rows<T>) {
    const { upserts, deletes } = diff(prev, next);
    for (const t of tables) {
      await insert(t, upserts[t].filter(r => !revisions.has(ref(t, r.id))), false);
      for (const r of upserts[t].filter(r => revisions.has(ref(t, r.id)))) await update(t, r.id, r);
    }
    for (const t of [...tables].reverse())
      for (const id of deletes[t]) if (revisions.has(ref(t, id))) { await update(t, id, { deleted_at: new Date().toISOString() }); revisions.delete(ref(t, id)) }
  }

  // Rows held locally (e.g. browser storage from before cloud sync) whose ids the cloud lacks.
  function missing(local: Rows<T>) {
    return Object.fromEntries(tables.map(t => [t, local[t].filter(r => !revisions.has(ref(t, r.id)))])) as unknown as Rows<T>;
  }
  const count = (rows: Rows<T>) => tables.reduce((n, t) => n + rows[t].length, 0);

  // Adds missing rows only; existing cloud rows are never overwritten.
  async function merge(local: Rows<T>) {
    const add = missing(local);
    for (const t of tables) await insert(t, add[t], true);
    return add;
  }

  return { tables, revisions, load, diff, push, missing, merge, count, empty };
}

// Runs saves one at a time; bumping the generation drops queued work (after reload or sign-out).
export function createQueue() {
  let tail: Promise<void> = Promise.resolve();
  let generation = 0;
  return {
    run(work: () => Promise<void>) { const g = generation; tail = tail.then(() => g === generation ? work() : undefined).catch(() => undefined) },
    reset() { generation++ },
  };
}
