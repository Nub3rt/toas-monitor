import { TOAS_URL, USER_AGENT } from "./constants.ts";
import { formatState } from "./format.ts";
import { parseMonitoredTables } from "./parser.ts";
import { getPreviousStateHash, saveStateHash, stateHash, buildState, containsMikontalo } from "./state.ts";
import { sendTelegram } from "./telegram.ts";
import type { Env, TableData } from "./types.ts";

export async function fetchPage(): Promise<string> {
  const response = await fetch(TOAS_URL, { headers: { "User-Agent": USER_AGENT } });
  if (!response.ok) throw new Error(`TOAS returned HTTP ${response.status}`);
  return response.text();
}

/** Optional injected dependencies make the unchanged alert policy easy to test. */
export interface MonitorDependencies {
  fetchPage: () => Promise<string>;
  parseMonitoredTables: (html: string) => Promise<TableData[]>;
  sendTelegram: (env: Env, message: string) => Promise<void>;
}

const runtimeDependencies: MonitorDependencies = { fetchPage, parseMonitoredTables, sendTelegram };

export async function checkToas(env: Env, deps: MonitorDependencies = runtimeDependencies): Promise<void> {
  console.log(`Checking TOAS: ${TOAS_URL}`);
  console.log(`Time: ${new Date().toISOString()}`);

  const html = await deps.fetchPage();
  const tables = await deps.parseMonitoredTables(html);
  const state = buildState(tables);
  const currentHash = await stateHash(state);
  console.log(`Apartment tables: ${tables.length}; listings: ${tables.reduce((sum, t) => sum + t.rows.length, 0)}`);
  const previousHash = await getPreviousStateHash(env);
  const changed = previousHash !== null && previousHash !== currentHash;
  const mikontaloPresent = containsMikontalo(state);

  console.log(`Previous hash: ${previousHash}`);
  console.log(`Current hash:  ${currentHash}`);
  console.log(`Changed:       ${changed}`);
  console.log(`Mikontalo:     ${mikontaloPresent}`);

  if (changed) {
    let message = "TOAS ALERT — monitored content changed";
    if (mikontaloPresent) message += "; Mikontalo is present";
    message += `\n\n${formatState(state)}`;
    await deps.sendTelegram(env, message);
    console.log("Sent alert notification.");
  } else {
    console.log(
      "TOAS monitor ran successfully; no changes found." +
        (mikontaloPresent ? " Mikontalo is present." : ""),
    );
  }

  // The prior hash must survive HTTP, HTML-parsing, or Telegram failures.
  await saveStateHash(env, currentHash, tables);
}
