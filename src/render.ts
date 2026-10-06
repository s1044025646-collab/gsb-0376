// 缩进树与变化表渲染 (CLI 展示)
import { AvlNode, OpLog } from './avl';

export function renderTree(root: AvlNode | null): string {
  if (!root) return '(空树)';
  const lines: string[] = [];
  const walk = (n: AvlNode | null, prefix: string, isTail: boolean, label: string) => {
    if (!n) return;
    lines.push(`${prefix}${isTail ? '└── ' : '├── '}${label}[#${n.id}] key=${n.key} count=${n.count} h=${n.height}`);
    const childPrefix = prefix + (isTail ? '    ' : '│   ');
    if (n.left) walk(n.left, childPrefix, !n.right, 'L:');
    if (n.right) walk(n.right, childPrefix, true, 'R:');
  };
  walk(root, '', true, '');
  return lines.join('\n');
}

export function renderLog(log: OpLog): string {
  const lines: string[] = [];
  lines.push(`版本 ${log.before.rootId === null ? '-' : log.version - 1} -> ${log.version} | ${log.op}(${log.key}) => ${log.result}`);
  lines.push(`  摘要: 高度 ${log.before.height} -> ${log.after.height}, 总元素 ${log.before.totalElements} -> ${log.after.totalElements}, 不同键 ${log.before.distinctKeys} -> ${log.after.distinctKeys}`);
  if (log.createdNodeId) lines.push(`  新建节点 #${log.createdNodeId}`);
  if (log.removedNodeId) lines.push(`  移除节点 #${log.removedNodeId}`);
  if (log.successorReplacement) {
    const s = log.successorReplacement;
    lines.push(`  后继替换: 位置节点#${s.removedNodeId}(键${s.removedKey}) <- 后继#${s.successorNodeId}(键${s.successorKey}, 计数${s.successorCount})`);
  }
  if (log.heightChanges.length) {
    lines.push('  高度变化:');
    for (const hc of log.heightChanges) lines.push(`    节点#${hc.nodeId} (键${hc.key}): ${hc.oldHeight} -> ${hc.newHeight}`);
  }
  if (log.rotations.length) {
    lines.push('  旋转:');
    for (const r of log.rotations) {
      lines.push(`    [${r.type}] ${r.reason}; 子树根 #${r.pivotId} -> #${r.newRootId}`);
      for (const e of r.edgeChanges) {
        lines.push(`      边: 父#${e.parentId ?? 'root'}.${e.slot}: #${e.oldChildId ?? '-'} -> #${e.newChildId ?? '-'}`);
      }
    }
  } else {
    lines.push('  旋转: 无');
  }
  return lines.join('\n');
}
