// The Model Context Protocol endpoint at /mcp: JSON-RPC 2.0 over the Streamable HTTP transport, on the
// 2026-07-28 revision (server/discover, no handshake, no session), with the six github-mcp-server tools
// acting on the same store as REST. Every request declares its revision in `_meta`; answers are one
// application/json body. A body that is not JSON is HTTP 400 with -32700, an unknown tool -32602, and a
// request without a bearer token is 401 (app.ts answers that before this module sees it).

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Registry, RepoMeta } from './repos.ts';
import {
  HttpError,
  createIssueRecord,
  createPullRecord,
  mergePullRecord,
  readBody,
  records,
  repoJson,
  requestId,
} from './rest.ts';

export const MCP_REVISION = '2026-07-28';

const SERVER_INFO = { name: 'forge-github-core-clone', version: '1.0.0' } as const;

const JSON_TYPE = 'application/json; charset=utf-8';

interface ToolSpec {
  readonly name: string;
  readonly description: string;
  readonly properties: Record<string, { type: string; description: string }>;
  readonly required: readonly string[];
}

/** The six tools the agent-native arm requires, with the argument names github-mcp-server documents. */
const TOOLS: readonly ToolSpec[] = [
  {
    name: 'create_repo',
    description: 'Create a repository in the forge, with an optional description and visibility.',
    properties: {
      name: { type: 'string', description: 'The repository name.' },
      description: { type: 'string', description: 'A short description of the repository.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
    },
    required: ['name'],
  },
  {
    name: 'get_repo',
    description: 'Read one repository by its owner login and name.',
    properties: {
      owner: { type: 'string', description: 'The account login that owns the repository.' },
      repo: { type: 'string', description: 'The repository name.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_issue',
    description: 'Open an issue on a repository, with a title, an optional body and optional labels.',
    properties: {
      owner: { type: 'string', description: 'The account login that owns the repository.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The issue title.' },
      body: { type: 'string', description: 'The issue body, in Markdown.' },
    },
    required: ['owner', 'repo', 'title'],
  },
  {
    name: 'list_issues',
    description: 'List a repository\'s issues, filtered by state (open, closed or all).',
    properties: {
      owner: { type: 'string', description: 'The account login that owns the repository.' },
      repo: { type: 'string', description: 'The repository name.' },
      state: { type: 'string', description: 'The issue state to list: open, closed or all.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    properties: {
      owner: { type: 'string', description: 'The account login that owns the repository.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The pull request title.' },
      head: { type: 'string', description: 'The branch the changes come from.' },
      base: { type: 'string', description: 'The branch the changes go into.' },
    },
    required: ['owner', 'repo', 'title', 'head', 'base'],
  },
  {
    name: 'merge_pull_request',
    description: 'Merge an open pull request into its base branch.',
    properties: {
      owner: { type: 'string', description: 'The account login that owns the repository.' },
      repo: { type: 'string', description: 'The repository name.' },
      pull_number: { type: 'number', description: 'The pull request number to merge.' },
    },
    required: ['owner', 'repo', 'pull_number'],
  },
];

/** The tool list as tools/list answers it: a frozen order, so two calls answer byte for byte. */
function toolsList(): Array<Record<string, unknown>> {
  return TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: {
      type: 'object',
      properties: Object.fromEntries(
        Object.entries(tool.properties).map(([key, value]) => [key, { type: value.type, description: value.description }]),
      ),
      required: [...tool.required],
      additionalProperties: false,
    },
  }));
}

class JsonRpcError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': requestId(),
  });
  res.end(text);
}

function rpcError(res: ServerResponse, status: number, id: unknown, code: number, message: string): void {
  send(res, status, { jsonrpc: '2.0', id: id ?? null, error: { code, message } });
}

function toolResult(payload: unknown): Record<string, unknown> {
  return {
    resultType: 'complete',
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError: false,
  };
}

function toolFailure(message: string): Record<string, unknown> {
  return {
    resultType: 'complete',
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

function repoView(repo: RepoMeta): Record<string, unknown> {
  return { ...repoJson(repo), full_name: `${repo.owner ?? 'forge'}/${repo.name}` };
}

/** The repository a tool argument names, or an error the tool reports as isError. */
function repoFor(registry: Registry, args: Record<string, unknown>): RepoMeta {
  const owner = typeof args.owner === 'string' ? args.owner : 'forge';
  const name = typeof args.repo === 'string' ? args.repo : typeof args.full_name === 'string' ? String(args.full_name).split('/')[1] ?? '' : '';
  if (name === '') throw new JsonRpcError(-32602, 'Missing required argument: repo');
  const repo = registry.resolve(name, owner);
  if (repo === null) throw new JsonRpcError(-32602, `Repository ${owner}/${name} not found`);
  return repo;
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value === '') throw new JsonRpcError(-32602, `Missing required argument: ${key}`);
  return value;
}

/** Run one tools/call and answer its result (or a JSON-RPC error for a bad call). */
function callTool(registry: Registry, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const spec = TOOLS.find((tool) => tool.name === name);
  if (spec === undefined) throw new JsonRpcError(-32602, `Unknown tool: ${name}`);
  for (const required of spec.required) {
    const value = args[required];
    if (value === undefined || value === null || value === '') {
      throw new JsonRpcError(-32602, `Missing required argument: ${required}`);
    }
  }
  try {
    switch (name) {
      case 'create_repo': {
        const repoName = requireString(args, 'name');
        const existing = registry.get(repoName);
        const repo =
          existing ??
          registry.create(repoName, {
            description: typeof args.description === 'string' ? args.description : '',
            private: args.private === true,
          });
        if (repo.owner === null) repo.owner = 'forge';
        return toolResult(repoView(repo));
      }
      case 'get_repo': {
        const repo = repoFor(registry, args);
        return toolResult(repoView(repo));
      }
      case 'create_issue': {
        const repo = repoFor(registry, args);
        const labels = Array.isArray(args.labels) ? args.labels.filter((label): label is string => typeof label === 'string') : [];
        const issue = createIssueRecord(repo, {
          title: requireString(args, 'title'),
          body: typeof args.body === 'string' ? args.body : '',
          labels,
        });
        return toolResult({
          id: issue.id,
          number: issue.number,
          title: issue.title,
          body: issue.body,
          state: issue.state,
          labels: issue.labels.map((label) => ({ name: label })),
          node_id: `I_${issue.id}`,
        });
      }
      case 'list_issues': {
        const repo = repoFor(registry, args);
        const data = records.of(repo.name);
        const state = typeof args.state === 'string' && args.state !== '' ? args.state : 'open';
        const list = data.issues
          .filter((issue) => state === 'all' || issue.state === state)
          .sort((a, b) => b.number - a.number)
          .map((issue) => ({
            id: issue.id,
            number: issue.number,
            title: issue.title,
            body: issue.body,
            state: issue.state,
            labels: issue.labels.map((label) => ({ name: label })),
            node_id: `I_${issue.id}`,
          }));
        return toolResult(list);
      }
      case 'create_pull_request': {
        const repo = repoFor(registry, args);
        const store = registry.store(repo.name);
        const pull = createPullRecord(store, repo, {
          title: requireString(args, 'title'),
          body: typeof args.body === 'string' ? args.body : '',
          head: requireString(args, 'head'),
          base: requireString(args, 'base'),
        });
        return toolResult({
          id: pull.id,
          number: pull.number,
          title: pull.title,
          body: pull.body,
          state: pull.state,
          merged: pull.merged,
          head: { ref: pull.head, sha: pull.headSha },
          base: { ref: pull.base, sha: pull.baseSha },
          node_id: `P_${pull.id}`,
        });
      }
      case 'merge_pull_request': {
        const repo = repoFor(registry, args);
        const data = records.of(repo.name);
        const raw = args.pull_number ?? args.number;
        const number = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number.parseInt(raw, 10) : Number.NaN;
        const pull = Number.isFinite(number) ? data.pullByNumber(number) : null;
        if (pull === null) throw new JsonRpcError(-32602, `Pull request ${String(raw)} not found`);
        const merged = mergePullRecord(registry.store(repo.name), repo, pull);
        return toolResult({ sha: merged.sha, merged: merged.merged, message: merged.message, number: pull.number });
      }
      default:
        throw new JsonRpcError(-32602, `Unknown tool: ${name}`);
    }
  } catch (err) {
    if (err instanceof JsonRpcError) throw err;
    if (err instanceof HttpError) return toolFailure(`${err.status}: ${err.message}`);
    return toolFailure(err instanceof Error ? err.message : String(err));
  }
}

/** Answer one JSON-RPC message; null when it is a notification and needs no body. */
function dispatch(registry: Registry, message: Record<string, unknown>): Record<string, unknown> | null {
  const id = message.id;
  const method = typeof message.method === 'string' ? message.method : '';
  const params = typeof message.params === 'object' && message.params !== null ? (message.params as Record<string, unknown>) : {};
  if (method === '') return null;
  if (method === 'server/discover') {
    return {
      jsonrpc: '2.0',
      id: id ?? null,
      result: {
        resultType: 'complete',
        supportedVersions: [MCP_REVISION],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { ...SERVER_INFO },
        instructions: 'A GitHub-compatible forge: repositories over REST, GraphQL and these tools.',
        _meta: { 'io.modelcontextprotocol/serverInfo': { ...SERVER_INFO } },
      },
    };
  }
  if (method === 'initialize') {
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : MCP_REVISION;
    return {
      jsonrpc: '2.0',
      id: id ?? null,
      result: {
        protocolVersion: offered,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { ...SERVER_INFO },
      },
    };
  }
  if (method === 'notifications/initialized' || method.startsWith('notifications/')) return null;
  if (method === 'ping') return { jsonrpc: '2.0', id: id ?? null, result: {} };
  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id: id ?? null, result: { resultType: 'complete', tools: toolsList() } };
  }
  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = typeof params.arguments === 'object' && params.arguments !== null ? (params.arguments as Record<string, unknown>) : {};
    try {
      const result = callTool(registry, name, args);
      return { jsonrpc: '2.0', id: id ?? null, result };
    } catch (err) {
      if (err instanceof JsonRpcError) return { jsonrpc: '2.0', id: id ?? null, error: { code: err.code, message: err.message } };
      return { jsonrpc: '2.0', id: id ?? null, error: { code: -32603, message: err instanceof Error ? err.message : String(err) } };
    }
  }
  if (id === undefined) return null;
  return { jsonrpc: '2.0', id: id ?? null, error: { code: -32601, message: `Method not found: ${method}` } };
}

/** POST /mcp: one JSON-RPC message (or a batch), answered as one application/json body. */
export async function handleMcp(registry: Registry, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readBody(req, 4 * 1024 * 1024);
  const text = raw.toString('utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    rpcError(res, 400, null, -32700, 'Parse error: the request body is not JSON');
    return;
  }
  if (Array.isArray(parsed)) {
    const answers = parsed
      .filter((message): message is Record<string, unknown> => typeof message === 'object' && message !== null && !Array.isArray(message))
      .map((message) => dispatch(registry, message))
      .filter((answer): answer is Record<string, unknown> => answer !== null);
    if (answers.length === 0) {
      res.writeHead(202, { 'x-github-request-id': requestId(), 'content-length': '0' });
      res.end();
      return;
    }
    send(res, 200, answers);
    return;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    rpcError(res, 400, null, -32700, 'Parse error: the request body is not a JSON object');
    return;
  }
  const answer = dispatch(registry, parsed as Record<string, unknown>);
  if (answer === null) {
    res.writeHead(202, { 'x-github-request-id': requestId(), 'content-length': '0' });
    res.end();
    return;
  }
  send(res, 200, answer);
}
