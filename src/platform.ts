import { spawnSync } from "node:child_process";

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function commandExists(command: string): boolean {
  if (command.includes("/") && spawnSync("test", ["-x", command]).status === 0) return true;
  return spawnSync("/bin/sh", ["-lc", `command -v ${shellQuote(command)}`], { encoding: "utf8" }).status === 0;
}
