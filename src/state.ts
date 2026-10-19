import { MONITORED_HEADING, STATE_KEY } from "./constants.ts";
import type { Env, MonitorState, TableData } from "./types.ts";

export function buildState(tables: TableData[]): MonitorState {
  return { heading: MONITORED_HEADING, tables };
}

export async function stateHash(state: MonitorState): Promise<string> {
  const data = new TextEncoder().encode(JSON.stringify(state));
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function containsMikontalo(state: MonitorState): boolean {
  return state.tables.some((table) =>
    table.rows.some((row) => row.some((cell) => cell.toLowerCase().includes("mikontalo"))),
  );
}

export async function getPreviousStateHash(env: Env): Promise<string | null> {
  const raw = await env.TOAS_STATE.get(STATE_KEY);
  if (raw === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Cloudflare KV contains invalid state JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Cloudflare KV contains invalid state JSON");
  }

  const value = (parsed as Record<string, unknown>).value;
  if (value == null) return null;
  if (typeof value !== "string") {
    throw new Error("Cloudflare KV state hash is not a string");
  }
  return value;
}

export async function saveStateHash(env: Env, hash: string): Promise<void> {
  await env.TOAS_STATE.put(STATE_KEY, JSON.stringify({ value: hash }));
}
