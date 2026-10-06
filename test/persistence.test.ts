import { test } from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Store } from '../src/store';
import { SetService } from '../src/service';
import { AvlMultiset } from '../src/avl';
import { checkTree } from '../src/checker';

function tmpDb(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'avl-')), 'test.db');
}

test('非法批次整批回滚', () => {
  const db = tmpDb();
  const svc = new SetService(new Store(db));
  const { setId } = svc.createSet('t');
  svc.insert(setId, 1);
  const v0 = svc.stats(setId).version;
  assert.throws(
    () => svc.batch(setId, 'bad-1', [{ op: 'insert', key: 2 }, { op: 'insert', key: 'x' }]),
    /整数/,
  );
  assert.equal(svc.stats(setId).version, v0); // 版本未推进
  assert.equal(svc.query(setId, 2).found, false); // 部分操作未生效
  // 幂等: 同一 requestId 重复提交不多插
  const r1 = svc.batch(setId, 'ok-1', [{ op: 'insert', key: 5 }, { op: 'insert', key: 5 }]);
  const r2 = svc.batch(setId, 'ok-1', [{ op: 'insert', key: 5 }, { op: 'insert', key: 5 }]);
  assert.equal(r2.duplicate, true);
  assert.equal(r1.version, r2.version);
  assert.equal(svc.query(setId, 5).count, 2);
});

test('重启后继续更新与历史版本可查', () => {
  const db = tmpDb();
  let svc = new SetService(new Store(db));
  const { setId } = svc.createSet('t');
  for (const k of [10, 5, 15, 3, 7]) svc.insert(setId, k);
  const v = svc.stats(setId).version;
  const before = svc.export(setId);

  // 模拟重启: 新 Store + 新 Service
  svc = new SetService(new Store(db));
  assert.equal(svc.stats(setId).version, v);
  assert.deepEqual(svc.export(setId).inorder, before.inorder);
  // 继续更新
  svc.insert(setId, 12);
  svc.delete(setId, 10);
  assert.equal(svc.stats(setId).version, v + 2);
  // 历史版本仍可查
  const old = svc.treeAt(setId, v);
  assert.deepEqual(old.inorder.map((e) => e.key), [3, 5, 7, 10, 15]);
  const cur = svc.treeAt(setId);
  assert.deepEqual(cur.inorder.map((e) => e.key), [3, 5, 7, 12, 15]);
  // 恢复的树通过结构检查
  const tree = AvlMultiset.deserialize(JSON.stringify(svc.export(setId).snapshot));
  assert.ok(checkTree(tree).ok);
  // 日志完整
  assert.equal(svc.logs(setId, 1, 100).total, v + 2);
});

test('日志分页', () => {
  const db = tmpDb();
  const svc = new SetService(new Store(db));
  const { setId } = svc.createSet('t');
  for (let i = 0; i < 25; i++) svc.insert(setId, i);
  const p1 = svc.logs(setId, 1, 10);
  const p3 = svc.logs(setId, 3, 10);
  assert.equal(p1.total, 25);
  assert.equal(p1.logs.length, 10);
  assert.equal(p3.logs.length, 5);
  assert.equal(p3.logs[0].version, 21);
});
