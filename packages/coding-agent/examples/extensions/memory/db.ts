import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const connections = new Map<string, DatabaseSync>();

function resolvePath(dbPath?: string): string {
	if (dbPath) return dbPath;
	if (process.env.DB_PATH) return process.env.DB_PATH;
	if (process.env.PI_MEMORY_PATH) return process.env.PI_MEMORY_PATH;
	const dir = join(homedir(), ".pi", "agent");
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	return join(dir, "memory.db");
}

function openDb(path: string): DatabaseSync {
	let db = connections.get(path);
	if (!db) {
		if (path === ":memory:") {
			db = new DatabaseSync(":memory:");
		} else {
			db = new DatabaseSync(path);
			db.exec("PRAGMA journal_mode=WAL");
		}
		connections.set(path, db);
	}
	return db;
}

function ensureSchema(db: DatabaseSync): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS exchanges (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			session_id TEXT NOT NULL,
			user_prompt TEXT NOT NULL,
			assistant_reply TEXT NOT NULL,
			created_at TEXT DEFAULT (datetime('now'))
		);
		CREATE VIRTUAL TABLE IF NOT EXISTS exchanges_fts USING fts5(
			user_prompt, assistant_reply,
			content='exchanges',
			content_rowid='id',
			tokenize='porter'
		);
		CREATE TRIGGER IF NOT EXISTS exchanges_ai AFTER INSERT ON exchanges BEGIN
			INSERT INTO exchanges_fts(rowid, user_prompt, assistant_reply)
			VALUES (new.id, new.user_prompt, new.assistant_reply);
		END;
		CREATE TABLE IF NOT EXISTS profile (
			key TEXT PRIMARY KEY,
			value TEXT NOT NULL
		);
	`);
}

export function initDb(dbPath?: string): void {
	const path = resolvePath(dbPath);
	const db = openDb(path);
	ensureSchema(db);
}

export function insertExchange(sessionId: string, userPrompt: string, assistantReply: string, dbPath?: string): void {
	const path = resolvePath(dbPath);
	const db = openDb(path);
	ensureSchema(db);
	db.prepare("INSERT INTO exchanges(session_id, user_prompt, assistant_reply) VALUES(?, ?, ?)").run(
		sessionId,
		userPrompt,
		assistantReply,
	);
}

export function searchExchanges(
	query: string,
	limit: number,
	dbPath?: string,
): Array<{
	session_id: string;
	user_prompt: string;
	assistant_reply: string;
}> {
	if (!query || query.trim() === "") return [];

	const path = resolvePath(dbPath);
	const db = openDb(path);
	ensureSchema(db);

	return db
		.prepare(
			"SELECT e.session_id, e.user_prompt, e.assistant_reply " +
				"FROM exchanges e " +
				"JOIN exchanges_fts f ON e.id = f.rowid " +
				"WHERE exchanges_fts MATCH ? " +
				"ORDER BY e.id DESC " +
				"LIMIT ?",
		)
		.all(query, limit) as Array<{
		session_id: string;
		user_prompt: string;
		assistant_reply: string;
	}>;
}

export function getRecentExchanges(
	limit: number,
	dbPath?: string,
): Array<{
	session_id: string;
	user_prompt: string;
	assistant_reply: string;
}> {
	const path = resolvePath(dbPath);
	const db = openDb(path);
	ensureSchema(db);

	return db
		.prepare("SELECT session_id, user_prompt, assistant_reply FROM exchanges ORDER BY id DESC LIMIT ?")
		.all(limit) as Array<{
		session_id: string;
		user_prompt: string;
		assistant_reply: string;
	}>;
}

export function setProfile(key: string, value: string, dbPath?: string): void {
	const path = resolvePath(dbPath);
	const db = openDb(path);
	ensureSchema(db);
	db.prepare("INSERT OR REPLACE INTO profile(key, value) VALUES(?, ?)").run(key, value);
}

export function getProfile(key: string, dbPath?: string): string | undefined {
	const path = resolvePath(dbPath);
	const db = openDb(path);
	ensureSchema(db);
	const rows = db.prepare("SELECT value FROM profile WHERE key = ?").all(key) as Array<{ value: string }>;
	return rows.length > 0 ? rows[0].value : undefined;
}
