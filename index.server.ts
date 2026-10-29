import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import { createAsk, createJobs, saveUpload } from "./server/ask.ts";
import { resolveBin, runLines } from "./server/exec.ts";
import { agentContext } from "./shared/context.ts";
import { askPoll, askStart, askSteer, askStop, askUpload } from "./shared/ask.ts";

export default function contribute(server: PluginServerContext) {
  const asker = createAsk(runLines, resolveBin("claude"));
  const jobs = createJobs(asker.ask);
  server.handle(askStart, async ({ agentId, ...input }, { paseo }) => jobs.start({ ...input, context: agentId ? await parentChat(paseo, agentId) : undefined }));
  server.handle(askPoll, (input) => jobs.poll(input));
  server.handle(askSteer, (input) => jobs.steer(input));
  server.handle(askStop, (input) => jobs.stop(input));
  server.handle(askUpload, (input) => saveUpload(input));
  return asker.dispose;
}

// 200 timeline items hold ~50 messages. A failed fetch (agent archived, other daemon) only drops the context.
async function parentChat(paseo: PluginHandlerContext["paseo"], agentId: string) {
  try {
    const t = await paseo.agents.ref(agentId).timeline.refetch({ direction: "tail", limit: 200, projection: "canonical" });
    return agentContext(t.entries, t.agent?.cwd);
  } catch (err) {
    console.error("[paseo-ask] parent chat:", err);
    return "";
  }
}
