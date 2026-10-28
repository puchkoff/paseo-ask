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

// The daemon's PATH can be stripped (no ~/.local/bin, no npm-global), so look in the usual places first.
export function resolveBin(name: string, exists: (p: string) => boolean = existsSync, home = os.homedir()): string {
  const dirs = ["/usr/bin", "/usr/local/bin", "/opt/homebrew/bin", path.join(home, ".local/bin"), path.join(home, ".npm-global/bin")];
  return dirs.map((d) => path.join(d, name)).find(exists) ?? name;
}


// Streams stdout line by line (claude -p --output-format stream-json); resolves with the exit code.
export type RunLines = (
  file: string,
  args: readonly string[],
  // onStdin: keep stdin open after input and hand the caller a writer (stream-json input).
  options: RunOptions & { onLine: (line: string) => void; onStdin?: (io: { write(s: string): void; end(): void; kill(): void }) => void },
) => Promise<{ code: number | null; stderr: string }>;

export const runLines: RunLines = (file, args, { timeoutMs, input, cwd, env, onLine, onStdin }) =>
  new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let buf = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${path.basename(file)} timed out after ${Math.round(timeoutMs / 1000)} s`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        onLine(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    });
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (buf) onLine(buf);
      resolve({ code, stderr });
    });
    if (!onStdin) return void child.stdin.end(input ?? "");
    child.stdin.write(input ?? "");
    onStdin({ write: (s) => void child.stdin.write(s), end: () => child.stdin.end(), kill: () => void child.kill("SIGTERM") });
  });
