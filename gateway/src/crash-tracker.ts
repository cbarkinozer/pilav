import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PILAV_DIR = join(homedir(), ".pilav");
const CRASH_FILE = join(PILAV_DIR, "crashes.json");
const CLEAN_MARKER = join(PILAV_DIR, "clean-shutdown");

export function markCleanShutdown(): void {
  try {
    mkdirSync(PILAV_DIR, { recursive: true });
    writeFileSync(CLEAN_MARKER, String(Date.now()), "utf-8");
  } catch {}
}

/** Returns true if the previous run exited cleanly (SIGTERM/SIGINT). Clears the marker. */
export function consumeCleanShutdownMarker(): boolean {
  try {
    if (existsSync(CLEAN_MARKER)) {
      unlinkSync(CLEAN_MARKER);
      return true;
    }
  } catch {}
  return false;
}

export function recordCrash(): void {
  const now = Date.now();
  const crashes = loadCrashes().filter((t) => t > now - 60 * 60 * 1000); // keep 1h
  crashes.push(now);
  saveCrashes(crashes);
}

export function recentCrashCount(windowMs = 5 * 60 * 1000): number {
  const cutoff = Date.now() - windowMs;
  return loadCrashes().filter((t) => t > cutoff).length;
}

export function clearCrashes(): void {
  try { unlinkSync(CRASH_FILE); } catch {}
}

function loadCrashes(): number[] {
  try {
    if (existsSync(CRASH_FILE)) return JSON.parse(readFileSync(CRASH_FILE, "utf-8")) as number[];
  } catch {}
  return [];
}

function saveCrashes(crashes: number[]): void {
  try {
    mkdirSync(PILAV_DIR, { recursive: true });
    writeFileSync(CRASH_FILE, JSON.stringify(crashes), "utf-8");
  } catch {}
}
