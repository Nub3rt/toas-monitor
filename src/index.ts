import { checkToas } from "./monitor.ts";
import { sendErrorNotification } from "./telegram.ts";
import type { Env } from "./types.ts";

export default {
  async scheduled(_event: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    try {
      await checkToas(env);
    } catch (error) {
      console.error("TOAS monitor failed:", error);
      await sendErrorNotification(env, error);
      throw error; // Also record the cron invocation as failed in Cloudflare.
    }
  },
} satisfies ExportedHandler<Env>;
