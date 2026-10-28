import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createAsk, createJobs, saveUpload } from "./server/ask.ts";
import { resolveBin, runLines } from "./server/exec.ts";
import { askPoll, askStart, askSteer, askStop, askUpload } from "./shared/ask.ts";

export default function contribute(server: PluginServerContext) {
  const asker = createAsk(runLines, resolveBin("claude"));
  const jobs = createJobs(asker.ask);
  server.handle(askStart, (input) => jobs.start(input));
  server.handle(askPoll, (input) => jobs.poll(input));
  server.handle(askSteer, (input) => jobs.steer(input));
  server.handle(askStop, (input) => jobs.stop(input));
  server.handle(askUpload, (input) => saveUpload(input));
  return asker.dispose;
}
