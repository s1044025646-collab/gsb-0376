// HTTP API 服务 (仅使用 Node 内置模块)
import * as http from 'node:http';
import * as net from 'node:net';
import { SetService } from './service';
import { AvlError } from './avl';

function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 10 * 1024 * 1024) reject(new AvlError('PAYLOAD_TOO_LARGE', '请求体过大'));
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch { reject(new AvlError('INVALID_JSON', '请求体不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}

export function findFreePort(preferred: number): Promise<number> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => {
      const s2 = net.createServer();
      s2.listen(0, '127.0.0.1', () => {
        const p = (s2.address() as net.AddressInfo).port;
        s2.close(() => resolve(p));
      });
    });
    srv.listen(preferred, '127.0.0.1', () => {
      const p = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(p));
    });
  });
}

export async function startServer(service: SetService, port?: number): Promise<{ server: http.Server; port: number }> {
  const actualPort = port ?? (await findFreePort(Number(process.env.PORT) || 3000));

  const server = http.createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      const json = JSON.stringify(body, null, 2);
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(json);
    };
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      const parts = url.pathname.split('/').filter(Boolean);
      const body = req.method === 'POST' ? await readBody(req) : {};

      if (req.method === 'GET' && url.pathname === '/health') return send(200, { ok: true });
      if (req.method === 'GET' && url.pathname === '/sets') return send(200, { sets: service.listSets() });
      if (req.method === 'POST' && url.pathname === '/sets') return send(201, service.createSet(body.name));

      if (parts[0] === 'sets' && parts[1]) {
        const setId = parts[1];
        const sub = parts[2];
        if (req.method === 'POST' && sub === 'insert') return send(200, service.insert(setId, body.key));
        if (req.method === 'POST' && sub === 'delete') return send(200, service.delete(setId, body.key));
        if (req.method === 'POST' && sub === 'batch') return send(200, service.batch(setId, body.requestId, body.ops));
        if (req.method === 'GET' && sub === 'query') {
          const k = url.searchParams.get('key');
          if (k === null) throw new AvlError('INVALID_KEY', '缺少 key 查询参数');
          return send(200, service.query(setId, Number(k)));
        }
        if (req.method === 'GET' && sub === 'tree') {
          const v = url.searchParams.get('version');
          return send(200, service.treeAt(setId, v === null ? undefined : Number(v)));
        }
        if (req.method === 'GET' && sub === 'logs') {
          return send(200, service.logs(setId, Number(url.searchParams.get('page') || 1), Number(url.searchParams.get('pageSize') || 20)));
        }
        if (req.method === 'GET' && sub === 'stats') return send(200, service.stats(setId));
        if (req.method === 'GET' && sub === 'export') return send(200, service.export(setId));
      }
      return send(404, { error: { code: 'NOT_FOUND', message: '路由不存在' } });
    } catch (e: any) {
      if (e instanceof AvlError) return send(400, { error: { code: e.code, message: e.message } });
      return send(500, { error: { code: 'INTERNAL', message: String(e && e.message || e) } });
    }
  });

  await new Promise<void>((r) => server.listen(actualPort, '127.0.0.1', r));
  return { server, port: actualPort };
}
