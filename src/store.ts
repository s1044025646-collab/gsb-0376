// SQLite 持久化: 操作日志 + 每版本快照, 重启后可恢复并继续更新。
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { OpLog } from './avl';

export class Store {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS sets (
        id TEXT PRIMARY KEY,
        name TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS snapshots (
        set_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        data TEXT NOT NULL,
        PRIMARY KEY (set_id, version)
      );
      CREATE TABLE IF NOT EXISTS logs (
        set_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        data TEXT NOT NULL,
        PRIMARY KEY (set_id, version)
      );
      CREATE TABLE IF NOT EXISTS requests (
        set_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        response TEXT NOT NULL,
        PRIMARY KEY (set_id, request_id)
      );
    `);
  }

  createSet(id: string, name: string): void {
    this.db.prepare('INSERT INTO sets (id, name) VALUES (?, ?)').run(id, name);
  }

  listSets(): { id: string; name: string }[] {
    return this.db.prepare('SELECT id, name FROM sets ORDER BY created_at').all() as any;
  }

  hasSet(id: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM sets WHERE id = ?').get(id);
  }

  saveSnapshot(setId: string, version: number, data: string): void {
    this.db.prepare('INSERT OR REPLACE INTO snapshots (set_id, version, data) VALUES (?, ?, ?)').run(setId, version, data);
  }

  loadSnapshot(setId: string, version?: number): string | null {
    const row = version === undefined
      ? this.db.prepare('SELECT data FROM snapshots WHERE set_id = ? ORDER BY version DESC LIMIT 1').get(setId)
      : this.db.prepare('SELECT data FROM snapshots WHERE set_id = ? AND version = ?').get(setId, version);
    return row ? (row as any).data : null;
  }

  appendLog(setId: string, log: OpLog): void {
    this.db.prepare('INSERT OR REPLACE INTO logs (set_id, version, data) VALUES (?, ?, ?)').run(setId, log.version, JSON.stringify(log));
  }

  getLogs(setId: string, offset: number, limit: number): { total: number; logs: OpLog[] } {
    const total = (this.db.prepare('SELECT COUNT(*) c FROM logs WHERE set_id = ?').get(setId) as any).c as number;
    const rows = this.db.prepare('SELECT data FROM logs WHERE set_id = ? ORDER BY version LIMIT ? OFFSET ?').all(setId, limit, offset);
    return { total, logs: rows.map((r: any) => JSON.parse(r.data)) };
  }

  getRequest(setId: string, requestId: string): string | null {
    const row = this.db.prepare('SELECT response FROM requests WHERE set_id = ? AND request_id = ?').get(setId, requestId);
    return row ? (row as any).response : null;
  }

  saveRequest(setId: string, requestId: string, response: string): void {
    this.db.prepare('INSERT OR IGNORE INTO requests (set_id, request_id, response) VALUES (?, ?, ?)').run(setId, requestId, response);
  }

  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  close(): void { this.db.close(); }
}
