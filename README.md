# AVL 有序多重集合教学服务

纯后端教学项目：TypeScript + Node.js + SQLite（`node:sqlite`，无原生依赖、无 Docker）。
提供 HTTP API 与 CLI，维护整数键的 AVL 有序多重集合，并对每次插入/删除给出真实的旋转与高度更新解释。

## 运行要求

- Windows 本地，Node.js >= 22.5（推荐 24+，本项目在 Node 25 上验证）
- 无需 Docker / WSL / 外部服务

## 快速开始（可直接复制）

```powershell
npm install
npm run build      # 编译 TypeScript 到 dist/
npm test           # 编译并运行全部测试
npm run demo       # 演示：四种旋转 + 重复键/两孩子连续删除
npm start          # 启动 HTTP 服务（默认 8000，被占用自动选空闲端口）
```

CLI 直接使用（数据库默认在项目内 `data/avl.db`，可用环境变量 `AVL_DB` 覆盖）：

```powershell
node dist/cli.js create 演示集合          # 输出集合 id，例如 1
node dist/cli.js insert 1 30
node dist/cli.js batch 1 "[{\"op\":\"insert\",\"key\":10},{\"op\":\"insert\",\"key\":20}]"
node dist/cli.js tree 1                   # 缩进树
node dist/cli.js query 1 20               # 从根开始的比较路径
node dist/cli.js logs 1 1 20              # 旋转日志（分页）
node dist/cli.js delete 1 30
node dist/cli.js check 1                  # 独立结构检查
node dist/cli.js export 1                 # 导出 JSON
node dist/cli.js serve 9000               # 指定端口启动 API
```

## 核心约定

- **高度约定**：空树高度为 0，叶子高度为 1，节点高度 = max(左, 右) + 1。
- **平衡因子**：左子树高度 - 右子树高度，绝对值不得超过 1。
- **多重集合**：相同键存于同一节点的 `count`；插入重复键只 +1，删除一次只 -1，计数归零才移除节点。
- **两孩子删除**：统一用中序后继替换，后继的键与全部计数一起迁移到被删位置，随后从删除位置向上重算高度并修复平衡。
- **旋转**：LL 单右旋、RR 单左旋、LR 先左后右、RL 先右后左；删除时孩子平衡因子为 0 归入 LL/RR 单旋情形。
- **统计**：`total`（总元素数，含重复）与 `distinct`（不同键数）分别统计。
- **节点上限**：单集合最多 100000 个节点（`MAX_NODES`），防止递归过深。
- **键范围**：32 位有符号整数（-2147483648 ~ 2147483647）。

## HTTP API

默认 `http://127.0.0.1:8000`（端口被占用时自动选择空闲端口，也可用 `PORT` 环境变量或 `serve <port>` 指定）。

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/sets` | 创建集合，body `{"name":"..."}` |
| GET | `/api/sets` | 列出集合 |
| GET | `/api/sets/:id` | 当前摘要与版本 |
| POST | `/api/sets/:id/insert` / `delete` | 单步插删，body `{"key":3,"requestId":"可选"}` |
| POST | `/api/sets/:id/batch` | 批量，body `{"requestId":"r1","ops":[{"op":"insert","key":3}]}` |
| GET | `/api/sets/:id/query?key=3` | 查询，返回从根开始的比较路径 |
| GET | `/api/sets/:id/tree?version=5` | 查看某版本的树（省略为最新） |
| GET | `/api/sets/:id/logs?page=1&size=20` | 旋转/更新日志（分页） |
| GET | `/api/sets/:id/min` / `max` | 最小/最大（空集返回 `exists:false`） |
| GET | `/api/sets/:id/predecessor?key=3` / `successor` | 严格前驱/后继（不存在返回 `exists:false`） |
| GET | `/api/sets/:id/check` | 独立结构检查 |
| GET | `/api/sets/:id/export` | 导出全部版本号、日志与当前快照 |

### 批量语义与幂等

- 批量操作按输入顺序在单个 SQLite 事务中执行；任一参数非法，整批回滚，版本不变。
- 携带 `requestId` 的请求具有幂等性：同一集合内重复提交同一 `requestId` 直接返回首次结果，不会多插一次。

### 错误码

`INVALID_KEY`（非整数或越界）、`INVALID_OP`、`EMPTY_BATCH`、`BATCH_TOO_LARGE`、`INVALID_REQUEST_ID`、`SET_NOT_FOUND`、`VERSION_NOT_FOUND`、`NODE_LIMIT`、`INVALID_JSON`、`PAYLOAD_TOO_LARGE`。错误响应形如 `{"error":{"code":"...","message":"..."}}`。

## 持久化与历史版本

SQLite（项目内 `data/` 目录）保存三张核心表：

- `versions`：每个成功版本的结构快照（含节点内部编号 `id`、键、计数、高度），重启后加载最新快照继续更新，与不间断运行一致；
- `logs`：每个版本的操作日志（前后摘要、受影响节点旧/新高度、旋转类型与原因、局部边变化、后继替换说明）；
- `requests`：`requestId` 到响应的映射，保证幂等。

历史版本可通过 `tree?version=N` 随时查询，旋转解释全部来自真实算法运行，不做事后伪造。

## 独立结构检查器

`checkStructure`（`src/avl.ts`）从根重新遍历，不信任节点自报数据，核对：无环、无共享子节点、二叉搜索顺序、计数为正、真实高度与平衡因子、total/distinct 统计一致。

## 测试

`npm test` 覆盖：空集、单节点、四种旋转、删除根、重复计数归零、后继含多个出现的两孩子删除、多层删除修复（含孩子平衡因子为 0 的情形）、严格前驱后继、非法批次回滚、幂等请求、保存重启后继续操作，以及固定种子 3000 步随机操作与排序数组基准的逐步对照（每步比对内容、查询、前驱后继并运行结构检查器）。

## 目录结构

```
src/avl.ts     AVL 核心（插入/删除/旋转/查询/检查器）
src/store.ts   SQLite 持久化（版本快照、日志、幂等请求、事务）
src/server.ts  HTTP API
src/cli.ts     命令行（缩进树与变化表展示）
src/demo.ts    演示脚本
test/          node:test 测试
data/          SQLite 数据目录
```

## 限制

- 单进程服务，无并发事务隔离与鉴权，仅供本地教学使用。
- 递归实现，节点数上限 100000（AVL 高度约 27 层，递归深度安全）。
- 每个版本保存完整快照，适合教学规模；未做增量存储优化。
- `node:sqlite` 在 Node 25 仍为实验特性，启动时会有 ExperimentalWarning 提示，不影响功能。
