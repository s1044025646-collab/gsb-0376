import { test } from 'node:test';
import assert from 'node:assert';
import { AvlMultiset } from '../src/avl';
import { checkTree } from '../src/checker';

// 固定种子 PRNG (mulberry32)
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 基准: 普通排序数组多重集合
class Model {
  arr: number[] = [];
  insert(k: number) { this.arr.push(k); this.arr.sort((a, b) => a - b); }
  delete(k: number): boolean {
    const i = this.arr.indexOf(k);
    if (i < 0) return false;
    this.arr.splice(i, 1);
    return true;
  }
  count(k: number) { return this.arr.filter((x) => x === k).length; }
  pred(k: number) { const s = this.arr.filter((x) => x < k); return s.length ? s[s.length - 1] : null; }
  succ(k: number) { const s = this.arr.filter((x) => x > k); return s.length ? s[0] : null; }
}

test('固定种子随机操作对照排序数组基准', () => {
  for (const seed of [42, 1337, 20261005]) {
    const rand = rng(seed);
    const t = new AvlMultiset();
    const m = new Model();
    for (let step = 0; step < 2000; step++) {
      const key = Math.floor(rand() * 200) - 100;
      const r = rand();
      if (r < 0.5) { t.insert(key); m.insert(key); }
      else if (r < 0.85) {
        const log = t.delete(key);
        assert.equal(log.result !== 'not_found', m.delete(key), `seed=${seed} step=${step} delete ${key}`);
      } else {
        const q = t.query(key);
        assert.equal(q.count, m.count(key));
        assert.equal(q.found, m.count(key) > 0);
        assert.equal(q.predecessor, m.pred(key));
        assert.equal(q.successor, m.succ(key));
        assert.equal(q.min, m.arr.length ? m.arr[0] : null);
        assert.equal(q.max, m.arr.length ? m.arr[m.arr.length - 1] : null);
      }
      const chk = checkTree(t);
      assert.ok(chk.ok, `seed=${seed} step=${step}: ${chk.errors.join('; ')}`);
      assert.equal(t.totalElements, m.arr.length);
    }
    // 最终内容一致
    const expanded: number[] = [];
    for (const e of t.inorder()) for (let i = 0; i < e.count; i++) expanded.push(e.key);
    assert.deepEqual(expanded, m.arr);
  }
});
