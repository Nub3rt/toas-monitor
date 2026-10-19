import { MONITORED_HEADING } from "./constants.ts";
import type { TableData } from "./types.ts";

export function normalizeText(value: string): string {
  return value.replace(/\u00a0/g, " ").replace(/\s+/gu, " ").trim();
}

class TextCollector {
  private readonly nodes: string[] = [];
  private pending = "";

  add(chunk: Text): void {
    this.pending += chunk.text;
    if (chunk.lastInTextNode) {
      this.flush();
    }
  }

  finish(): string {
    this.flush();
    return normalizeText(this.nodes.join(" "));
  }

  private flush(): void {
    if (this.pending) {
      const text = normalizeText(this.pending);
      if (text) this.nodes.push(text);
      this.pending = "";
    }
  }
}

interface TableCapture {
  rawRows: string[][];
}

interface RowCapture {
  table: TableCapture;
  cells: string[];
}

export function parseTableRows(rawRows: string[][]): TableData {
  const rows = rawRows.filter((row) => row.some(Boolean));
  if (rows.length === 0) return { headers: [], rows: [] };

  const [headers, ...dataRows] = rows;
  const width = headers.length;
  return {
    headers,
    rows: dataRows.map((row) =>
      row.length < width
        ? [...row, ...Array<string>(width - row.length).fill("")]
        : row.slice(0, width),
    ),
  };
}

export async function parseMonitoredTables(html: string): Promise<TableData[]> {
  const parsedTables: TableData[] = [];
  const headingStack: TextCollector[] = [];
  const tableStack: TableCapture[] = [];
  const rowStack: RowCapture[] = [];
  const cellStack: TextCollector[] = [];
  let foundHeading = false;

  const headingHandler: HTMLRewriterElementContentHandlers = {
    element(element) {
      const collector = new TextCollector();
      headingStack.push(collector);
      element.onEndTag(() => {
        headingStack.pop();
        if (collector.finish().toLowerCase() === MONITORED_HEADING.toLowerCase()) {
          foundHeading = true;
        }
      });
    },
    text(chunk) {
      headingStack.at(-1)?.add(chunk);
    },
  };

  const cellHandler: HTMLRewriterElementContentHandlers = {
    element(element) {
      const row = rowStack.at(-1);
      if (!row || row.table !== tableStack.at(-1)) return;
      const collector = new TextCollector();
      const index = row.cells.push("") - 1;
      cellStack.push(collector);
      element.onEndTag(() => {
        row.cells[index] = collector.finish();
        cellStack.pop();
      });
    },
    text(chunk) {
      cellStack.at(-1)?.add(chunk);
    },
  };

  // HTMLRewriter supports simple selectors; register each tag independently.
  const transformed = new HTMLRewriter()
    .on("h1", headingHandler)
    .on("h2", headingHandler)
    .on("h3", headingHandler)
    .on("h4", headingHandler)
    .on("table", {
      element(element) {
        // Store a placeholder at the opening tag to preserve document order.
        if (!foundHeading || parsedTables.length === 2) return;
        const table: TableCapture = { rawRows: [] };
        const index = parsedTables.push({ headers: [], rows: [] }) - 1;
        tableStack.push(table);
        element.onEndTag(() => {
          parsedTables[index] = parseTableRows(table.rawRows);
          tableStack.pop();
        });
      },
    })
    .on("tr", {
      element(element) {
        const table = tableStack.at(-1);
        if (!table) return;
        const row: RowCapture = { table, cells: [] };
        rowStack.push(row);
        element.onEndTag(() => {
          rowStack.pop();
          if (row.cells.some(Boolean)) {
            row.table.rawRows.push(row.cells);
          }
        });
      },
    })
    .on("th", cellHandler)
    .on("td", cellHandler)
    .transform(new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } }));

  // HTMLRewriter is streaming/lazy: consume the response to run handlers.
  await transformed.text();
  return parsedTables;
}
