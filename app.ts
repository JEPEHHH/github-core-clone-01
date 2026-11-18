// The entry's HTTP server. main.ts owns the lifecycle and mounts this; everything the contest scores
// hangs off createApp(): the boot probe, the git smart-HTTP surface under /<owner>/<repo>.git, the
// REST v3 API under /api/v3, and a JSON 404 for anything else.
//
// A request without a bearer token is 401 (except the boot probe, which the env sends bare). The
// Authorization value is never logged or echoed: the store keys repositories by name and binds each
// to the first owner path that reaches it (forge/repos.ts).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Registry, forgeRoot } from './forge/repos.ts';
import { HttpError, handleRest, readBody, sendJson } from './forge/rest.ts';
import { handleMcp } from './forge/mcp.ts';
import {
  RECEIVE_PACK_ADVERTISEMENT,
  RECEIVE_PACK_RESULT,
  UPLOAD_PACK_ADVERTISEMENT,
  UPLOAD_PACK_RESULT,
  handleReceivePack,
  handleUploadPack,
  receivePackAdvertisement,
  uploadPackAdvertisement,
  uploadPackAdvertisementV0,
} from './forge/smart.ts';

const GIT_PATH = /^\/([^/]+)\/(.+)\.git(\/.*)?$/;

const registry = new Registry(forgeRoot());

function sendBytes(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'cache-control': 'no-cache',
  });
  res.end(body);
}

async function handleGit(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  owner: string,
  name: string,
  suffix: string,
): Promise<void> {
  const repo = registry.resolve(name, owner);
  if (repo === null) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const store = registry.store(repo.name);
  const method = req.method ?? 'GET';

  if (suffix === '/info/refs' && method === 'GET') {
    const service = url.searchParams.get('service') ?? '';
    if (service === 'git-upload-pack') {
      const wantsV2 = (req.headers['git-protocol'] ?? '').includes('version=2');
      sendBytes(res, 200, UPLOAD_PACK_ADVERTISEMENT, wantsV2 ? uploadPackAdvertisement() : uploadPackAdvertisementV0(store));
      return;
    }
    if (service === 'git-receive-pack') {
      sendBytes(res, 200, RECEIVE_PACK_ADVERTISEMENT, receivePackAdvertisement(store));
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  if (suffix === '/git-upload-pack' && method === 'POST') {
    const body = await readBody(req, 64 * 1024 * 1024);
    let answer: Buffer;
    try {
      answer = handleUploadPack(store, body);
    } catch (err) {
      sendJson(res, 400, { message: err instanceof Error ? err.message : 'bad upload-pack request' });
      return;
    }
    sendBytes(res, 200, UPLOAD_PACK_RESULT, answer);
    return;
  }

  if (suffix === '/git-receive-pack' && method === 'POST') {
    const body = await readBody(req, 64 * 1024 * 1024);
    let answer: Buffer;
    try {
      answer = handleReceivePack(store, body);
    } catch (err) {
      sendJson(res, 400, { message: err instanceof Error ? err.message : 'bad receive-pack request' });
      return;
    }
    sendBytes(res, 200, RECEIVE_PACK_RESULT, answer);
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://entry');
  } catch {
    sendJson(res, 400, { message: 'malformed request URL' });
    return;
  }
  const path = url.pathname;

  if (path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  if ((req.headers.authorization ?? '') === '') {
    sendJson(res, 401, { message: 'Requires authentication' });
    return;
  }

  if (path === '/mcp') {
    if ((req.method ?? 'GET') !== 'POST') {
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return;
    }
    await handleMcp(registry, req, res);
    return;
  }

  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    const handled = await handleRest({ registry, url, method: req.method ?? 'GET', req }, res);
    if (!handled) sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  const match = GIT_PATH.exec(path);
  if (match !== null) {
    const owner = decodeURIComponent(match[1] as string);
    const name = decodeURIComponent(match[2] as string);
    await handleGit(req, res, url, owner, name, match[3] ?? '');
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const server = createServer((req, res) => {
    route(req, res).catch((err: unknown) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (err instanceof HttpError) {
        sendJson(res, err.status, { message: err.message });
        return;
      }
      sendJson(res, 500, { message: err instanceof Error ? err.message : 'internal error' });
    });
  });
  server.keepAliveTimeout = 30_000;
  server.headersTimeout = 35_000;
  return server;
}
