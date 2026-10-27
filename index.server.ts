import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createAsk } from "./server/ask.ts";
import { resolveBin, runCommand } from "./server/exec.ts";
import { ask } from "./shared/ask.ts";

export default function contribute(server: PluginServerContext) {
  const claude = resolveBin("claude");
  const handler = createAsk(runCommand, claude);
  server.handle(ask, async (input) => {
    try {
      return await handler(input);
    } catch (err) {
      console.error(`[paseo-floating-window] ask failed (claude=${claude}):`, err);
      throw err;
    }
  });
  return () => {};
}
