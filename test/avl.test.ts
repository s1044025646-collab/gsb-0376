import { test } from 'node:test';
import assert from 'node:assert';
import { AvlMultiset } from '../src/avl';
import { checkTree } from '../src/checker';

function fresh(): AvlMultiset { return new AvlMultiset(); }

test('空集与单节点', () => {
  const t = fresh();
  assert.equal(t.summary().height, 0);
  assert.equal(t.query(5).found, false);
  assert.equal(t.query(5).min, null);
  t.insert(5);
  assert.equal(t.summary().height, 1);
  assert.equal(t.query(5).count, 1);
  assert.ok(checkTree(t).ok);
});

test('四种旋转 LL/RR/LR/RL', () => {
  const cases: [number[], string][] = [
    [[30, 20, 10], 'LL'], [[10, 20, 30], 'RR'],
    [[30, 10, 20], 'LR'], [[10, 30, 20], 'RL'],
  ];
  for (const [keys, type] of cases) {
    const t = fresh();
    for (const k of keys) t.insert(k);
    const last = t.getLogs().at(-1)!;
    assert.equal(last.rotations[0]?.type, type, `${type} 应由 ${keys} 触发`);
    assert.equal(t.summary().height, 2);
    assert.ok(checkTree(t).ok);
  }
});

test('重复键计数增减, 归零才移除节点', () => {
  const t = fresh();
  t.insert(7); t.insert(7); t.insert(7);
  assert.equal(t.distinctKeys, 1);
  assert.equal(t.totalElements, 3);
  let log = t.delete(7);
  assert.equal(log.result, 'count_decremented');
  assert.equal(t.distinctKeys, 1);
  t.delete(7);
  log = t.delete(7);
  assert.equal(log.result, 'deleted');
  assert.equal(t.distinctKeys, 0);
  assert.equal(t.summary().height, 0);
  assert.ok(checkTree(t).ok);
});

test('删除不存在的键: 未找到且版本不变', () => {
  const t = fresh();
  t.insert(1);
  const v = t.version;
  const log = t.delete(99);
  assert.equal(log.result, 'not_found');
  assert.equal(t.version, v);
  assert.equal(t.getLogs().length, 1);
});

test('删除根节点', () => {
  const t = fresh();
  t.insert(1);
  t.delete(1);
  assert.equal(t.summary().rootId, null);
  const t2 = fresh();
  [2, 1, 3].forEach((k) => t2.insert(k));
  t2.delete(2); // 删除根(双子)
  assert.deepEqual(t2.inorder().map((e) => e.key), [1, 3]);
  assert.ok(checkTree(t2).ok);
});

test('双子节点删除: 中序后继多计数整体迁移', () => {
  const t = fresh();
  [50, 30, 70, 60, 80, 60, 60].forEach((k) => t.insert(k)); // 60 出现 3 次
  const log = t.delete(50); // 根, 后继为 60(count=3)
  assert.equal(log.successorReplacement?.successorKey, 60);
  assert.equal(log.successorReplacement?.successorCount, 3);
  assert.equal(t.totalElements, 6); // 7 - 1, 不丢不增
  assert.equal(t.query(60).count, 3);
  assert.deepEqual(t.inorder(), [
    { key: 30, count: 1 }, { key: 60, count: 3 }, { key: 70, count: 1 }, { key: 80, count: 1 },
  ]);
  assert.ok(checkTree(t).ok);
});

test('多层删除修复与删除时孩子平衡因子为 0 的旋转', () => {
  const t = fresh();
  // 构造删除后兄弟平衡因子为 0 的情形: 删空右子树使根失衡, 左孩子平衡因子恰为 0
  [8, 4, 12, 2, 6, 10, 14, 1, 3, 5, 7, 9, 11].forEach((k) => t.insert(k));
  t.delete(9); t.delete(11); t.delete(10);
  const log = t.delete(14); // 右子树仅剩 12, 根失衡且左孩子平衡因子为 0
  assert.equal(log.rotations.length, 1);
  assert.equal(log.rotations[0].type, 'LL'); // 左孩子平衡因子 0, 仍按 LL 右旋
  assert.ok(checkTree(t).ok);
  // 连续删除触发多层修复
  const t2 = fresh();
  for (const k of [8, 4, 12, 2, 6, 10, 14, 1, 3, 5, 7, 9, 11, 13, 15]) t2.insert(k);
  for (const k of [1, 2, 3, 4, 5]) { t2.delete(k); assert.ok(checkTree(t2).ok, checkTree(t2).errors.join(';')); }
  assert.deepEqual(t2.inorder().map((e) => e.key), [6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
});

test('查询路径与严格前驱后继', () => {
  const t = fresh();
  [20, 10, 30, 5, 15, 25, 35].forEach((k) => t.insert(k));
  const q = t.query(15);
  assert.equal(q.found, true);
  assert.deepEqual(q.path.map((p) => p.key), [20, 10, 15]);
  assert.deepEqual(q.path.map((p) => p.comparison), ['go_left', 'go_right', 'equal']);
  assert.equal(q.predecessor, 10);
  assert.equal(q.successor, 20);
  assert.equal(q.min, 5);
  assert.equal(q.max, 35);
  const q2 = t.query(12);
  assert.equal(q2.found, false);
  assert.equal(q2.predecessor, 10);
  assert.equal(q2.successor, 15);
  const q3 = t.query(100);
  assert.equal(q3.successor, null);
  const q4 = t.query(1);
  assert.equal(q4.predecessor, null);
});

test('节点数量上限', () => {
  const t = new AvlMultiset(3);
  t.insert(1); t.insert(2); t.insert(3);
  t.insert(2); // 重复键不占新节点
  assert.throws(() => t.insert(4), /上限/);
});
