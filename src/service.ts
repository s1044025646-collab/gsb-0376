// 集合管理服务: 内存树 + SQLite 持久化, 批量事务与幂等。
import { AvlMultiset, AvlError, OpLog, validateKey } from './avl';
import { Store } from './store';
import { randomUUID } from 'node:crypto';

export interface BatchOp { op: 'insert' | 'delete'; key: unknown }

export class SetService {
  private store: Store;
  private trees = new Map<string, AvlMultiset>();
  readonly maxNodes: number;

  constructor(store: Store, maxNodes = 100000) {
    this.store = store;
    this.maxNodes = maxNodes;
  }

  createSet(name?: string): { setId: string; name: string } {
    const setId = randomUUID().slice(0, 8);
    const setName = name || `set-${setId}`;
    this.store.createSet(setId, setName);
    const tree = new AvlMultiset(this.maxNodes);
    tree.setLogSink((log) => this.persist(setId, tree, log));
    this.trees.set(setId, tree);
    this.store.saveSnapshot(setId, 0, tree.serialize());
    return { setId, name: setName };
  }

  private getTree(setId: string): AvlMultiset {
    let t = this.trees.get(setId);
    if (t) return t;
    if (!this.store.hasSet(setId)) throw new AvlError('SET_NOT_FOUND', `集合 ${setId} 不存在`);
    const snap = this.store.loadSnapshot(setId);
    t = snap ? AvlMultiset.deserialize(snap, this.maxNodes) : new AvlMultiset(this.maxNodes);
    t.setLogSink((log) => this.persist(setId, t!, log));
    this.trees.set(setId, t);
    return t;
  }

  private persist(setId: string, tree: AvlMultiset, log: OpLog): void {
    this.store.appendLog(setId, log);
    this.store.saveSnapshot(setId, log.version, tree.serialize());
  }

  insert(setId: string, key: unknown): OpLog {
    const tree = this.getTree(setId);
    return this.store.tx(() => tree.insert(validateKey(key)));
  }

  delete(setId: string, key: unknown): OpLog {
    const tree = this.getTree(setId);
    return this.store.tx(() => tree.delete(validateKey(key)));
  }

  batch(setId: string, requestId: unknown, ops: unknown): { version: number; results: OpLog[]; duplicate: boolean } {
    if (typeof requestId !== 'string' || !requestId) throw new AvlError('INVALID_REQUEST', 'requestId 必须为非空字符串');
    if (!Array.isArray(ops) || ops.length === 0) throw new AvlError('INVALID_BATCH', 'ops 必须为非空数组');
    if (ops.length > 10000) throw new AvlError('INVALID_BATCH', '单批操作数超过 10000');
    const tree = this.getTree(setId);
    const cached = this.store.getRequest(setId, requestId);
    if (cached) return { ...JSON.parse(cached), duplicate: true };

    // 先校验全部参数, 任一非法整批拒绝
    const parsed = (ops as BatchOp[]).map((o, i) => {
      if (!o || (o.op !== 'insert' && o.op !== 'delete')) {
        throw new AvlError('INVALID_OP', `第 ${i} 项 op 必须为 insert 或 delete`);
      }
      return { op: o.op, key: validateKey(o.key) };
    });

    const results: OpLog[] = [];
    // 内存操作 + 持久化同事务; 失败则回滚数据库并重建内存树
    const startVersion = tree.version;
    try {
      const response = this.store.tx(() => {
        for (const p of parsed) {
          results.push(p.op === 'insert' ? tree.insert(p.key) : tree.delete(p.key));
        }
        const res = { version: tree.version, results };
        this.store.saveRequest(setId, requestId, JSON.stringify({ version: res.version, results }));
        return res;
      });
      return { ...response, duplicate: false };
    } catch (e) {
      // 回滚内存状态: 从起始版本快照恢复
      const snap = this.store.loadSnapshot(setId, startVersion);
      const restored = snap ? AvlMultiset.deserialize(snap, this.maxNodes) : new AvlMultiset(this.maxNodes);
      restored.setLogSink((log) => this.persist(setId, restored, log));
      this.trees.set(setId, restored);
      throw e;
    }
  }

  query(setId: string, key: unknown) {
    return this.getTree(setId).query(validateKey(key));
  }

  treeAt(setId: string, version?: number) {
    const tree = this.getTree(setId);
    const v = version === undefined ? tree.version : version;
    if (!Number.isInteger(v) || v < 0 || v > tree.version) {
      throw new AvlError('INVALID_VERSION', `版本必须在 0..${tree.version} 之间`);
    }
    const snap = this.store.loadSnapshot(setId, v);
    if (!snap) throw new AvlError('VERSION_NOT_FOUND', `版本 ${v} 快照不存在`);
    const t = AvlMultiset.deserialize(snap, this.maxNodes);
    return { version: v, summary: t.summary(), inorder: t.inorder(), tree: JSON.parse(snap).root };
  }

  logs(setId: string, page = 1, pageSize = 20) {
    this.getTree(setId);
    if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 200) {
      throw new AvlError('INVALID_PAGING', 'page/pageSize 非法');
    }
    const { total, logs } = this.store.getLogs(setId, (page - 1) * pageSize, pageSize);
    return { total, page, pageSize, logs };
  }

  stats(setId: string) {
    const t = this.getTree(setId);
    return { setId, version: t.version, ...t.summary() };
  }

  export(setId: string) {
    const t = this.getTree(setId);
    return {
      setId,
      version: t.version,
      summary: t.summary(),
      inorder: t.inorder(),
      snapshot: JSON.parse(this.store.loadSnapshot(setId)!),
      logs: this.store.getLogs(setId, 0, 1 << 30).logs,
    };
  }

  listSets() { return this.store.listSets(); }
}
