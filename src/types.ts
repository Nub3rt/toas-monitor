export interface TableData {
  headers: string[];
  rows: string[][];
}

export interface MonitorState {
  heading: string;
  tables: TableData[];
}

export interface Env {
  TOAS_STATE: KVNamespace;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID: string;
}
