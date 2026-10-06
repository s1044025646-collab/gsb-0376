// CLI 入口: create/insert/delete/batch/query/tree/logs/stats/export/serve/demo
import { Store } from './store';
import { SetService } from './service';
import { startServer } from './server';
import { renderTree, renderLog } from './render';
import { runDemo } from './demo';
import * as path from 'node:path';

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'avl.db');

function getService(): { service: SetService; store: Store } {
  const store = new Store(DB_PATH);
  return { service: new SetService(store, Number(process.env.MAX_NODES) || 100000), store };
}

function argValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  const { service, store } = getService();
  try {
    switch (cmd) {
      case 'create': {
        const r = service.createSet(argValue(args, 'name'));
        console.log(`已创建集合: ${r.setId} (${r.name})`);
        break;
      }
      case 'list': {
        for (const s of service.listSets()) console.log(`${s.id}\t${s.name}`);
        break;
      }
      case 'insert':
      case 'delete': {
        const setId = args[0]; const key = Number(args[1]);
        const log = cmd === 'insert' ? service.insert(setId, key) : service.delete(setId, key);
        console.log(renderLog(log));
        break;
      }
      case 'batch': {
        // batch <setId> <requestId> <opsJson>  例: batch abc r1 '[["insert",1],["delete",2]]'
        const [setId, requestId, opsJson] = args;
        const ops = (JSON.parse(opsJson) as any[]).map(([op, key]) => ({ op, key }));
        const r = service.batch(setId, requestId, ops);
        console.log(`批次完成 version=${r.version} duplicate=${r.duplicate}`);
        for (const log of r.results) console.log(renderLog(log));
        break;
      }
      case 'query': {
        const r = service.query(args[0], Number(args[1]));
        console.log(JSON.stringify(r, null, 2));
        break;
      }
      case 'tree': {
        const v = argValue(args, 'version');
        const r = service.treeAt(args[0], v === undefined ? undefined : Number(v));
        console.log(`版本 ${r.version} 摘要:`, JSON.stringify(r.summary));
        console.log(renderTree(r.tree));
        console.log('中序:', r.inorder.map((e: any) => `${e.key}x${e.count}`).join(' ') || '(空)');
        break;
      }
      case 'logs': {
        const r = service.logs(args[0], Number(argValue(args, 'page') || 1), Number(argValue(args, 'pageSize') || 20));
        console.log(`共 ${r.total} 条日志, 第 ${r.page} 页`);
        for (const log of r.logs) { console.log(renderLog(log)); console.log('---'); }
        break;
      }
      case 'stats': console.log(JSON.stringify(service.stats(args[0]), null, 2)); break;
      case 'export': console.log(JSON.stringify(service.export(args[0]), null, 2)); break;
      case 'serve': {
        const portArg = argValue(args, 'port');
        const { port } = await startServer(service, portArg ? Number(portArg) : undefined);
        console.log(`API 服务已启动: http://127.0.0.1:${port} (数据目录: ${DATA_DIR})`);
        return; // 保持进程
      }
      case 'demo': {
        await runDemo(service);
        break;
      }
      default:
        console.log(`用法: node dist/src/cli.js <命令>
  create [--name N]            创建集合
  list                         列出集合
  insert <setId> <key>         插入
  delete <setId> <key>         删除一次
  batch <setId> <reqId> <json> 批量操作 (幂等)
  query <setId> <key>          查询路径/前驱/后继/最值
  tree <setId> [--version V]   查看某版本的树
  logs <setId> [--page N]      旋转日志(分页)
  stats <setId>                统计
  export <setId>               导出 JSON
  serve [--port P]             启动 API (默认自动选空闲端口)
  demo                         运行演示`);
    }
  } finally {
    if (cmd !== 'serve') store.close();
  }
}

main().catch((e) => {
  console.error(`错误 [${e.code || 'INTERNAL'}]: ${e.message}`);
  process.exit(1);
});
