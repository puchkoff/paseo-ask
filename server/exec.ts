import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface RunOptions {
  timeoutMs: number;
  input?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export type RunCommand = (file: string, args: readonly string[], options: RunOptions) => Promise<string>;

// Some CLIs (claude -p --output-format json) print the reason for a failure on stdout, not stderr.
export class CommandError extends Error {
  readonly stdout: string;
  constructor(message: string, stdout: string) {
    super(message);
    this.stdout = stdout;
  }
}

// Resolves stdout; rejects with the first stderr line so callers can show it as-is.
export const runCommand: RunCommand = (file, args, { timeoutMs, input, cwd, env }) =>
  new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${path.basename(file)} timed out after ${Math.round(timeoutMs / 1000)} s`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new CommandError(stderr.trim().split("\n")[0] || `${path.basename(file)} exited with code ${code}`, stdout));
    });
    child.stdin.end(input ?? "");
  });

// The daemon's PATH can be stripped (no ~/.local/bin, no npm-global), so look in the usual places first.
export function resolveBin(name: string, exists: (p: string) => boolean = existsSync, home = os.homedir()): string {
  const dirs = ["/usr/bin", "/usr/local/bin", "/opt/homebrew/bin", path.join(home, ".local/bin"), path.join(home, ".npm-global/bin")];
  return dirs.map((d) => path.join(d, name)).find(exists) ?? name;
}

export function firstLine(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return (message.split("\n")[0] || "unknown error").slice(0, 200);
}
