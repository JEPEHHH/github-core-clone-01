// GitHub REST v3: the API root, /meta, the repository and contents APIs, branches and commits, labels,
// issues, comments, pull requests and their merge. Every reply is JSON with a non-empty
// X-GitHub-Request-Id, an unknown route is a JSON 404 and a malformed body is a 400. A repository
// belongs to the login the token names: the same name under another owner is a 404, never a 403.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Registry, RepoMeta } from './repos.ts';
import type { ObjectStore } from './objects.ts';
import { ZERO_OID, parseTree } from './objects.ts';
import { Records, globalId, type IssueRecord, type LabelRecord, type PullRecord } from './db.ts';
import {
  blobText,
  branchTip,
  buildTree,
  changeCounts,
  commitInfo,
  commitsSince,
  createCommit,
  diffTrees,
  flattenTree,
  isAncestor,
  resolveRef,
  trialIso,
  writeBlob,
  type FlatEntry,
} from './trees.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

let requestCounter = 0;

/** A per-process request id: monotonically increasing, never a clock reading. */
export function requestId(): string {
  requestCounter += 1;
  return `forge-${requestCounter.toString(16).padStart(6, '0')}`;
}

/** Every repository's issues, labels, comments and pull requests. */
export const records = new Records();

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': requestId(),
    ...headers,
  });
  res.end(text);
}

/** A reply with no body at all (204), still carrying the request id the protocol checks read. */
export function sendEmpty(res: ServerResponse, status: number): void {
  res.writeHead(status, { 'x-github-request-id': requestId(), 'content-length': '0' });
  res.end();
}

/** Read a request body, refusing one over `limit` bytes. */
export function readBody(req: IncomingMessage, limit = 8 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let length = 0;
    req.on('data', (chunk: Buffer) => {
      length += chunk.length;
      if (length > limit) {
        reject(new Error('request body is too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function ownerOf(repo: RepoMeta): Record<string, unknown> {
  return {
    login: repo.owner ?? 'unknown',
    id: repo.id,
    node_id: `U_${repo.id}`,
    type: 'User',
    site_admin: false,
  };
}

/** The repository object GitHub answers with, carrying the fields the checks read. */
export function repoJson(repo: RepoMeta): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: globalId('Repository', repo.id),
    name: repo.name,
    full_name: `${repo.owner ?? 'unknown'}/${repo.name}`,
    owner: ownerOf(repo),
    private: repo.private,
    description: repo.description,
    fork: false,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.createdAt,
    pushed_at: repo.createdAt,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    visibility: repo.private ? 'private' : 'public',
    open_issues_count: 0,
  };
}

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Parse a JSON object body; throws a 400-shaped error for anything else. */
export async function jsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(req);
  if (raw.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new HttpError(400, 'Problems parsing JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError(400, 'Body should be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

function str(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  return typeof value === 'string' ? value : '';
}

function num(body: Record<string, unknown>, key: string): number | null {
  const value = body[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function bool(body: Record<string, unknown>, key: string): boolean | null {
  const value = body[key];
  return typeof value === 'boolean' ? value : null;
}

// ---------------------------------------------------------------------------------------------
// the shapes the replies use

function labelJson(label: LabelRecord): Record<string, unknown> {
  return {
    id: label.id,
    node_id: globalId('Label', label.id),
    name: label.name,
    color: label.color,
    default: false,
    description: label.description,
  };
}

function commentJson(comment: { id: number; body: string; createdAt: string; login: string }): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: globalId('IssueComment', comment.id),
    body: comment.body,
    created_at: comment.createdAt,
    updated_at: comment.createdAt,
    user: userJson(comment.login),
  };
}

function userJson(login: string): Record<string, unknown> {
  return { login, id: 1, node_id: globalId('User', 1), type: 'User', site_admin: false };
}

function issueJson(issue: IssueRecord, repo: RepoMeta): Record<string, unknown> {
  const labels = issue.labels.map((name) => records.of(repo.name).labels.get(name)).filter((label): label is LabelRecord => label !== undefined);
  return {
    id: issue.id,
    node_id: globalId('Issue', issue.id),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    labels: labels.map(labelJson),
    user: userJson(issue.login),
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    repository_url: `/api/v3/repos/${repo.owner ?? 'unknown'}/${repo.name}`,
  };
}

function refJson(ref: string, sha: string): Record<string, unknown> {
  return { label: ref, ref, sha, user: userJson('forge'), repo: null };
}

function pullJson(pull: PullRecord, repo: RepoMeta): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: globalId('PullRequest', pull.id),
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    head: refJson(pull.head, pull.headSha),
    base: refJson(pull.base, pull.baseSha),
    user: userJson(pull.login),
    repo: { name: repo.name, full_name: `${repo.owner ?? 'unknown'}/${repo.name}` },
  };
}

// ---------------------------------------------------------------------------------------------
// the router

export interface RestContext {
  readonly registry: Registry;
  readonly url: URL;
  readonly method: string;
  readonly req: IncomingMessage;
}

interface Route {
  readonly registry: Registry;
  readonly store: ObjectStore;
  readonly repo: RepoMeta;
  readonly owner: string;
  readonly rest: string[];
  readonly url: URL;
  readonly req: IncomingMessage;
  readonly method: string;
}

function sameName(a: string | undefined, b: string): boolean {
  return a !== undefined && a.toLowerCase() === b.toLowerCase();
}

/** Answer one REST request. Returns false when the path is not a REST route this forge serves. */
export async function handleRest(context: RestContext, res: ServerResponse): Promise<boolean> {
  const { registry, url, method, req } = context;
  const path = url.pathname;
  if (!path.startsWith('/api/v3')) return false;
  const segments = path
    .slice('/api/v3'.length)
    .split('/')
    .filter((segment) => segment !== '')
    .map((segment) => decodeURIComponent(segment));

  // GET /api/v3/ and GET /api/v3
  if (segments.length === 0) {
    if (method !== 'GET') throw new HttpError(405, 'Method Not Allowed');
    sendJson(
      res,
      200,
      {
        current_user_url: '/api/v3/user',
        repository_url: '/api/v3/repos/{owner}/{repo}',
        user_repositories_url: '/api/v3/user/repos',
        rate_limit_url: '/api/v3/rate_limit',
      },
      { 'x-oauth-scopes': 'repo, read:org' },
    );
    return true;
  }

  if (segments.length === 1 && sameName(segments[0], 'meta')) {
    sendJson(res, 200, {
      verifiable_password_authentication: false,
      ssh_key_fingerprints: {},
      installed_version: 'forge-1.0.0',
    });
    return true;
  }

  if (sameName(segments[0], 'user')) {
    if (segments.length === 2 && sameName(segments[1], 'repos')) {
      if (method === 'GET') {
        pageRepos(registry, url, req, res);
        return true;
      }
      if (method === 'POST') {
        const body = await jsonBody(req);
        const name = str(body, 'name').trim();
        if (!/^[A-Za-z0-9._-]{1,100}$/.test(name)) throw new HttpError(422, 'Repository name is invalid');
        if (registry.get(name) !== null) throw new HttpError(422, 'Repository creation failed: name already exists on this account');
        const repo = registry.create(name, {
          description: str(body, 'description'),
          private: bool(body, 'private') === true,
        });
        // A repository the token creates belongs to the login it names, learned from the path the
        // first REST or git request takes to it (repos.ts resolve); the id is the create's.
        sendJson(res, 201, repoJson(repo));
        return true;
      }
      throw new HttpError(405, 'Method Not Allowed');
    }
    if (method === 'GET') {
      const login = registry.viewer();
      sendJson(res, 200, { login, id: 1, node_id: globalId('User', 1), type: 'User', site_admin: false });
      return true;
    }
  }

  if (!sameName(segments[0], 'repos') || segments.length < 3) return false;
  const owner = segments[1] as string;
  const name = segments[2] as string;
  const repo = registry.resolve(name, owner);
  if (repo === null) throw new HttpError(404, 'Not Found');
  const route: Route = {
    registry,
    store: registry.store(repo.name),
    repo,
    owner,
    rest: segments.slice(3),
    url,
    req,
    method,
  };
  return restRoute(route, res);
}

/** /user/repos: the viewer's repositories, `per_page` at a time, with a Link rel="next" chain. */
function pageRepos(registry: Registry, url: URL, req: IncomingMessage, res: ServerResponse): void {
  const perPageRaw = Number.parseInt(url.searchParams.get('per_page') ?? '30', 10);
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(perPageRaw, 100) : 30;
  const pageRaw = Number.parseInt(url.searchParams.get('page') ?? '1', 10);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const all = registry.list();
  const start = (page - 1) * perPage;
  const items = all.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  const origin = `http://${req.headers.host ?? 'entry'}`;
  const link = (target: number): string => {
    const next = new URL(url.pathname, origin);
    for (const [key, value] of url.searchParams) next.searchParams.set(key, value);
    next.searchParams.set('per_page', String(perPage));
    next.searchParams.set('page', String(target));
    return `<${next.toString()}>`;
  };
  const links: string[] = [];
  if (start + perPage < all.length) links.push(`${link(page + 1)}; rel="next"`);
  if (page > 1) links.push(`${link(page - 1)}; rel="prev"`);
  links.push(`${link(Math.max(1, Math.ceil(all.length / perPage)))}; rel="last"`);
  headers.link = links.join(', ');
  sendJson(res, 200, items.map(repoJson), headers);
}

async function restRoute(route: Route, res: ServerResponse): Promise<boolean> {
  const { store, repo, rest, method, req, url } = route;
  const data = records.of(repo.name);

  // /repos/{owner}/{repo}
  if (rest.length === 0) {
    if (method === 'GET') {
      sendJson(res, 200, repoJson(repo));
      return true;
    }
    if (method === 'PATCH' || method === 'POST') {
      const body = await jsonBody(req);
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.private = body.private;
      if (typeof body.default_branch === 'string' && body.default_branch !== '') repo.defaultBranch = body.default_branch;
      route.registry.persist();
      sendJson(res, 200, repoJson(repo));
      return true;
    }
    if (method === 'DELETE') {
      route.registry.remove(repo.name);
      records.remove(repo.name);
      sendEmpty(res, 204);
      return true;
    }
    throw new HttpError(405, 'Method Not Allowed');
  }

  const head = rest[0] as string;

  if (sameName(head, 'contents')) {
    const filePath = rest.slice(1).join('/');
    if (filePath === '') throw new HttpError(404, 'Not Found');
    if (method === 'GET') return getContents(route, filePath, res);
    if (method === 'PUT') return putContents(route, filePath, res);
    if (method === 'DELETE') return deleteContents(route, filePath, res);
    throw new HttpError(405, 'Method Not Allowed');
  }

  if (sameName(head, 'branches') && rest.length === 1 && method === 'GET') {
    const branches = [...store.refs.keys()]
      .filter((ref) => ref.startsWith('refs/heads/'))
      .sort()
      .map((ref) => ({
        name: ref.slice('refs/heads/'.length),
        commit: { sha: store.refs.get(ref) as string, url: `${url.pathname}` },
        protected: false,
      }));
    sendJson(res, 200, branches);
    return true;
  }

  if (sameName(head, 'commits') && rest.length === 1 && method === 'GET') {
    const wanted = url.searchParams.get('sha') ?? url.searchParams.get('ref') ?? repo.defaultBranch;
    const tip = resolveRef(store, wanted, repo.defaultBranch);
    const limitRaw = Number.parseInt(url.searchParams.get('per_page') ?? '100', 10);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 100) : 100;
    const list = commitsSince(store, tip, [], limit).map((sha) => commitJson(store, sha, route));
    sendJson(res, 200, list);
    return true;
  }

  if (sameName(head, 'git') && rest.length >= 2) {
    const what = rest[1] as string;
    if (sameName(what, 'refs')) {
      if (method === 'GET' && rest.length === 2) {
        const refs = [...store.refs.entries()].map(([ref, oid]) => ({
          ref,
          node_id: globalId('Ref', 1),
          object: { sha: oid, type: 'commit' },
        }));
        sendJson(res, 200, refs);
        return true;
      }
      if (method === 'POST' && rest.length === 2) return createRef(route, res);
      if (method === 'PATCH' && rest.length === 3) return patchRef(route, rest[2] as string, res);
      if (method === 'DELETE' && rest.length === 3) {
        const ref = `refs/heads/${rest[2] as string}`;
        store.deleteRef(ref);
        store.persistRefs();
        sendEmpty(res, 204);
        return true;
      }
    }
    if (sameName(what, 'ref') && method === 'GET' && rest.length === 4) {
      const ref = `refs/${rest[2] as string}/${rest[3] as string}`;
      const oid = store.refs.get(ref);
      if (oid === undefined) throw new HttpError(404, 'Not Found');
      sendJson(res, 200, { ref, node_id: globalId('Ref', 1), object: { sha: oid, type: 'commit' } });
      return true;
    }
    if (sameName(what, 'trees') && method === 'GET' && rest.length >= 3) {
      const sha = resolveRef(store, rest[2] as string, repo.defaultBranch);
      if (sha === null) throw new HttpError(404, 'Not Found');
      const info = commitInfo(store, sha);
      const treeOid = info === null ? sha : info.tree;
      const flat = flattenTree(store, treeOid);
      const entries = [...flat.entries()].map(([entryPath, entry]) => ({
        path: entryPath,
        mode: entry.mode,
        type: 'blob',
        sha: entry.oid,
        size: blobText(store, entry.oid).length,
      }));
      sendJson(res, 200, { sha: treeOid, url: url.pathname, tree: entries, truncated: false });
      return true;
    }
  }

  if (sameName(head, 'labels')) {
    if (rest.length === 1) {
      if (method === 'GET') {
        sendJson(res, 200, [...data.labels.values()].map(labelJson));
        return true;
      }
      if (method === 'POST') {
        const body = await jsonBody(req);
        const labelName = str(body, 'name').trim();
        if (labelName === '') throw new HttpError(422, 'Validation Failed: name is required');
        const label = data.addLabel(labelName, str(body, 'color') || 'ededed', str(body, 'description'));
        sendJson(res, 201, labelJson(label));
        return true;
      }
    }
    throw new HttpError(404, 'Not Found');
  }

  if (sameName(head, 'issues')) {
    if (rest.length === 1) {
      if (method === 'GET') {
        sendJson(res, 200, listIssues(data, url, repo));
        return true;
      }
      if (method === 'POST') return createIssue(route, res);
    }
    if (rest.length >= 2) {
      const number = Number.parseInt(rest[1] as string, 10);
      const issue = Number.isFinite(number) ? data.issueByNumber(number) : null;
      if (rest.length === 2) {
        if (issue === null) throw new HttpError(404, 'Not Found');
        if (method === 'GET') {
          sendJson(res, 200, issueJson(issue, repo));
          return true;
        }
        if (method === 'PATCH') return patchIssue(route, issue, res);
      }
      if (rest.length === 3 && sameName(rest[2], 'comments')) {
        if (issue === null) throw new HttpError(404, 'Not Found');
        if (method === 'GET') {
          sendJson(res, 200, issue.comments.map(commentJson));
          return true;
        }
        if (method === 'POST') {
          const body = await jsonBody(req);
          const text = str(body, 'body');
          const comment = data.addComment(issue, text, repo.owner ?? 'unknown');
          sendJson(res, 201, commentJson(comment));
          return true;
        }
      }
    }
    throw new HttpError(404, 'Not Found');
  }

  if (sameName(head, 'pulls')) {
    if (rest.length === 1) {
      if (method === 'GET') {
        const state = url.searchParams.get('state') ?? 'open';
        const list = data.pulls
          .filter((pull) => state === 'all' || pull.state === state || (state === 'closed' && pull.merged))
          .sort((a, b) => a.number - b.number);
        sendJson(res, 200, list.map((pull) => pullJson(pull, repo)));
        return true;
      }
      if (method === 'POST') return createPull(route, res);
    }
    if (rest.length >= 2) {
      const number = Number.parseInt(rest[1] as string, 10);
      const pull = Number.isFinite(number) ? data.pullByNumber(number) : null;
      if (rest.length === 2) {
        if (pull === null) throw new HttpError(404, 'Not Found');
        if (method === 'GET') {
          sendJson(res, 200, pullJson(pull, repo));
          return true;
        }
        if (method === 'PATCH') {
          const body = await jsonBody(req);
          const title = str(body, 'title');
          const text = str(body, 'body');
          const patched = { ...pull, title: title === '' ? pull.title : title, body: text === '' ? pull.body : text, state: str(body, 'state') === 'closed' ? 'closed' : pull.state } as PullRecord;
          Object.assign(pull, patched);
          sendJson(res, 200, pullJson(pull, repo));
          return true;
        }
      }
      if (rest.length === 3 && sameName(rest[2], 'files') && method === 'GET') {
        if (pull === null) throw new HttpError(404, 'Not Found');
        sendJson(res, 200, pullFiles(store, pull));
        return true;
      }
      if (rest.length === 3 && sameName(rest[2], 'merge') && (method === 'PUT' || method === 'POST')) {
        if (pull === null) throw new HttpError(404, 'Not Found');
        return mergePull(route, pull, res);
      }
    }
    throw new HttpError(404, 'Not Found');
  }

  throw new HttpError(404, 'Not Found');
}

// ---------------------------------------------------------------------------------------------
// repositories: refs, commits, contents

function commitJson(store: ObjectStore, sha: string, route: Route): Record<string, unknown> {
  const info = commitInfo(store, sha);
  if (info === null) return { sha, commit: { message: '' }, parents: [] };
  const date = info.authorLine.split(' ').slice(-2).join(' ');
  const seconds = Number.parseInt(info.authorLine.split(' ').slice(-2, -1)[0] ?? '0', 10);
  const iso = Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z') : trialIso();
  return {
    sha,
    node_id: globalId('Commit', 1),
    commit: {
      message: info.message,
      author: { name: 'forge', email: 'forge@example.invalid', date: iso },
      committer: { name: 'forge', email: 'forge@example.invalid', date: iso },
      tree: { sha: info.tree },
      url: `${route.url.pathname.replace(/\/commits.*$/, '')}/git/commits/${sha}`,
      comment_count: 0,
      verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
    },
    url: `${route.url.pathname.replace(/\/commits.*$/, '')}/commits/${sha}`,
    html_url: null,
    parents: info.parents.map((parent) => ({ sha: parent })),
  };
}

async function createRef(route: Route, res: ServerResponse): Promise<boolean> {
  const body = await jsonBody(route.req);
  const ref = str(body, 'ref');
  const sha = str(body, 'sha');
  if (!ref.startsWith('refs/') || !/^[0-9a-f]{40}$/.test(sha)) throw new HttpError(422, 'Validation Failed: ref and sha are required');
  if (!route.store.has(sha)) throw new HttpError(422, 'Object does not exist');
  route.store.setRef(ref, sha);
  route.store.persistRefs();
  sendJson(res, 201, { ref, node_id: globalId('Ref', 1), object: { sha, type: 'commit' } });
  return true;
}

async function patchRef(route: Route, branch: string, res: ServerResponse): Promise<boolean> {
  const body = await jsonBody(route.req);
  const ref = `refs/heads/${branch}`;
  const sha = str(body, 'sha');
  const force = bool(body, 'force') === true;
  if (!/^[0-9a-f]{40}$/.test(sha) || !route.store.has(sha)) throw new HttpError(422, 'Object does not exist');
  const current = route.store.refs.get(ref);
  if (!force && current !== undefined && !isAncestor(route.store, current, sha)) {
    throw new HttpError(422, 'Update is not a fast forward');
  }
  route.store.setRef(ref, sha);
  route.store.persistRefs();
  sendJson(res, 200, { ref, object: { sha, type: 'commit' } });
  return true;
}

function refTree(store: ObjectStore, repo: RepoMeta, ref: string): { sha: string; tree: string } | null {
  const oid = resolveRef(store, ref, repo.defaultBranch);
  if (oid === null) return null;
  const info = commitInfo(store, oid);
  if (info === null) return null;
  return { sha: oid, tree: info.tree };
}

function getContents(route: Route, filePath: string, res: ServerResponse): boolean {
  const { store, repo, url } = route;
  const ref = url.searchParams.get('ref') ?? repo.defaultBranch;
  const resolved = refTree(store, repo, ref);
  if (resolved === null) throw new HttpError(404, 'Not Found');
  const flat = flattenTree(store, resolved.tree);
  const entry = flat.get(filePath);
  if (entry !== undefined) {
    const object = store.read(entry.oid);
    const bytes = object === null ? Buffer.alloc(0) : object.data;
    sendJson(res, 200, {
      type: 'file',
      encoding: 'base64',
      size: bytes.length,
      name: filePath.split('/').pop() ?? filePath,
      path: filePath,
      content: bytes.toString('base64'),
      sha: entry.oid,
      url: url.pathname,
      git_url: null,
      html_url: null,
      download_url: null,
    });
    return true;
  }
  const prefix = `${filePath.replace(/\/$/, '')}/`;
  const children = new Map<string, { type: 'file' | 'dir'; path: string; sha: string; size: number }>();
  for (const [candidate, meta] of flat) {
    if (!candidate.startsWith(prefix)) continue;
    const remainder = candidate.slice(prefix.length);
    const slash = remainder.indexOf('/');
    const childPath = slash === -1 ? candidate : `${prefix}${remainder.slice(0, slash)}`;
    if (children.has(childPath)) continue;
    if (slash === -1) {
      const object = store.read(meta.oid);
      children.set(childPath, { type: 'file', path: childPath, sha: meta.oid, size: object === null ? 0 : object.data.length });
    } else {
      children.set(childPath, { type: 'dir', path: childPath, sha: meta.oid, size: 0 });
    }
  }
  if (children.size === 0) throw new HttpError(404, 'Not Found');
  sendJson(
    res,
    200,
    [...children.values()].map((child) => ({
      type: child.type,
      name: child.path.split('/').pop() ?? child.path,
      path: child.path,
      sha: child.sha,
      size: child.size,
      url: url.pathname,
      git_url: null,
      html_url: null,
      download_url: null,
    })),
  );
  return true;
}

interface CommitResult {
  readonly sha: string;
  readonly tree: string;
}

/** Commit one mutation onto `branch` and move the ref; the store's one write path for REST edits. */
function commitToBranch(
  store: ObjectStore,
  repo: RepoMeta,
  branch: string,
  message: string,
  mutate: (flat: Map<string, FlatEntry>) => void,
): CommitResult {
  const tip = branchTip(store, branch);
  const baseTree = tip === null ? null : commitInfo(store, tip)?.tree ?? null;
  const flat = baseTree === null ? new Map<string, FlatEntry>() : flattenTree(store, baseTree);
  mutate(flat);
  const tree = buildTree(store, flat);
  const sha = createCommit(store, { tree, parents: tip === null ? [] : [tip], message });
  store.setRef(`refs/heads/${branch}`, sha);
  store.persistRefs();
  return { sha, tree };
}

async function putContents(route: Route, filePath: string, res: ServerResponse): Promise<boolean> {
  const { store, repo } = route;
  const body = await jsonBody(route.req);
  const message = str(body, 'message');
  const branch = str(body, 'branch') === '' ? repo.defaultBranch : str(body, 'branch');
  const contentB64 = str(body, 'content');
  const providedSha = str(body, 'sha');
  if (message === '') throw new HttpError(422, 'Validation Failed: message is required');
  if (contentB64 === '') throw new HttpError(422, 'Validation Failed: content is required');
  const bytes = Buffer.from(contentB64, 'base64');

  const tip = branchTip(store, branch);
  const baseTree = tip === null ? null : commitInfo(store, tip)?.tree ?? null;
  const flat = baseTree === null ? new Map<string, FlatEntry>() : flattenTree(store, baseTree);
  const existing = flat.get(filePath) ?? null;
  if (providedSha !== '') {
    if (existing === null) throw new HttpError(422, 'Invalid request: sha was provided but the path does not exist');
    if (existing.oid !== providedSha) throw new HttpError(409, 'Conflict: sha does not match the current content');
  } else if (existing !== null) {
    // GitHub refuses an overwrite that names no sha; a create that already exists is a 422.
    throw new HttpError(422, 'Invalid request: "sha" wasn\'t supplied.');
  }

  const blob = writeBlob(store, bytes);
  const result = commitToBranch(store, repo, branch, message, (map) => {
    map.set(filePath, { mode: '100644', oid: blob });
  });
  sendJson(res, existing === null ? 201 : 200, {
    content: {
      name: filePath.split('/').pop() ?? filePath,
      path: filePath,
      sha: blob,
      size: bytes.length,
      type: 'file',
      encoding: 'base64',
      content: bytes.toString('base64'),
      url: route.url.pathname,
      git_url: null,
      html_url: null,
      download_url: null,
    },
    commit: {
      sha: result.sha,
      node_id: globalId('Commit', 1),
      message,
      author: { name: 'forge', email: 'forge@example.invalid', date: trialIso() },
      committer: { name: 'forge', email: 'forge@example.invalid', date: trialIso() },
      tree: { sha: result.tree },
      parents: [],
    },
  });
  return true;
}

async function deleteContents(route: Route, filePath: string, res: ServerResponse): Promise<boolean> {
  const { store, repo } = route;
  const body = await jsonBody(route.req);
  const message = str(body, 'message') === '' ? `Delete ${filePath}` : str(body, 'message');
  const branch = str(body, 'branch') === '' ? repo.defaultBranch : str(body, 'branch');
  const tip = branchTip(store, branch);
  const baseTree = tip === null ? null : commitInfo(store, tip)?.tree ?? null;
  const flat = baseTree === null ? new Map<string, FlatEntry>() : flattenTree(store, baseTree);
  if (!flat.has(filePath)) throw new HttpError(404, 'Not Found');
  const providedSha = str(body, 'sha');
  if (providedSha !== '' && flat.get(filePath)?.oid !== providedSha) throw new HttpError(409, 'Conflict: sha does not match the current content');
  const result = commitToBranch(store, repo, branch, message, (map) => {
    map.delete(filePath);
  });
  sendJson(res, 200, {
    content: null,
    commit: { sha: result.sha, message, tree: { sha: result.tree }, parents: [] },
  });
  return true;
}

// ---------------------------------------------------------------------------------------------
// issues, labels, comments

function listIssues(data: ReturnType<Records['of']>, url: URL, repo: RepoMeta): Record<string, unknown>[] {
  const state = url.searchParams.get('state') ?? 'open';
  const sort = url.searchParams.get('sort') ?? 'created';
  const direction = url.searchParams.get('direction') ?? 'desc';
  const filtered = data.issues.filter((issue) => state === 'all' || issue.state === state);
  const sorted = [...filtered].sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
  if (sort === 'updated') sorted.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
  return sorted.map((issue) => issueJson(issue, repo));
}

async function createIssue(route: Route, res: ServerResponse): Promise<boolean> {
  const { repo } = route;
  const body = await jsonBody(route.req);
  const title = str(body, 'title');
  if (title === '') throw new HttpError(422, 'Validation Failed: title is required');
  const rawLabels = body.labels;
  const labels: string[] = [];
  if (Array.isArray(rawLabels)) {
    for (const value of rawLabels) {
      if (typeof value !== 'string') continue;
      labels.push(value);
    }
  }
  const issue = createIssueRecord(repo, { title, body: str(body, 'body'), labels });
  sendJson(res, 201, issueJson(issue, repo));
  return true;
}

/** Create an issue on a repository's records: the REST route's write path, shared with MCP. */
export function createIssueRecord(
  repo: RepoMeta,
  input: { title: string; body: string; labels: readonly string[] },
): IssueRecord {
  const data = records.of(repo.name);
  for (const label of input.labels) {
    if (!data.hasLabel(label)) throw new HttpError(422, `Validation Failed: label "${label}" does not exist`);
  }
  return data.addIssue({
    title: input.title,
    body: input.body,
    labels: [...input.labels],
    login: repo.owner ?? 'unknown',
  });
}

async function patchIssue(route: Route, issue: IssueRecord, res: ServerResponse): Promise<boolean> {
  const body = await jsonBody(route.req);
  const state = str(body, 'state');
  if (state === 'closed' || state === 'open') {
    issue.state = state;
    issue.closedAt = state === 'closed' ? trialIso() : null;
    issue.updatedAt = trialIso();
  }
  const title = str(body, 'title');
  if (title !== '') {
    (issue as { title: string }).title = title;
    issue.updatedAt = trialIso();
  }
  sendJson(res, 200, issueJson(issue, route.repo));
  return true;
}

// ---------------------------------------------------------------------------------------------
// pull requests

async function createPull(route: Route, res: ServerResponse): Promise<boolean> {
  const { store, repo } = route;
  const body = await jsonBody(route.req);
  const pull = createPullRecord(store, repo, {
    title: str(body, 'title'),
    body: str(body, 'body'),
    head: str(body, 'head'),
    base: str(body, 'base'),
  });
  sendJson(res, 201, pullJson(pull, repo));
  return true;
}

/** Open a pull request on a repository's records: the REST route's write path, shared with MCP. */
export function createPullRecord(
  store: ObjectStore,
  repo: RepoMeta,
  input: { title: string; body: string; head: string; base: string },
): PullRecord {
  const data = records.of(repo.name);
  const rawHead = input.head;
  const head = rawHead.includes(':') ? rawHead.slice(rawHead.indexOf(':') + 1) : rawHead;
  const base = input.base === '' ? repo.defaultBranch : input.base;
  if (head === '') throw new HttpError(422, 'Validation Failed: head is required');
  const headSha = branchTip(store, head);
  const baseSha = branchTip(store, base);
  if (headSha === null) throw new HttpError(422, `Validation Failed: head ref ${head} does not exist`);
  if (baseSha === null) throw new HttpError(422, `Validation Failed: base ref ${base} does not exist`);
  return data.addPull({
    title: input.title,
    body: input.body,
    head,
    base,
    headSha,
    baseSha,
    login: repo.owner ?? 'unknown',
  });
}

/** The changed paths of a pull request: its branch's tree against the base it was opened on. */
function pullChanges(store: ObjectStore, pull: PullRecord): Array<{
  path: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  before: FlatEntry | null;
  after: FlatEntry | null;
}> {
  const baseInfo = commitInfo(store, pull.baseSha);
  const headInfo = commitInfo(store, pull.headSha);
  const diff = diffTrees(store, baseInfo?.tree ?? null, headInfo?.tree ?? null);
  return diff.map((entry) => {
    const status: 'added' | 'modified' | 'removed' = entry.before === null ? 'added' : entry.after === null ? 'removed' : 'modified';
    const counts = changeCounts(store, entry.before, entry.after);
    return { path: entry.path, status, ...counts, before: entry.before, after: entry.after };
  });
}

export function pullFiles(store: ObjectStore, pull: PullRecord): Record<string, unknown>[] {
  return pullChanges(store, pull).map((change) => ({
    filename: change.path,
    status: change.status,
    additions: change.additions,
    deletions: change.deletions,
    changes: change.additions + change.deletions,
    sha: change.after?.oid ?? change.before?.oid ?? ZERO_OID,
    blob_url: null,
    raw_url: null,
    contents_url: null,
    patch: '',
  }));
}

async function mergePull(route: Route, pull: PullRecord, res: ServerResponse): Promise<boolean> {
  const { store, repo } = route;
  const merged = mergePullRecord(store, repo, pull);
  sendJson(res, 200, merged);
  return true;
}

/** Merge a pull request into its base branch, squash-style; the REST route's write path, shared with MCP. */
export function mergePullRecord(store: ObjectStore, repo: RepoMeta, pull: PullRecord): { sha: string | null; merged: true; message: string } {
  if (pull.merged) {
    return { sha: pull.mergeCommitSha, merged: true, message: 'Pull Request already merged' };
  }
  const headTip = branchTip(store, pull.head);
  if (headTip !== null) pull.headSha = headTip;
  const baseTip = branchTip(store, pull.base);
  if (baseTip === null) throw new HttpError(422, `Base ref ${pull.base} has no commit`);

  const headChanges = pullChanges(store, pull);
  const baseInfo = commitInfo(store, pull.baseSha);
  const baseNowInfo = commitInfo(store, baseTip);
  const baseChanges = diffTrees(store, baseInfo?.tree ?? null, baseNowInfo?.tree ?? null);
  const basePaths = new Set(baseChanges.map((entry) => entry.path));
  const conflicted = headChanges.filter((change) => basePaths.has(change.path));
  if (conflicted.length > 0) throw new HttpError(405, `Pull Request is not mergeable: ${conflicted[0]?.path} conflicts`);

  const flat = baseNowInfo === null ? new Map<string, FlatEntry>() : flattenTree(store, baseNowInfo.tree);
  for (const change of headChanges) {
    if (change.after === null) flat.delete(change.path);
    else flat.set(change.path, change.after);
  }
  const tree = buildTree(store, flat);
  const message = `${pull.title} (#${pull.number})`;
  const sha = createCommit(store, { tree, parents: [baseTip], message });
  store.setRef(`refs/heads/${pull.base}`, sha);
  store.persistRefs();
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = trialIso();
  pull.mergeCommitSha = sha;
  pull.baseSha = sha;
  return { sha, merged: true, message: 'Pull Request successfully merged' };
}

/** The branch tip of a repository, for the MCP and GraphQL surfaces that share this store. */
export function tipOf(store: ObjectStore, repo: RepoMeta): string | null {
  return branchTip(store, repo.defaultBranch);
}

/** A blob's text at a path on a ref, for the surfaces that read file contents back. */
export function fileTextAt(store: ObjectStore, repo: RepoMeta, filePath: string, ref: string): string | null {
  const resolved = refTree(store, repo, ref);
  if (resolved === null) return null;
  const entry = flattenTree(store, resolved.tree).get(filePath);
  return entry === undefined ? null : blobText(store, entry.oid);
}

/** A tree's entry count at a path, for the directory shape the surfaces report. */
export function treeNamesAt(store: ObjectStore, repo: RepoMeta, ref: string): string[] {
  const resolved = refTree(store, repo, ref);
  if (resolved === null) return [];
  const object = store.read(resolved.tree);
  if (object === null || object.type !== 'tree') return [];
  return parseTree(object.data).map((entry) => entry.name);
}
