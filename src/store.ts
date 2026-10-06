import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { AvlMultiset, UpdateLog, AvlError, checkStructure } from "./avl";

export interface OpInput { op: "insert" | "delete"; key: number; }

export class Store {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS versions (
        set_id INTEGER NOT NULL,
        version INTEGER NOT NULL,
        snapshot TEXT NOT NULL,
        PRIMARY KEY (set_id, version)
      );
      CREATE TABLE IF NOT EXISTS logs (
        set_id INTEGER NOT NULL,
        version INTEGER NOT NULL,
        log TEXT NOT NULL,
        PRIMARY KEY (set_id, version)
      );
      CREATE TABLE IF NOT EXISTS requests (
        set_id INTEGER NOT NULL,
        request_id TEXT NOT NULL,
        response TEXT NOT NULL,
        PRIMARY KEY (set_id, request_id)
      );
    `);
  }

  close(): void { this.db.close(); }

  createSet(name: string): number {
    const r = this.db.prepare("INSERT INTO sets (name) VALUES (?)").run(name);
    const id = Number(r.lastInsertRowid);
    const t = new AvlMultiset();
    this.db.prepare("INSERT INTO versions (set_id, version, snapshot) VALUES (?,?,?)").run(id, 0, JSON.stringify(t.toJSON()));
    return id;
  }

  listSets(): unknown[] {
    return this.db.prepare("SELECT id, name, created_at FROM sets ORDER BY id").all();
  }

  private requireSet(setId: number): void {
    if (!this.db.prepare("SELECT id FROM sets WHERE id=?").get(setId)) throw new AvlError("SET_NOT_FOUND", `集合 ${setId} 不存在`);
  }

  load(setId: number): AvlMultiset {
    this.requireSet(setId);
    const row = this.db.prepare("SELECT snapshot FROM versions WHERE set_id=? ORDER BY version DESC LIMIT 1").get(setId) as any;
    return AvlMultiset.fromJSON(JSON.parse(row.snapshot));
  }

  treeAt(setId: number, version?: number): unknown {
    this.requireSet(setId);
    const row = version === undefined
      ? this.db.prepare("SELECT snapshot FROM versions WHERE set_id=? ORDER BY version DESC LIMIT 1").get(setId) as any
      : this.db.prepare("SELECT snapshot FROM versions WHERE set_id=? AND version=?").get(setId, version) as any;
    if (!row) throw new AvlError("VERSION_NOT_FOUND", `集合 ${setId} 没有版本 ${version}`);
    return JSON.parse(row.snapshot);
  }

  apply(setId: number, ops: OpInput[], requestId?: string): { logs: UpdateLog[]; version: number; duplicate: boolean } {
    this.requireSet(setId);
    if (!Array.isArray(ops) || ops.length === 0) throw new AvlError("EMPTY_BATCH", "批量操作不能为空");
    if (ops.length > 10000) throw new AvlError("BATCH_TOO_LARGE", "单批最多 10000 个操作");
    for (const [i, o] of ops.entries()) {
      if (!o || (o.op !== "insert" && o.op !== "delete")) throw new AvlError("INVALID_OP", `第 ${i} 个操作非法: ${JSON.stringify(o)}`);
      AvlMultiset.validateKey(o.key);
    }
    if (requestId !== undefined) {
      if (typeof requestId !== "string" || requestId.length === 0 || requestId.length > 128) throw new AvlError("INVALID_REQUEST_ID", "requestId 必须是 1-128 字符的字符串");
      const dup = this.db.prepare("SELECT response FROM requests WHERE set_id=? AND request_id=?").get(setId, requestId) as any;
      if (dup) return { ...(JSON.parse(dup.response)), duplicate: true };
    }
    const tree = this.load(setId);
    const logs: UpdateLog[] = [];
    this.db.exec("BEGIN");
    try {
      for (const o of ops) {
        const log = o.op === "insert" ? tree.insert(o.key) : tree.delete(o.key);
        logs.push(log);
        if (log.found) {
          this.db.prepare("INSERT INTO versions (set_id, version, snapshot) VALUES (?,?,?)").run(setId, log.version, JSON.stringify(tree.toJSON()));
          this.db.prepare("INSERT INTO logs (set_id, version, log) VALUES (?,?,?)").run(setId, log.version, JSON.stringify(log));
        }
      }
      const result = { logs, version: tree.version, duplicate: false };
      if (requestId !== undefined) {
        this.db.prepare("INSERT INTO requests (set_id, request_id, response) VALUES (?,?,?)").run(setId, requestId, JSON.stringify(result));
      }
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  logs(setId: number, page = 1, size = 20): { total: number; page: number; size: number; items: UpdateLog[] } {
    this.requireSet(setId);
    size = Math.min(Math.max(1, size), 200);
    page = Math.max(1, page);
    const total = (this.db.prepare("SELECT COUNT(*) c FROM logs WHERE set_id=?").get(setId) as any).c as number;
    const rows = this.db.prepare("SELECT log FROM logs WHERE set_id=? ORDER BY version DESC LIMIT ? OFFSET ?").all(setId, size, (page - 1) * size) as any[];
    return { total, page, size, items: rows.map(r => JSON.parse(r.log)) };
  }

  exportAll(setId: number): unknown {
    this.requireSet(setId);
    const meta = this.db.prepare("SELECT * FROM sets WHERE id=?").get(setId);
    const versions = (this.db.prepare("SELECT version FROM versions WHERE set_id=? ORDER BY version").all(setId) as any[]).map(r => r.version);
    const logs = (this.db.prepare("SELECT log FROM logs WHERE set_id=? ORDER BY version").all(setId) as any[]).map(r => JSON.parse(r.log));
    const tree = this.load(setId);
    return { meta, versions, logs, current: tree.toJSON(), check: checkStructure(tree) };
  }
}
