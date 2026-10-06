# AVL 有序多重集合教学服务 (TypeScript + Node.js + SQLite)

本地运行的后端服务, 提供 AVL 有序多重集合的插入、删除、查询 API 与 CLI,
并对每次更新给出真实算法运行产生的旋转与高度变化解释。无网页、无 Docker、无外部服务。

## 运行要求

- Windows 本地, Node.js >= 22.5 (使用内置 `node:sqlite`, 无需原生编译)
- 仅开发依赖: `typescript`, `tsx`, `@types/node`

## 快速开始 (可直接复制)

```powershell
npm install
npm run build     # 编译 TypeScript 到 dist/
npm test          # 构建并运行全部测试
npm run demo      # 演示: 四种旋转 + 含重复键/双子节点的连续删除
npm start         # 启动 API 服务 (默认自动选择空闲端口)
```

CLI 直接使用:

```powershell
node dist/src/cli.js create --name myset
node dist/src/cli.js insert <setId> 42
node dist/src/cli.js delete <setId> 42
node dist/src/cli.js batch <setId> req-001 '[["insert",1],["insert",2],["delete",1]]'
node dist/src/cli.js query <setId> 42
node dist/src/cli.js tree <setId> --version 3
node dist/src/cli.js logs <setId> --page 1 --pageSize 10
node dist/src/cli.js stats <setId>
node dist/src/cli.js export <setId>
node dist/src/cli.js serve --port 3000
```

## 高度与平衡约定

- 空树高度为 0, 叶子高度为 1, 节点高度 = 1 + max(左高, 右高)
- 平衡因子 = 左子树高度 - 右子树高度, 绝对值不得超过 1
- 相同键保存在同一节点的 `count` 中: 重复插入只加计数, 删除一次只减一个出现,
  计数降到零才移除节点
- 双子节点删除统一用**中序后继**替换: 后继的键与**全部计数**整体迁移到被删位置,
  随后在右子树中摘除后继节点本身, 不增不减任何出现次数
- 删除时若孩子平衡因子为 0, 仍按同侧单旋处理 (LL/RR 分支取 `>= 0` / `<= 0`)
- 每个节点有内部编号 `id`(结构位置标识), 与键值含义完全分离;
  日志中的"位置节点 #n"指结构位置, 替换只搬动键与计数

## 旋转原因说明

- **LL**: 节点平衡因子 > 1 且左孩子平衡因子 >= 0, 对节点右旋
- **RR**: 节点平衡因子 < -1 且右孩子平衡因子 <= 0, 对节点左旋
- **LR**: 节点平衡因子 > 1 且左孩子平衡因子 < 0, 先对左孩子左旋, 再对节点右旋
- **RL**: 节点平衡因子 < -1 且右孩子平衡因子 > 0, 先对右孩子右旋, 再对节点左旋

每次成功更新持久化一条日志: 操作前后摘要(高度/总元素数/不同键数)、受影响节点的
旧新高度、旋转类型与原因、局部边变化(父指针槽位的旧新孩子)。解释全部来自真实
递归插入/删除的向上修复过程, 不做整体重建, 也不把全部键重排后冒充局部维护。

## 输入范围与限制

- 键: 整数, 范围 [-1e15, 1e15]
- 不同键节点数上限默认 100000 (环境变量 `MAX_NODES` 可调); 递归实现, 树高约 1.44*log2(n), 无栈溢出风险
- 单批操作数上限 10000; 日志分页 pageSize <= 200
- 数据目录: 项目内 `data/` (环境变量 `DATA_DIR` / `DB_PATH` 可改)
- 端口: `--port` 或环境变量 `PORT`; 默认从 3000 探测, 被占用则自动选空闲端口

## HTTP API

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/sets` | 创建集合 `{name?}` |
| GET | `/sets` | 列出集合 |
| POST | `/sets/:id/insert` | 插入 `{key}` |
| POST | `/sets/:id/delete` | 删除一次 `{key}` |
| POST | `/sets/:id/batch` | 批量 `{requestId, ops:[{op,key}]}` |
| GET | `/sets/:id/query?key=` | 查询路径/计数/严格前驱后继/最值 |
| GET | `/sets/:id/tree?version=` | 查看某版本的树(省略为最新) |
| GET | `/sets/:id/logs?page=&pageSize=` | 旋转日志(分页) |
| GET | `/sets/:id/stats` | 版本与统计 |
| GET | `/sets/:id/export` | 导出快照+全部日志 JSON |

错误统一为 `{ "error": { "code", "message" } }`, 错误码包括:
`INVALID_KEY` `INVALID_OP` `INVALID_BATCH` `INVALID_REQUEST` `INVALID_VERSION`
`INVALID_PAGING` `SET_NOT_FOUND` `VERSION_NOT_FOUND` `LIMIT_EXCEEDED`
`INVALID_JSON` `PAYLOAD_TOO_LARGE` `NOT_FOUND`。

## 批量与幂等

- 批量操作按输入顺序执行; 先校验全部参数, 任一非法则整批拒绝, 版本不变
- 执行中发生异常时数据库事务回滚, 内存树从起始版本快照恢复
- `requestId` 去重: 同一 `(setId, requestId)` 重复提交直接返回首次结果 (`duplicate: true`), 不会多插

## 持久化与恢复

SQLite (`data/avl.db`) 保存三类数据: 每个版本的完整树快照、每次成功更新的日志、
幂等请求记录。重启后从最新快照恢复, 继续更新与不中断执行结构一致;
历史版本快照全部保留, `tree --version N` 可查任意历史版本, 历史旋转日志不被伪造。

## 独立结构检查器

`src/checker.ts` 从根重新遍历, 不信任节点自报高度, 核对:
无环、无共享子节点、BST 键顺序(上下界)、计数为正、真实高度与自报高度一致、
平衡因子绝对值 <= 1、总元素数与不同键数统计一致。
随机对照测试中每一步都运行该检查器。

## 测试

`npm test` 覆盖: 空集、单节点、删除根、重复计数归零、后继含多个出现的迁移、
多层删除修复、删除时孩子平衡因子为 0 的旋转、四种旋转触发、查询路径与前后驱、
节点上限、非法批次回滚、幂等重复提交、保存重启后继续操作与历史版本查询、
日志分页, 以及固定种子(42/1337/20261005)各 2000 步随机操作与排序数组基准的逐步对照。

## 已知限制

- 单进程服务, 无并发事务隔离 (多客户端并发写同一集合按到达顺序串行处理)
- 每版本保存完整快照, 侧重教学可解释性而非存储效率
- `node:sqlite` 在 Node 25 仍标记为实验特性, 启动时有一条 ExperimentalWarning, 不影响功能
