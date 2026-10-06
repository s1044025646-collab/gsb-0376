export interface AvlNode {
  id: number;
  key: number;
  count: number;
  height: number;
  left: AvlNode | null;
  right: AvlNode | null;
}

export interface EdgeChange {
  parent: number | null;
  side: "root" | "left" | "right";
  from: number | null;
  to: number | null;
}

export interface RotationRecord {
  type: "LL" | "RR" | "LR" | "RL";
  atKey: number;
  atId: number;
  reason: string;
  edgeChanges: EdgeChange[];
}

export interface UpdateLog {
  version: number;
  op: "insert" | "delete";
  key: number;
  found: boolean;
  before: Summary;
  after: Summary;
  affectedNodes: { id: number; key: number; oldHeight: number; newHeight: number }[];
  rotations: RotationRecord[];
  replacement: {
    removedId: number; removedKey: number;
    successorId: number; successorKey: number; successorCount: number;
    note: string;
  } | null;
  message: string;
}

export interface Summary {
  total: number;
  distinct: number;
  rootKey: number | null;
  height: number;
}

export interface PathStep {
  id: number; key: number; count: number; height: number;
  cmp: "equal" | "go-left" | "go-right";
}

export const MAX_NODES = 100000;
export const KEY_MIN = -2147483648;
export const KEY_MAX = 2147483647;

export class AvlError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

function h(n: AvlNode | null): number { return n ? n.height : 0; }
function bf(n: AvlNode): number { return h(n.left) - h(n.right); }
function recalc(n: AvlNode): void { n.height = Math.max(h(n.left), h(n.right)) + 1; }

interface Ctx {
  rotations: RotationRecord[];
  heights: Map<number, { key: number; oldHeight: number; newHeight: number }>;
}

export class AvlMultiset {
  root: AvlNode | null = null;
  total = 0;
  distinct = 0;
  version = 0;
  private nextId = 1;

  summary(): Summary {
    return { total: this.total, distinct: this.distinct, rootKey: this.root ? this.root.key : null, height: h(this.root) };
  }

  private noteHeight(ctx: Ctx, n: AvlNode): void {
    const e = ctx.heights.get(n.id);
    if (e) e.newHeight = n.height;
    else ctx.heights.set(n.id, { key: n.key, oldHeight: n.height, newHeight: n.height });
  }

  private recalcCtx(ctx: Ctx, n: AvlNode): void {
    const old = n.height;
    recalc(n);
    const e = ctx.heights.get(n.id);
    if (e) e.newHeight = n.height;
    else ctx.heights.set(n.id, { key: n.key, oldHeight: old, newHeight: n.height });
  }

  private rotateRight(ctx: Ctx, y: AvlNode): { root: AvlNode; changes: EdgeChange[] } {
    const x = y.left!;
    const t2 = x.right;
    const changes: EdgeChange[] = [
      { parent: x.id, side: "right", from: t2 ? t2.id : null, to: y.id },
      { parent: y.id, side: "left", from: x.id, to: t2 ? t2.id : null },
    ];
    x.right = y;
    y.left = t2;
    this.recalcCtx(ctx, y);
    this.recalcCtx(ctx, x);
    return { root: x, changes };
  }

  private rotateLeft(ctx: Ctx, x: AvlNode): { root: AvlNode; changes: EdgeChange[] } {
    const y = x.right!;
    const t2 = y.left;
    const changes: EdgeChange[] = [
      { parent: y.id, side: "left", from: t2 ? t2.id : null, to: x.id },
      { parent: x.id, side: "right", from: y.id, to: t2 ? t2.id : null },
    ];
    y.left = x;
    x.right = t2;
    this.recalcCtx(ctx, x);
    this.recalcCtx(ctx, y);
    return { root: y, changes };
  }

  private rebalance(ctx: Ctx, n: AvlNode): AvlNode {
    this.recalcCtx(ctx, n);
    const balance = bf(n);
    if (balance > 1) {
      const child = n.left!;
      const childBf = bf(child);
      if (childBf >= 0) {
        const r = this.rotateRight(ctx, n);
        ctx.rotations.push({ type: "LL", atKey: n.key, atId: n.id, reason: `节点[${n.key}] 平衡因子=${balance}（左高），左孩子[${child.key}] 平衡因子=${childBf}（>=0），对节点[${n.key}] 单次右旋`, edgeChanges: r.changes });
        return r.root;
      }
      const r1 = this.rotateLeft(ctx, child);
      n.left = r1.root;
      const r2 = this.rotateRight(ctx, n);
      ctx.rotations.push({ type: "LR", atKey: n.key, atId: n.id, reason: `节点[${n.key}] 平衡因子=${balance}（左高），左孩子[${child.key}] 平衡因子=${childBf}（<0），先对[${child.key}] 左旋再对[${n.key}] 右旋`, edgeChanges: [...r1.changes, ...r2.changes] });
      return r2.root;
    }
    if (balance < -1) {
      const child = n.right!;
      const childBf = bf(child);
      if (childBf <= 0) {
        const r = this.rotateLeft(ctx, n);
        ctx.rotations.push({ type: "RR", atKey: n.key, atId: n.id, reason: `节点[${n.key}] 平衡因子=${balance}（右高），右孩子[${child.key}] 平衡因子=${childBf}（<=0），对节点[${n.key}] 单次左旋`, edgeChanges: r.changes });
        return r.root;
      }
      const r1 = this.rotateRight(ctx, child);
      n.right = r1.root;
      const r2 = this.rotateLeft(ctx, n);
      ctx.rotations.push({ type: "RL", atKey: n.key, atId: n.id, reason: `节点[${n.key}] 平衡因子=${balance}（右高），右孩子[${child.key}] 平衡因子=${childBf}（>0），先对[${child.key}] 右旋再对[${n.key}] 左旋`, edgeChanges: [...r1.changes, ...r2.changes] });
      return r2.root;
    }
    return n;
  }

  static validateKey(key: unknown): number {
    if (typeof key !== "number" || !Number.isInteger(key)) throw new AvlError("INVALID_KEY", `键必须是整数，收到: ${JSON.stringify(key)}`);
    if (key < KEY_MIN || key > KEY_MAX) throw new AvlError("INVALID_KEY", `键超出 32 位有符号整数范围: ${key}`);
    return key;
  }

  insert(key: number): UpdateLog {
    key = AvlMultiset.validateKey(key);
    const before = this.summary();
    const ctx: Ctx = { rotations: [], heights: new Map() };
    let insertedNew = false;
    const rec = (n: AvlNode | null): AvlNode => {
      if (!n) {
        if (this.distinct >= MAX_NODES) throw new AvlError("NODE_LIMIT", `节点数量达到上限 ${MAX_NODES}`);
        insertedNew = true;
        return { id: this.nextId++, key, count: 1, height: 1, left: null, right: null };
      }
      if (key < n.key) n.left = rec(n.left);
      else if (key > n.key) n.right = rec(n.right);
      else { n.count++; return n; }
      return this.rebalance(ctx, n);
    };
    this.root = rec(this.root);
    this.total++;
    if (insertedNew) this.distinct++;
    this.version++;
    return {
      version: this.version, op: "insert", key, found: true, before, after: this.summary(),
      affectedNodes: [...ctx.heights.entries()].map(([id, v]) => ({ id, ...v })),
      rotations: ctx.rotations, replacement: null,
      message: insertedNew ? `插入新节点[${key}]` : `键[${key}] 已存在，计数 +1`,
    };
  }

  delete(key: number): UpdateLog {
    key = AvlMultiset.validateKey(key);
    const before = this.summary();
    if (!this.contains(key)) {
      return {
        version: this.version, op: "delete", key, found: false, before, after: before,
        affectedNodes: [], rotations: [], replacement: null,
        message: `键[${key}] 不存在，集合未修改，版本保持 ${this.version}`,
      };
    }
    const ctx: Ctx = { rotations: [], heights: new Map() };
    let replacement: UpdateLog["replacement"] = null;
    let nodeRemoved = false;

    const removeMin = (n: AvlNode): { node: AvlNode; min: AvlNode } => {
      if (!n.left) return { node: n.right!, min: n };
      const r = removeMin(n.left);
      n.left = r.node;
      return { node: this.rebalance(ctx, n), min: r.min };
    };

    const rec = (n: AvlNode): AvlNode | null => {
      if (key < n.key) { n.left = rec(n.left!); return this.rebalance(ctx, n); }
      if (key > n.key) { n.right = rec(n.right!); return this.rebalance(ctx, n); }
      if (n.count > 1) { n.count--; return n; }
      nodeRemoved = true;
      if (!n.left) return n.right;
      if (!n.right) return n.left;
      const r = removeMin(n.right);
      const succ = r.min;
      replacement = {
        removedId: n.id, removedKey: n.key,
        successorId: succ.id, successorKey: succ.key, successorCount: succ.count,
        note: `节点#${n.id}(键${n.key}) 有两个孩子，用中序后继节点#${succ.id}(键${succ.key}) 的键与全部计数 ${succ.count} 替换该结构位置，随后自删除位置向上重算高度`,
      };
      n.key = succ.key;
      n.count = succ.count;
      n.right = r.node;
      return this.rebalance(ctx, n);
    };

    this.root = rec(this.root!);
    this.total--;
    if (nodeRemoved) this.distinct--;
    this.version++;
    return {
      version: this.version, op: "delete", key, found: true, before, after: this.summary(),
      affectedNodes: [...ctx.heights.entries()].map(([id, v]) => ({ id, ...v })),
      rotations: ctx.rotations, replacement,
      message: replacement ? `删除键[${key}] 的节点（两孩子，后继替换）` : `删除键[${key}] 的一个出现`,
    };
  }

  contains(key: number): boolean {
    let n = this.root;
    while (n) {
      if (key < n.key) n = n.left;
      else if (key > n.key) n = n.right;
      else return true;
    }
    return false;
  }

  queryPath(key: number): { found: boolean; count: number; path: PathStep[] } {
    const path: PathStep[] = [];
    let n = this.root;
    while (n) {
      if (key === n.key) { path.push({ id: n.id, key: n.key, count: n.count, height: n.height, cmp: "equal" }); return { found: true, count: n.count, path }; }
      const cmp = key < n.key ? "go-left" : "go-right";
      path.push({ id: n.id, key: n.key, count: n.count, height: n.height, cmp });
      n = key < n.key ? n.left : n.right;
    }
    return { found: false, count: 0, path };
  }

  min(): { key: number; count: number } | null {
    let n = this.root;
    if (!n) return null;
    while (n.left) n = n.left;
    return { key: n.key, count: n.count };
  }

  max(): { key: number; count: number } | null {
    let n = this.root;
    if (!n) return null;
    while (n.right) n = n.right;
    return { key: n.key, count: n.count };
  }

  predecessor(key: number): { key: number; count: number } | null {
    let n = this.root, best: AvlNode | null = null;
    while (n) {
      if (key <= n.key) n = n.left;
      else { best = n; n = n.right; }
    }
    return best ? { key: best.key, count: best.count } : null;
  }

  successor(key: number): { key: number; count: number } | null {
    let n = this.root, best: AvlNode | null = null;
    while (n) {
      if (key >= n.key) n = n.right;
      else { best = n; n = n.left; }
    }
    return best ? { key: best.key, count: best.count } : null;
  }

  toJSON(): unknown {
    const ser = (n: AvlNode | null): unknown => n && { id: n.id, key: n.key, count: n.count, height: n.height, left: ser(n.left), right: ser(n.right) };
    return { version: this.version, total: this.total, distinct: this.distinct, nextId: this.nextId, root: ser(this.root) };
  }

  static fromJSON(data: any): AvlMultiset {
    const t = new AvlMultiset();
    t.version = data.version; t.total = data.total; t.distinct = data.distinct; t.nextId = data.nextId;
    const de = (d: any): AvlNode | null => {
      if (!d) return null;
      return { id: d.id, key: d.key, count: d.count, height: d.height, left: de(d.left), right: de(d.right) };
    };
    t.root = de(data.root);
    return t;
  }

  inorder(): { key: number; count: number }[] {
    const out: { key: number; count: number }[] = [];
    const rec = (n: AvlNode | null): void => { if (!n) return; rec(n.left); out.push({ key: n.key, count: n.count }); rec(n.right); };
    rec(this.root);
    return out;
  }
}

export interface CheckResult { ok: boolean; errors: string[]; nodes: number; height: number; }

export function checkStructure(tree: AvlMultiset): CheckResult {
  const errors: string[] = [];
  const seen = new Set<number>();
  let nodes = 0;
  const rec = (n: AvlNode | null, lo: number | null, hi: number | null): number => {
    if (!n) return 0;
    if (seen.has(n.id)) { errors.push(`节点#${n.id} 被共享或成环`); return 0; }
    seen.add(n.id);
    nodes++;
    if (lo !== null && n.key <= lo) errors.push(`节点#${n.id}(键${n.key}) 违反下界 > ${lo}`);
    if (hi !== null && n.key >= hi) errors.push(`节点#${n.id}(键${n.key}) 违反上界 < ${hi}`);
    if (!Number.isInteger(n.count) || n.count <= 0) errors.push(`节点#${n.id}(键${n.key}) 计数非法: ${n.count}`);
    const lh = rec(n.left, lo, n.key);
    const rh = rec(n.right, n.key, hi);
    const real = Math.max(lh, rh) + 1;
    if (n.height !== real) errors.push(`节点#${n.id}(键${n.key}) 高度自报 ${n.height}，实际 ${real}`);
    if (Math.abs(lh - rh) > 1) errors.push(`节点#${n.id}(键${n.key}) 失衡: 左${lh} 右${rh}`);
    return real;
  };
  const height = rec(tree.root, null, null);
  let total = 0, distinct = 0;
  for (const e of tree.inorder()) { total += e.count; distinct++; }
  if (total !== tree.total) errors.push(`total 统计不符: 记录 ${tree.total} 实际 ${total}`);
  if (distinct !== tree.distinct) errors.push(`distinct 统计不符: 记录 ${tree.distinct} 实际 ${distinct}`);
  return { ok: errors.length === 0, errors, nodes, height };
}
