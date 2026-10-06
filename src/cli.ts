import * as path from "node:path";
import { Store } from "./store";
import { createServer, findFreePort } from "./server";
import { checkStructure, AvlMultiset, UpdateLog } from "./avl";

const DB = process.env.AVL_DB ?? path.join(process.cwd(), "data", "avl.db");

function renderTree(node: any, indent = ""): string {
  if (!node) return "";
  let s = renderTree(node.right, indent + "    ");
  s += `${indent}${node.key}(x${node.count},h${node.height},#${node.id})\n`;
  s += renderTree(node.left, indent + "    ");
  return s;
}

function renderLog(log: UpdateLog): string {
  const lines: string[] = [];
  lines.push(`v${log.version} ${log.op} ${log.key} -> ${log.message}`);
  lines.push(`  摘要: 前(total=${log.before.total},distinct=${log.before.distinct},h=${log.before.height}) 后(total=${log.after.total},distinct=${log.after.distinct},h=${log.after.height})`);
  for (const r of log.rotations) {
    lines.push(`  旋转[${r.type}] ${r.reason}`);
    for (const e of r.edgeChanges) lines.push(`    边变化: 父#${e.parent} ${e.side}: #${e.from ?? "空"} -> #${e.to ?? "空"}`);
  }
  if (log.replacement) lines.push(`  替换: ${log.replacement.note}`);
  const changed = log.affectedNodes.filter(a => a.oldHeight !== a.newHeight);
  if (changed.length) lines.push(`  高度更新: ${changed.map(a => `#${a.id}(${a.key}) ${a.oldHeight}->${a.newHeight}`).join(", ")}`);
  return lines.join("\n");
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  const store = new Store(DB);
  const need = (i: number, name: string): string => {
    if (args[i] === undefined) { console.error(`缺少参数: ${name}`); process.exit(2); }
    return args[i];
  };
  try {
    switch (cmd) {
      case "serve": {
        const preferred = Number(process.env.PORT ?? args[0] ?? 8000);
        const port = await findFreePort(preferred);
        createServer(store).listen(port, "127.0.0.1", () => {
          console.log(`AVL 教学服务已启动: http://127.0.0.1:${port} (数据库: ${DB})`);
        });
        return;
      }
      case "create": {
        const id = store.createSet(args[0] ?? "未命名集合");
        console.log(`创建集合 id=${id}`);
        break;
      }
      case "sets": console.log(JSON.stringify(store.listSets(), null, 2)); break;
      case "insert": case "delete": {
        const setId = Number(need(0, "setId"));
        const key = Number(need(1, "key"));
        const r = store.apply(setId, [{ op: cmd, key }], args[2]);
        console.log(renderLog(r.logs[0]));
        break;
      }
      case "batch": {
        const setId = Number(need(0, "setId"));
        const ops = JSON.parse(args[1]);
        const r = store.apply(setId, ops, args[2]);
        for (const l of r.logs) console.log(renderLog(l));
        console.log(`当前版本: v${r.version}${r.duplicate ? "（重复请求，未重复执行）" : ""}`);
        break;
      }
      case "query": {
        const tree = store.load(Number(need(0, "setId")));
        const r = tree.queryPath(Number(need(1, "key")));
        console.log(`查询路径: ${r.path.map(p => `${p.key}${p.cmp === "equal" ? "(命中)" : p.cmp === "go-left" ? "->左" : "->右"}`).join(" ") || "(空树)"}`);
        console.log(r.found ? `找到，计数=${r.count}` : "未找到");
        break;
      }
      case "tree": {
        const data: any = store.treeAt(Number(need(0, "setId")), args[1] === undefined ? undefined : Number(args[1]));
        console.log(`版本 v${data.version} total=${data.total} distinct=${data.distinct}`);
        console.log(renderTree(data.root) || "(空树)");
        break;
      }
      case "logs": {
        const r = store.logs(Number(need(0, "setId")), Number(args[1] ?? 1), Number(args[2] ?? 20));
        console.log(`共 ${r.total} 条日志，第 ${r.page} 页`);
        for (const l of r.items) console.log(renderLog(l) + "\n");
        break;
      }
      case "min": case "max": case "predecessor": case "successor": {
        const tree = store.load(Number(need(0, "setId")));
        const r = cmd === "min" ? tree.min() : cmd === "max" ? tree.max()
          : cmd === "predecessor" ? tree.predecessor(Number(need(1, "key"))) : tree.successor(Number(need(1, "key")));
        console.log(r ? JSON.stringify(r) : "不存在");
        break;
      }
      case "check": {
        const r = checkStructure(store.load(Number(need(0, "setId"))));
        console.log(r.ok ? `结构检查通过: ${r.nodes} 个节点，高度 ${r.height}` : `检查失败:\n${r.errors.join("\n")}`);
        break;
      }
      case "export": {
        console.log(JSON.stringify(store.exportAll(Number(need(0, "setId"))), null, 2));
        break;
      }
      default:
        console.log(`用法: node dist/cli.js <命令> [参数]
  serve [port]              启动 HTTP API（默认 8000，被占用则自动选空闲端口）
  create [name]             创建集合
  sets                      列出集合
  insert <setId> <key> [requestId]
  delete <setId> <key> [requestId]
  batch <setId> '<json>' [requestId]   例: batch 1 "[{\\"op\\":\\"insert\\",\\"key\\":3}]"
  query <setId> <key>       查询比较路径
  tree <setId> [version]    缩进树展示
  logs <setId> [page] [size] 旋转日志
  min|max <setId>           最小/最大
  predecessor|successor <setId> <key>  严格前驱/后继
  check <setId>             结构检查
  export <setId>            导出 JSON`);
    }
  } finally {
    if (cmd !== "serve") store.close();
  }
}

main().catch(e => { console.error(`错误[${e.code ?? "INTERNAL"}]: ${e.message}`); process.exit(1); });
