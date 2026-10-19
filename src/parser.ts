import type { TableData } from "./types.ts";

export function normalizeText(value: string): string {
  return value.replace(/\u00a0/g, " ").replace(/\s+/gu, " ").trim();
}

class TextCollector {
  private readonly nodes: string[] = [];
  private pending = "";

  add(chunk: Text): void {
    this.pending += chunk.text;
    if (chunk.lastInTextNode) this.flush();
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

export function isApartmentTable(table: TableData): boolean {
  const headers = table.headers.map((header) => normalizeText(header).toLowerCase());
  return (
    headers.length >= 3 &&
    headers.some((header) => /\b(location|address|property)\b/u.test(header)) &&
    headers.some((header) => /\b(apartment|flat|room|type)\b/u.test(header)) &&
    headers.some((header) => /\b(rent|month)\b|€/u.test(header))
  );
}

export async function parseMonitoredTables(html: string): Promise<TableData[]> {
  const foundTables: TableData[] = [];
  const tableStack: TableCapture[] = [];
  const rowStack: RowCapture[] = [];
  const cellStack: TextCollector[] = [];
  const titleStack: TextCollector[] = [];
  let title = "";

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

  const transformed = new HTMLRewriter()
    .on("title", {
      element(element) {
        const collector = new TextCollector();
        titleStack.push(collector);
        element.onEndTag(() => {
          title = collector.finish();
          titleStack.pop();
        });
      },
      text(chunk) {
        titleStack.at(-1)?.add(chunk);
      },
    })
    .on("table", {
      element(element) {
        const table: TableCapture = { rawRows: [] };
        tableStack.push(table);
        element.onEndTag(() => {
          foundTables.push(parseTableRows(table.rawRows));
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
          if (row.cells.some(Boolean)) row.table.rawRows.push(row.cells);
        });
      },
    })
    .on("th", cellHandler)
    .on("td", cellHandler)
    .transform(new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } }));

  // HTMLRewriter is lazy; consuming the transformed response runs the handlers.
  await transformed.text();

  if (!title.toLowerCase().includes("quickly available") || !title.toLowerCase().includes("toas")) {
    throw new Error(`Unexpected TOAS page title: ${JSON.stringify(title)}`);
  }

  const apartments = foundTables.filter(isApartmentTable);
  if (foundTables.length > 0 && apartments.length === 0) {
    throw new Error("Found HTML tables, but none matched the TOAS apartment listing columns");
  }
  return apartments;
}
