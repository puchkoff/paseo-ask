import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createAsk, createJobs } from "./server/ask.ts";
import { resolveBin, runCommand } from "./server/exec.ts";
import { askPoll, askStart } from "./shared/ask.ts";

export default function contribute(server: PluginServerContext) {
  const jobs = createJobs(createAsk(runCommand, resolveBin("claude")));
  server.handle(askStart, (input) => jobs.start(input));
  server.handle(askPoll, (input) => jobs.poll(input));
  return () => {};
}
