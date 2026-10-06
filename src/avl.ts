// AVL 有序多重集合核心实现。
// 高度约定: 空树高度 0, 叶子高度 1。平衡因子 = 左高 - 右高, 绝对值 <= 1。

export interface AvlNode {
  id: number;        // 内部结构编号, 与键值无关
  key: number;
  count: number;     // 该键出现次数
  height: number;
  left: AvlNode | null;
  right: AvlNode | null;
}

export type RotationType = 'LL' | 'RR' | 'LR' | 'RL';

export interface EdgeChange {
  parentId: number | null;   // null 表示根指针
  slot: 'root' | 'left' | 'right';
  oldChildId: number | null;
  newChildId: number | null;
}

export interface RotationRecord {
  type: RotationType;
  reason: string;
  pivotId: number;           // 失衡节点(旋转前子树根)
  newRootId: number;         // 旋转后该子树的新根
  edgeChanges: EdgeChange[];
}

export interface HeightChange {
  nodeId: number;
  key: number;
  oldHeight: number;
  newHeight: number;
}

export interface OpLog {
  version: number;           // 操作后的版本号
  op: 'insert' | 'delete';
  key: number;
  result: 'inserted' | 'count_incremented' | 'deleted' | 'count_decremented' | 'not_found';
  before: TreeSummary;
  after: TreeSummary;
  createdNodeId?: number;
  removedNodeId?: number;
  successorReplacement?: {
    removedNodeId: number;
    removedKey: number;
    successorNodeId: number;
    successorKey: number;
    successorCount: number;
    note: string;
  };
  heightChanges: HeightChange[];
  rotations: RotationRecord[];
  edgeChanges: EdgeChange[];
}

export interface TreeSummary {
  rootId: number | null;
  height: number;
  totalElements: number;   // 总元素数(含重复)
  distinctKeys: number;    // 不同键数
}

export interface QueryResult {
  found: boolean;
  count: number;
  path: { id: number; key: number; count: number; comparison: 'equal' | 'go_left' | 'go_right' }[];
  predecessor: number | null;  // 严格前驱
  successor: number | null;    // 严格后继
  min: number | null;
  max: number | null;
}

const h = (n: AvlNode | null): number => (n ? n.height : 0);

export class AvlMultiset {
  root: AvlNode | null = null;
  totalElements = 0;
  distinctKeys = 0;
  version = 0;
  private nextId = 1;
  readonly maxNodes: number;
  private logs: OpLog[] = [];
  private onLog?: (log: OpLog) => void;

  constructor(maxNodes = 100000) {
    this.maxNodes = maxNodes;
  }

  setLogSink(fn: (log: OpLog) => void): void { this.onLog = fn; }
  getLogs(): OpLog[] { return this.logs; }

  summary(): TreeSummary {
    return {
      rootId: this.root ? this.root.id : null,
      height: h(this.root),
      totalElements: this.totalElements,
      distinctKeys: this.distinctKeys,
    };
  }

  contains(key: number): boolean {
    let n = this.root;
    while (n) {
      if (key === n.key) return true;
      n = key < n.key ? n.left : n.right;
    }
    return false;
  }

  query(key: number): QueryResult {
    const path: QueryResult['path'] = [];
    let n = this.root;
    let found = false;
    let count = 0;
    let pred: number | null = null;
    let succ: number | null = null;
    while (n) {
      if (key === n.key) {
        path.push({ id: n.id, key: n.key, count: n.count, comparison: 'equal' });
        found = true; count = n.count;
        // 严格前驱: 左子树最大
        let p = n.left;
        if (p) { while (p.right) p = p.right; pred = p.key; }
        // 严格后继: 右子树最小
        let s = n.right;
        if (s) { while (s.left) s = s.left; succ = s.key; }
        break;
      } else if (key < n.key) {
        path.push({ id: n.id, key: n.key, count: n.count, comparison: 'go_left' });
        succ = n.key;
        n = n.left;
      } else {
        path.push({ id: n.id, key: n.key, count: n.count, comparison: 'go_right' });
        pred = n.key;
        n = n.right;
      }
    }
    let min: number | null = null, max: number | null = null;
    let lo = this.root; while (lo) { min = lo.key; lo = lo.left; }
    let hi = this.root; while (hi) { max = hi.key; hi = hi.right; }
    return { found, count, path, predecessor: pred, successor: succ, min, max };
  }

  insert(key: number): OpLog {
    if (!this.contains(key) && this.distinctKeys >= this.maxNodes) {
      throw new AvlError('LIMIT_EXCEEDED', `节点数量超过上限 ${this.maxNodes}`);
    }
    const before = this.summary();
    const ctx = this.newCtx();
    let createdId: number | undefined;
    let result: OpLog['result'] = 'inserted';
    const rec = (n: AvlNode | null): AvlNode => {
      if (!n) {
        const node: AvlNode = { id: this.nextId++, key, count: 1, height: 1, left: null, right: null };
        createdId = node.id;
        this.distinctKeys++;
        return node;
      }
      if (key === n.key) { n.count++; result = 'count_incremented'; return n; }
      if (key < n.key) n.left = rec(n.left);
      else n.right = rec(n.right);
      return this.rebalance(n, ctx);
    };
    this.root = rec(this.root);
    this.totalElements++;
    return this.finishLog('insert', key, result, before, ctx, { createdNodeId: createdId });
  }

  delete(key: number): OpLog {
    const before = this.summary();
    const ctx = this.newCtx();
    let result: OpLog['result'] = 'not_found';
    let removedId: number | undefined;
    let replacement: OpLog['successorReplacement'];
    const rec = (n: AvlNode | null): AvlNode | null => {
      if (!n) return null;
      if (key < n.key) { n.left = rec(n.left); return this.rebalance(n, ctx); }
      if (key > n.key) { n.right = rec(n.right); return this.rebalance(n, ctx); }
      // 找到目标
      if (n.count > 1) { n.count--; result = 'count_decremented'; return n; }
      result = 'deleted';
      removedId = n.id;
      this.distinctKeys--;
      if (!n.left || !n.right) {
        return n.left ?? n.right; // 单子或叶子: 直接摘除
      }
      // 双子: 用右子树中序后继替换, 迁移其全部计数
      let succ = n.right;
      while (succ.left) succ = succ.left;
      replacement = {
        removedNodeId: n.id,
        removedKey: n.key,
        successorNodeId: succ.id,
        successorKey: succ.key,
        successorCount: succ.count,
        note: `结构位置节点#${n.id}(键${n.key})由中序后继节点#${succ.id}(键${succ.key},计数${succ.count})的键与计数整体替换, 随后在右子树中摘除后继节点本身`,
      };
      n.key = succ.key;
      n.count = succ.count;
      // 从右子树移除后继节点(整节点摘除, 后继必无左孩子)
      const removeSucc = (m: AvlNode): AvlNode | null => {
        if (m.id === succ!.id) return m.right;
        m.left = removeSucc(m.left!);
        return this.rebalance(m, ctx);
      };
      n.right = removeSucc(n.right);
      return this.rebalance(n, ctx);
    };
    this.root = rec(this.root);
    if (result === 'not_found') {
      // 未找到: 版本不变, 不写日志
      return {
        version: this.version, op: 'delete', key, result,
        before, after: this.summary(),
        heightChanges: [], rotations: [], edgeChanges: [],
      };
    }
    this.totalElements--;
    return this.finishLog('delete', key, result, before, ctx, { removedNodeId: removedId, successorReplacement: replacement });
  }

  // ---- 内部 ----

  private newCtx() {
    return { heightChanges: [] as HeightChange[], rotations: [] as RotationRecord[], edgeChanges: [] as EdgeChange[] };
  }

  private finishLog(op: 'insert' | 'delete', key: number, result: OpLog['result'],
    before: TreeSummary, ctx: ReturnType<AvlMultiset['newCtx']>,
    extra: Partial<OpLog>): OpLog {
    this.version++;
    const log: OpLog = {
      version: this.version, op, key, result, before,
      after: this.summary(),
      heightChanges: ctx.heightChanges,
      rotations: ctx.rotations,
      edgeChanges: ctx.edgeChanges,
      ...extra,
    };
    this.logs.push(log);
    if (this.onLog) this.onLog(log);
    return log;
  }

  private setHeight(n: AvlNode, ctx: ReturnType<AvlMultiset['newCtx']>): void {
    const nh = 1 + Math.max(h(n.left), h(n.right));
    if (nh !== n.height) {
      ctx.heightChanges.push({ nodeId: n.id, key: n.key, oldHeight: n.height, newHeight: nh });
      n.height = nh;
    }
  }

  private rebalance(n: AvlNode, ctx: ReturnType<AvlMultiset['newCtx']>): AvlNode {
    this.setHeight(n, ctx);
    const bf = h(n.left) - h(n.right);
    if (bf > 1) {
      const l = n.left!;
      const lbf = h(l.left) - h(l.right);
      if (lbf >= 0) { // LL (含删除时 lbf === 0)
        return this.rotateRight(n, 'LL', `节点#${n.id} 平衡因子 ${bf}, 左孩子平衡因子 ${lbf} >= 0, 执行右旋`, ctx);
      }
      // LR: 先左旋左孩子, 再右旋
      const before = ctx.edgeChanges.length;
      n.left = this.rotateLeft(l, 'LR-inner', '', ctx, true);
      const res = this.rotateRight(n, 'LR-outer', '', ctx, true);
      ctx.rotations.push({
        type: 'LR',
        reason: `节点#${n.id} 平衡因子 ${bf}, 左孩子平衡因子 ${lbf} < 0, 先对左孩子#${l.id} 左旋, 再对节点#${n.id} 右旋`,
        pivotId: n.id, newRootId: res.id,
        edgeChanges: ctx.edgeChanges.slice(before),
      });
      return res;
    }
    if (bf < -1) {
      const r = n.right!;
      const rbf = h(r.left) - h(r.right);
      if (rbf <= 0) { // RR (含 rbf === 0)
        return this.rotateLeft(n, 'RR', `节点#${n.id} 平衡因子 ${bf}, 右孩子平衡因子 ${rbf} <= 0, 执行左旋`, ctx);
      }
      const before = ctx.edgeChanges.length;
      n.right = this.rotateRight(r, 'RL-inner', '', ctx, true);
      const res = this.rotateLeft(n, 'RL-outer', '', ctx, true);
      ctx.rotations.push({
        type: 'RL',
        reason: `节点#${n.id} 平衡因子 ${bf}, 右孩子平衡因子 ${rbf} > 0, 先对右孩子#${r.id} 右旋, 再对节点#${n.id} 左旋`,
        pivotId: n.id, newRootId: res.id,
        edgeChanges: ctx.edgeChanges.slice(before),
      });
      return res;
    }
    return n;
  }

  private rotateRight(y: AvlNode, type: RotationType | string, reason: string,
    ctx: ReturnType<AvlMultiset['newCtx']>, inner = false): AvlNode {
    const x = y.left!;
    const t2 = x.right;
    x.right = y;
    y.left = t2;
    ctx.edgeChanges.push(
      { parentId: x.id, slot: 'right', oldChildId: t2 ? t2.id : null, newChildId: y.id },
      { parentId: y.id, slot: 'left', oldChildId: x.id, newChildId: t2 ? t2.id : null },
    );
    this.setHeight(y, ctx);
    this.setHeight(x, ctx);
    if (!inner) ctx.rotations.push({ type: type as RotationType, reason, pivotId: y.id, newRootId: x.id, edgeChanges: ctx.edgeChanges.slice(-2) });
    return x;
  }

  private rotateLeft(y: AvlNode, type: RotationType | string, reason: string,
    ctx: ReturnType<AvlMultiset['newCtx']>, inner = false): AvlNode {
    const x = y.right!;
    const t2 = x.left;
    x.left = y;
    y.right = t2;
    ctx.edgeChanges.push(
      { parentId: x.id, slot: 'left', oldChildId: t2 ? t2.id : null, newChildId: y.id },
      { parentId: y.id, slot: 'right', oldChildId: x.id, newChildId: t2 ? t2.id : null },
    );
    this.setHeight(y, ctx);
    this.setHeight(x, ctx);
    if (!inner) ctx.rotations.push({ type: type as RotationType, reason, pivotId: y.id, newRootId: x.id, edgeChanges: ctx.edgeChanges.slice(-2) });
    return x;
  }

  // 中序展开为 [key, count] 列表
  inorder(): { key: number; count: number }[] {
    const out: { key: number; count: number }[] = [];
    const walk = (n: AvlNode | null) => {
      if (!n) return;
      walk(n.left);
      out.push({ key: n.key, count: n.count });
      walk(n.right);
    };
    walk(this.root);
    return out;
  }

  // 快照(可恢复)
  serialize(): string {
    const pack = (n: AvlNode | null): unknown => n && {
      id: n.id, key: n.key, count: n.count, height: n.height,
      left: pack(n.left), right: pack(n.right),
    };
    return JSON.stringify({ root: pack(this.root), totalElements: this.totalElements, distinctKeys: this.distinctKeys, version: this.version, nextId: this.nextId });
  }

  static deserialize(json: string, maxNodes = 100000): AvlMultiset {
    const data = JSON.parse(json);
    const t = new AvlMultiset(maxNodes);
    const unpack = (d: any): AvlNode | null => !d ? null : {
      id: d.id, key: d.key, count: d.count, height: d.height,
      left: unpack(d.left), right: unpack(d.right),
    };
    t.root = unpack(data.root);
    t.totalElements = data.totalElements;
    t.distinctKeys = data.distinctKeys;
    t.version = data.version;
    (t as any).nextId = data.nextId;
    return t;
  }
}

export class AvlError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

export function validateKey(v: unknown): number {
  if (typeof v !== 'number' || !Number.isInteger(v)) {
    throw new AvlError('INVALID_KEY', '键必须为整数');
  }
  if (v < -1e15 || v > 1e15) throw new AvlError('INVALID_KEY', '键超出允许范围 [-1e15, 1e15]');
  return v;
}
