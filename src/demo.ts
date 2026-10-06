import * as path from "node:path";
import { Store } from "./store";
import { checkStructure } from "./avl";

const DB = process.env.AVL_DB ?? path.join(process.cwd(), "data", "avl-demo.db");
const store = new Store(DB);

function show(setId: number, label: string): void {
  const r = store.logs(setId, 1, 200);
  console.log(`\n===== ${label} (set ${setId}) =====`);
  for (const l of r.items.slice().reverse()) {
    console.log(`v${l.version} ${l.op} ${l.key}: ${l.message}`);
    for (const rot of l.rotations) console.log(`   旋转[${rot.type}] ${rot.reason}`);
    if (l.replacement) console.log(`   ${l.replacement.note}`);
  }
  const chk = checkStructure(store.load(setId));
  console.log(`   结构检查: ${chk.ok ? "通过" : chk.errors.join(";")}`);
}

// 四种旋转：四组各三个键
const cases: [string, number[]][] = [
  ["LL 右旋", [30, 20, 10]],
  ["RR 左旋", [10, 20, 30]],
  ["LR 左右旋", [30, 10, 20]],
  ["RL 右左旋", [10, 30, 20]],
];
for (const [label, keys] of cases) {
  const id = store.createSet(label);
  store.apply(id, keys.map(k => ({ op: "insert" as const, key: k })));
  show(id, label);
}

// 重复键 + 两孩子节点连续删除
const id2 = store.createSet("重复键与两孩子删除");
store.apply(id2, [
  { op: "insert", key: 50 }, { op: "insert", key: 30 }, { op: "insert", key: 70 },
  { op: "insert", key: 20 }, { op: "insert", key: 40 }, { op: "insert", key: 60 }, { op: "insert", key: 80 },
  { op: "insert", key: 40 }, { op: "insert", key: 40 }, { op: "insert", key: 60 },
]);
store.apply(id2, [
  { op: "delete", key: 40 },  // 减计数
  { op: "delete", key: 50 },  // 删除根（两孩子，后继 60 含 2 个出现）
  { op: "delete", key: 70 },  // 两孩子删除
  { op: "delete", key: 20 },
  { op: "delete", key: 30 },
]);
show(id2, "重复键与两孩子连续删除");
store.close();
console.log("\n演示完成。用 tree/logs 命令查看细节，例如: node dist/cli.js logs " + id2);
