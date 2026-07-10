import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PENDING_PATH = join(homedir(), ".pilav", "pending-resumes.json");

export interface PendingResume {
  name: string;
  task: string;
  chatId: number;
  cwd: string | null;
  claudeSessionId: string | null;
  savedAt: number;
}

export function savePendingResumes(sessions: PendingResume[]): void {
  mkdirSync(join(homedir(), ".pilav"), { recursive: true });
  writeFileSync(PENDING_PATH, JSON.stringify(sessions, null, 2), "utf-8");
}

export function loadPendingResumes(): PendingResume[] {
  try {
    if (existsSync(PENDING_PATH)) {
      return JSON.parse(readFileSync(PENDING_PATH, "utf-8")) as PendingResume[];
    }
  } catch {}
  return [];
}

export function clearPendingResumes(): void {
  try { unlinkSync(PENDING_PATH); } catch {}
}
