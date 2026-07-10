/**
 * SQLite action trace store.
 * Records every Claude Code session and each event within it.
 * This is the training data for future SFT / distillation of Pilav's own model.
 */
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface SessionRecord {
  sessionId: string;
  task: string;
  startedAt: number;
  telegramChatId: number | null;
  permissionMode: string;
  allowedTools: string[] | null;
  pilotDecision: PilotDecision | null;
  /** User-given name for this session (e.g. "btmotor") */
  name?: string;
}

export interface PilotDecision {
  safe: boolean;
  reasoning: string;
  allowedTools: string[];
  permissionMode: string;
}

export interface TraceEvent {
  sessionId: string;
  timestamp: number;
  eventType: string;
  eventData: unknown;
  sequenceNumber: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS claude_sessions (
  session_id     TEXT    PRIMARY KEY,
  task           TEXT    NOT NULL,
  started_at     INTEGER NOT NULL,
  ended_at       INTEGER,
  status         TEXT    NOT NULL DEFAULT 'running',
  telegram_chat_id INTEGER,
  permission_mode TEXT,
  allowed_tools  TEXT,
  pilot_decision TEXT
);

CREATE TABLE IF NOT EXISTS action_traces (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id      TEXT    NOT NULL,
  timestamp       INTEGER NOT NULL,
  event_type      TEXT    NOT NULL,
  event_data      TEXT    NOT NULL,
  sequence_number INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_traces_session
  ON action_traces(session_id, sequence_number);
`;

export class ActionStore {
  private db: Database.Database;

  constructor(dbPath?: string) {
    const dir = join(homedir(), ".pilav");
    mkdirSync(dir, { recursive: true });
    const path = dbPath ?? join(dir, "pilav.db");
    this.db = new Database(path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(SCHEMA);
    // Migrations — safe to run on existing DBs
    for (const col of [
      "ALTER TABLE claude_sessions ADD COLUMN claude_session_id TEXT",
      "ALTER TABLE claude_sessions ADD COLUMN name TEXT",
    ]) {
      try { this.db.exec(col); } catch { /* column already exists */ }
    }
  }

  startSession(rec: SessionRecord): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO claude_sessions
        (session_id, task, started_at, status, telegram_chat_id, permission_mode, allowed_tools, pilot_decision, name)
      VALUES (?, ?, ?, 'running', ?, ?, ?, ?, ?)
    `);
    stmt.run(
      rec.sessionId,
      rec.task,
      rec.startedAt,
      rec.telegramChatId,
      rec.permissionMode,
      rec.allowedTools ? JSON.stringify(rec.allowedTools) : null,
      rec.pilotDecision ? JSON.stringify(rec.pilotDecision) : null,
      rec.name ?? null,
    );
  }

  setClaudeSessionId(sessionId: string, claudeSessionId: string): void {
    this.db.prepare("UPDATE claude_sessions SET claude_session_id = ? WHERE session_id = ?")
      .run(claudeSessionId, sessionId);
  }

  logEvent(sessionId: string, eventType: string, eventData: unknown, sequenceNumber: number): void {
    const stmt = this.db.prepare(`
      INSERT INTO action_traces (session_id, timestamp, event_type, event_data, sequence_number)
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(sessionId, Date.now(), eventType, JSON.stringify(eventData), sequenceNumber);
  }

  endSession(sessionId: string, status: "completed" | "error" | "cancelled"): void {
    const stmt = this.db.prepare(`
      UPDATE claude_sessions SET ended_at = ?, status = ? WHERE session_id = ?
    `);
    stmt.run(Date.now(), status, sessionId);
  }

  getSessionTrace(sessionId: string): TraceEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM action_traces WHERE session_id = ? ORDER BY sequence_number")
      .all(sessionId) as Array<{
        session_id: string;
        timestamp: number;
        event_type: string;
        event_data: string;
        sequence_number: number;
      }>;
    return rows.map((r) => ({
      sessionId: r.session_id,
      timestamp: r.timestamp,
      eventType: r.event_type,
      eventData: JSON.parse(r.event_data) as unknown,
      sequenceNumber: r.sequence_number,
    }));
  }

  sessionCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM claude_sessions").get() as { count: number };
    return row.count;
  }

  recentSessions(limit = 10): Array<{
    sessionId: string;
    task: string;
    status: string;
    startedAt: number;
    claudeSessionId: string | null;
    name: string | null;
  }> {
    return (this.db
      .prepare("SELECT session_id, task, status, started_at, claude_session_id, name FROM claude_sessions ORDER BY started_at DESC LIMIT ?")
      .all(limit) as Array<{ session_id: string; task: string; status: string; started_at: number; claude_session_id: string | null; name: string | null }>)
      .map((r) => ({
        sessionId: r.session_id,
        task: r.task,
        status: r.status,
        startedAt: r.started_at,
        claudeSessionId: r.claude_session_id,
        name: r.name,
      }));
  }

  close(): void {
    this.db.close();
  }
}
