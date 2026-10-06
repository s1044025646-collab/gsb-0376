// 独立结构检查器: 从根重新遍历, 不信任节点自报高度。
import { AvlMultiset, AvlNode } from './avl';

export interface CheckResult {
  ok: boolean;
  errors: string[];
  computedHeight: number;
  nodeCount: number;
  totalElements: number;
}

export function checkTree(tree: AvlMultiset): CheckResult {
  const errors: string[] = [];
  const visited = new Set<number>();
  let nodeCount = 0;
  let totalElements = 0;

  const walk = (n: AvlNode | null, lo: number | null, hi: number | null, ancestors: Set<number>): number => {
    if (!n) return 0;
    if (ancestors.has(n.id)) { errors.push(`节点#${n.id} 存在环`); return 0; }
    if (visited.has(n.id)) { errors.push(`节点#${n.id} 被多个父节点共享`); return 0; }
    visited.add(n.id);
    ancestors.add(n.id);
    nodeCount++;
    if (typeof n.key !== 'number' || !Number.isInteger(n.key)) errors.push(`节点#${n.id} 键非法: ${n.key}`);
    if (!Number.isInteger(n.count) || n.count <= 0) errors.push(`节点#${n.id} 计数非正: ${n.count}`);
    totalElements += n.count;
    if (lo !== null && n.key <= lo) errors.push(`节点#${n.id} 键 ${n.key} 违反下界 > ${lo}`);
    if (hi !== null && n.key >= hi) errors.push(`节点#${n.id} 键 ${n.key} 违反上界 < ${hi}`);
    const lh = walk(n.left, lo, n.key, ancestors);
    const rh = walk(n.right, n.key, hi, ancestors);
    ancestors.delete(n.id);
    const real = 1 + Math.max(lh, rh);
    if (n.height !== real) errors.push(`节点#${n.id} 自报高度 ${n.height} 与真实高度 ${real} 不符`);
    const bf = lh - rh;
    if (Math.abs(bf) > 1) errors.push(`节点#${n.id} 失衡, 平衡因子 ${bf}`);
    return real;
  };

  const computedHeight = walk(tree.root, null, null, new Set());
  if (nodeCount !== tree.distinctKeys) errors.push(`不同键数不符: 树中 ${nodeCount}, 统计 ${tree.distinctKeys}`);
  if (totalElements !== tree.totalElements) errors.push(`总元素数不符: 树中 ${totalElements}, 统计 ${tree.totalElements}`);
  return { ok: errors.length === 0, errors, computedHeight, nodeCount, totalElements };
}
