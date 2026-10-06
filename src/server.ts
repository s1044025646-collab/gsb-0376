import * as http from "node:http";
import * as net from "node:net";
import { Store } from "./store";
import { AvlError, AvlMultiset, checkStructure } from "./avl";

function parseKeyParam(url: URL): number {
  const raw = url.searchParams.get("key");
  if (raw === null || !/^-?\d+$/.test(raw)) throw new AvlError("INVALID_KEY", `查询参数 key 必须是整数，收到: ${raw}`);
  return AvlMultiset.validateKey(Number(raw));
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body, null, 2);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(data);
}

function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let buf = "";
    req.on("data", c => {
      buf += c;
      if (buf.length > 10 * 1024 * 1024) reject(new AvlError("PAYLOAD_TOO_LARGE", "请求体超过 10MB"));
    });
    req.on("end", () => {
      if (!buf) return resolve({});
      try { resolve(JSON.parse(buf)); } catch { reject(new AvlError("INVALID_JSON", "请求体不是合法 JSON")); }
    });
    req.on("error", reject);
  });
}

export async function findFreePort(preferred: number): Promise<number> {
  const tryPort = (p: number) => new Promise<boolean>(resolve => {
    const s = net.createServer().once("error", () => resolve(false)).once("listening", () => s.close(() => resolve(true))).listen(p, "127.0.0.1");
  });
  if (preferred > 0 && await tryPort(preferred)) return preferred;
  return new Promise(resolve => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
}

export function createServer(store: Store): http.Server {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const m = url.pathname.match(/^\/api\/sets(?:\/(\d+))?(?:\/([a-z]+))?$/);
      const method = req.method ?? "GET";

      if (url.pathname === "/api/sets" && method === "POST") {
        const body = await readBody(req);
        const name = typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 100) : "未命名集合";
        return send(res, 201, { setId: store.createSet(name), name });
      }
      if (url.pathname === "/api/sets" && method === "GET") return send(res, 200, { sets: store.listSets() });
      if (!m || !m[1]) return send(res, 404, { error: { code: "NOT_FOUND", message: "未知路由" } });
      const setId = Number(m[1]);
      const action = m[2] ?? "";

      if (action === "" && method === "GET") {
        const tree = store.load(setId);
        return send(res, 200, { setId, summary: tree.summary(), version: tree.version });
      }
      if (action === "batch" && method === "POST") {
        const body = await readBody(req);
        return send(res, 200, { setId, ...store.apply(setId, body.ops, body.requestId) });
      }
      if ((action === "insert" || action === "delete") && method === "POST") {
        const body = await readBody(req);
        const result = store.apply(setId, [{ op: action, key: body.key }], body.requestId);
        return send(res, result.logs[0].found ? 200 : 404, { setId, ...result });
      }
      if (action === "query" && method === "GET") {
        const key = parseKeyParam(url);
        const tree = store.load(setId);
        return send(res, 200, { setId, version: tree.version, ...tree.queryPath(key) });
      }
      if (action === "tree" && method === "GET") {
        const v = url.searchParams.get("version");
        return send(res, 200, { setId, tree: store.treeAt(setId, v === null ? undefined : Number(v)) });
      }
      if (action === "logs" && method === "GET") {
        return send(res, 200, { setId, ...store.logs(setId, Number(url.searchParams.get("page") ?? 1), Number(url.searchParams.get("size") ?? 20)) });
      }
      if (action === "export" && method === "GET") return send(res, 200, store.exportAll(setId));
      if (action === "check" && method === "GET") return send(res, 200, { setId, ...checkStructure(store.load(setId)) });
      if (["min", "max"].includes(action) && method === "GET") {
        const tree = store.load(setId);
        const r = action === "min" ? tree.min() : tree.max();
        return send(res, 200, { setId, result: r, exists: r !== null });
      }
      if (["predecessor", "successor"].includes(action) && method === "GET") {
        const key = parseKeyParam(url);
        const tree = store.load(setId);
        const r = action === "predecessor" ? tree.predecessor(key) : tree.successor(key);
        return send(res, 200, { setId, key, result: r, exists: r !== null });
      }
      return send(res, 404, { error: { code: "NOT_FOUND", message: "未知路由" } });
    } catch (e) {
      if (e instanceof AvlError) {
        const status = e.code === "SET_NOT_FOUND" || e.code === "VERSION_NOT_FOUND" ? 404
          : e.code === "NODE_LIMIT" ? 507 : 400;
        return send(res, status, { error: { code: e.code, message: e.message } });
      }
      return send(res, 500, { error: { code: "INTERNAL", message: String(e) } });
    }
  });
}
