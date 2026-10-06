import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AvlMultiset, checkStructure } from "../src/avl";
import { Store } from "../src/store";

function tmpDb(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "avl-")), "t.db");
}

function makeTree(keys: number[]): AvlMultiset {
  const t = new AvlMultiset();
  for (const k of keys) t.insert(k);
  return t;
}

test("空集与单节点", () => {
  const t = new AvlMultiset();
  assert.equal(t.summary().height, 0);
  assert.equal(t.min(), null);
  assert.equal(t.max(), null);
  assert.equal(t.predecessor(5), null);
  assert.equal(t.successor(5), null);
  assert.equal(t.queryPath(5).found, false);
  t.insert(7);
  assert.equal(t.summary().height, 1);
  assert.deepEqual(t.min(), { key: 7, count: 1 });
  assert.ok(checkStructure(t).ok);
});

test("四种旋转", () => {
  const expect: [number[], string][] = [
    [[30, 20, 10], "LL"], [[10, 20, 30], "RR"],
    [[30, 10, 20], "LR"], [[10, 30, 20], "RL"],
  ];
  for (const [keys, type] of expect) {
    const t = new AvlMultiset();
    let last;
    for (const k of keys) last = t.insert(k);
    assert.equal(last!.rotations.length, 1);
    assert.equal(last!.rotations[0].type, type);
    assert.equal(t.root!.key, 20);
    assert.ok(checkStructure(t).ok);
  }
});

test("重复键计数与归零", () => {
  const t = makeTree([5, 5, 5]);
  assert.equal(t.distinct, 1);
  assert.equal(t.total, 3);
  assert.equal(t.root!.count, 3);
  t.delete(5);
  assert.equal(t.root!.count, 2);
  assert.equal(t.distinct, 1);
  t.delete(5); t.delete(5);
  assert.equal(t.root, null);
  assert.equal(t.distinct, 0);
  assert.equal(t.total, 0);
});

test("删除不存在的键版本不变", () => {
  const t = makeTree([1, 2, 3]);
  const v = t.version;
  const log = t.delete(99);
  assert.equal(log.found, false);
  assert.equal(t.version, v);
});

test("删除根与两孩子后继替换（后继含多个出现）", () => {
  const t = makeTree([50, 30, 70, 60, 80, 60, 60]);
  assert.equal(t.root!.count, 1);
  const log = t.delete(50);
  assert.ok(log.replacement);
  assert.equal(log.replacement!.successorKey, 60);
  assert.equal(log.replacement!.successorCount, 3);
  assert.equal(t.root!.key, 60);
  assert.equal(t.root!.count, 3);
  assert.equal(t.total, 6);
  assert.equal(t.distinct, 4);
  assert.ok(checkStructure(t).ok);
  const keys = t.inorder().map(e => e.key);
  assert.deepEqual(keys, [30, 60, 70, 80]);
});

test("多层删除修复（删除时孩子平衡因子为 0 的旋转）", () => {
  // 构造删除后兄弟平衡因子为 0 的场景
  const t = makeTree([10, 5, 20, 3, 7, 15, 30, 25, 40]);
  for (const k of [3, 5, 7]) t.delete(k);
  assert.ok(checkStructure(t).ok);
  assert.deepEqual(t.inorder().map(e => e.key), [10, 15, 20, 25, 30, 40]);
});

test("严格前驱后继与查询路径", () => {
  const t = makeTree([10, 20, 30, 20]);
  assert.deepEqual(t.predecessor(20), { key: 10, count: 1 });
  assert.deepEqual(t.successor(20), { key: 30, count: 1 });
  assert.equal(t.predecessor(10), null);
  assert.equal(t.successor(30), null);
  const q = t.queryPath(30);
  assert.ok(q.found);
  assert.equal(q.path[0].key, 20);
  assert.equal(q.path[0].cmp, "go-right");
});

test("随机操作对照排序数组基准 + 结构检查", () => {
  let seed = 42;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const t = new AvlMultiset();
  const bench: number[] = [];
  for (let i = 0; i < 3000; i++) {
    const key = Math.floor(rand() * 200) - 100;
    if (rand() < 0.55) {
      t.insert(key);
      bench.push(key);
    } else {
      const log = t.delete(key);
      const idx = bench.indexOf(key);
      assert.equal(log.found, idx >= 0);
      if (idx >= 0) bench.splice(idx, 1);
    }
    assert.equal(t.total, bench.length);
    const sorted = [...bench].sort((a, b) => a - b);
    const expanded = t.inorder().flatMap(e => Array(e.count).fill(e.key));
    assert.deepEqual(expanded, sorted);
    const expectMin = sorted.length ? sorted[0] : null;
    assert.equal(t.min()?.key ?? null, expectMin);
    const probe = Math.floor(rand() * 220) - 110;
    const pred = sorted.filter(x => x < probe).pop() ?? null;
    const succ = sorted.find(x => x > probe) ?? null;
    assert.equal(t.predecessor(probe)?.key ?? null, pred);
    assert.equal(t.successor(probe)?.key ?? null, succ);
    assert.equal(t.queryPath(probe).found, sorted.includes(probe));
    const chk = checkStructure(t);
    assert.ok(chk.ok, chk.errors.join(";"));
  }
});

test("持久化：批量回滚、幂等请求、重启恢复", () => {
  const db = tmpDb();
  let store = new Store(db);
  const id = store.createSet("t");
  store.apply(id, [{ op: "insert", key: 1 }, { op: "insert", key: 2 }, { op: "insert", key: 3 }], "req-1");
  // 幂等：重复 requestId 不会多插
  const dup = store.apply(id, [{ op: "insert", key: 1 }, { op: "insert", key: 2 }, { op: "insert", key: 3 }], "req-1");
  assert.ok(dup.duplicate);
  assert.equal(store.load(id).total, 3);
  // 非法批次整体回滚
  assert.throws(() => store.apply(id, [{ op: "insert", key: 9 }, { op: "insert", key: 1.5 } as any]));
  assert.equal(store.load(id).total, 3);
  assert.equal(store.load(id).version, 3);
  // 历史版本可查
  const v1: any = store.treeAt(id, 1);
  assert.equal(v1.total, 1);
  store.close();
  // 重启后继续
  store = new Store(db);
  const t2 = store.load(id);
  assert.equal(t2.total, 3);
  store.apply(id, [{ op: "insert", key: 4 }]);
  assert.equal(store.load(id).version, 4);
  assert.ok(checkStructure(store.load(id)).ok);
  store.close();
});

test("参数校验", () => {
  const t = new AvlMultiset();
  assert.throws(() => t.insert(1.5), /整数/);
  assert.throws(() => t.insert(2 ** 40), /范围/);
  assert.throws(() => t.insert(NaN), /整数/);
});
