import { TOAS_URL } from "./constants.ts";
import type { MonitorState, TableData } from "./types.ts";

export function formatTable(table: TableData, tableNumber: number): string {
  const { headers, rows } = table;
  if (headers.length === 0) return `Table ${tableNumber}: empty`;

  const lines = [`\nTable ${tableNumber} (${rows.length} listings):`];
  if (rows.length === 0) {
    lines.push(`${headers.join(" | ")} | [no apartments]`);
    return lines.join("\n");
  }
  for (const row of rows) lines.push(row.slice(0, 2).join(" | "));
  return lines.join("\n\n");
}

export function formatState(state: MonitorState): string {
  const parts = ["TOAS quickly available", "", `URL: ${TOAS_URL}`, ""];
  if (state.tables.length === 0) {
    parts.push("No flats available.");
    return parts.join("\n").trim();
  }
  state.tables.forEach((table, index) => {
    parts.push(formatTable(table, index + 1), "");
  });
  return parts.join("\n").trim();
}
