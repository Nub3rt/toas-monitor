import { TELEGRAM_API } from "./constants.ts";
import type { Env } from "./types.ts";

export async function sendTelegram(env: Env, message: string): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is not configured");
  if (!env.TELEGRAM_CHAT_ID) throw new Error("TELEGRAM_CHAT_ID is not configured");

  const response = await fetch(`${TELEGRAM_API}/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: env.TELEGRAM_CHAT_ID,
      text: message,
      disable_web_page_preview: true,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Telegram returned HTTP ${response.status}: ${body.slice(0, 500)}`);
  }
}

export async function sendErrorNotification(env: Env, error: unknown): Promise<void> {
  const description = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const message =
    `TOAS MONITOR ERROR\n\n` +
    `Time: ${new Date().toISOString()}\n` +
    `Error: ${description}\n\n` +
    "The previous saved state was NOT overwritten.";

  try {
    await sendTelegram(env, message);
  } catch (notificationError) {
    console.error("Could not send error notification:", notificationError);
  }
}
