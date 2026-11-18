// GraphQL v4 at /api/graphql: the documents gh and github-mcp-server send, answered from the same
// store as REST. A hand-written document reader covers what they use — operations, variables, aliases,
// inline fragments, connections with cursors — and a resolver per type answers the fields. An unknown
// field is HTTP 200 with an `errors` array, never a 400; an unauthenticated request is a 401 (app.ts).

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Registry, RepoMeta } from './repos.ts';
import type { ObjectStore } from './objects.ts';
import { globalId, parseGlobalId, type IssueRecord, type PullRecord } from './db.ts';
import {
  HttpError,
  createIssueRecord,
  createPullRecord,
  mergePullRecord,
  pullFiles,
  readBody,
  records,
  repoJson,
  requestId,
} from './rest.ts';
import { branchTip } from './trees.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

// ---------------------------------------------------------------------------------------------
// the document reader

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'literal'; value: unknown };

interface FieldNode {
  readonly kind: 'field';
  readonly alias: string | null;
  readonly name: string;
  readonly args: Record<string, ValueNode>;
  readonly selections: SelectionNode[];
}

interface FragmentNode {
  readonly kind: 'fragment';
  readonly onType: string | null;
  readonly selections: SelectionNode[];
}

type SelectionNode = FieldNode | FragmentNode;

class GraphQLError extends Error {}

class Reader {
  private index = 0;
  private readonly text: string;
  constructor(text: string) {
    this.text = text;
  }

  private skip(): void {
    for (;;) {
      const char = this.text[this.index];
      if (char === undefined) return;
      if (char === '#') {
        while (this.index < this.text.length && this.text[this.index] !== '\n') this.index += 1;
        continue;
      }
      if (char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === ',') {
        this.index += 1;
        continue;
      }
      return;
    }
  }

  private peek(): string | undefined {
    this.skip();
    return this.text[this.index];
  }

  private expect(char: string): void {
    this.skip();
    if (this.text[this.index] !== char) throw new GraphQLError(`expected ${char} at ${this.index}`);
    this.index += 1;
  }

  private name(): string {
    this.skip();
    const start = this.index;
    while (/[A-Za-z0-9_]/.test(this.text[this.index] ?? '')) this.index += 1;
    if (this.index === start) throw new GraphQLError(`expected a name at ${this.index}`);
    return this.text.slice(start, this.index);
  }

  private string(): string {
    this.expect('"');
    let out = '';
    while (this.index < this.text.length) {
      const char = this.text[this.index];
      this.index += 1;
      if (char === '"') return out;
      if (char === '\\') {
        const next = this.text[this.index];
        this.index += 1;
        out += next === 'n' ? '\n' : next === 't' ? '\t' : (next ?? '');
        continue;
      }
      out += char;
    }
    throw new GraphQLError('unterminated string');
  }

  /** Parse a whole document: operation type, name, variable definitions, then its selection set. */
  document(): SelectionNode[] {
    const first = this.peek();
    if (first === '{') return this.selectionSet();
    const keyword = this.name();
    if (keyword !== 'query' && keyword !== 'mutation' && keyword !== 'subscription') {
      throw new GraphQLError(`unsupported operation ${keyword}`);
    }
    this.skip();
    if (/[A-Za-z_]/.test(this.text[this.index] ?? '')) this.name();
    this.skip();
    if (this.text[this.index] === '(') this.skipBalanced('(', ')');
    return this.selectionSet();
  }

  private skipBalanced(open: string, close: string): void {
    this.expect(open);
    let depth = 1;
    while (this.index < this.text.length && depth > 0) {
      const char = this.text[this.index];
      this.index += 1;
      if (char === '"') {
        this.index -= 1;
        this.string();
        continue;
      }
      if (char === open) depth += 1;
      else if (char === close) depth -= 1;
    }
  }

  selectionSet(): SelectionNode[] {
    this.expect('{');
    const out: SelectionNode[] = [];
    for (;;) {
      const char = this.peek();
      if (char === undefined) throw new GraphQLError('unterminated selection set');
      if (char === '}') {
        this.index += 1;
        return out;
      }
      if (this.text.startsWith('...', this.index)) {
        this.index += 3;
        this.skip();
        const onType = this.text.startsWith('on', this.index) && /[\s{]/.test(this.text[this.index + 2] ?? '') ? (this.index += 2, this.name()) : null;
        out.push({ kind: 'fragment', onType, selections: this.selectionSet() });
        continue;
      }
      const name = this.name();
      let alias: string | null = null;
      let fieldName = name;
      this.skip();
      if (this.text[this.index] === ':') {
        this.index += 1;
        alias = name;
        fieldName = this.name();
      }
      const args: Record<string, ValueNode> = {};
      this.skip();
      if (this.text[this.index] === '(') {
        this.index += 1;
        for (;;) {
          this.skip();
          if (this.text[this.index] === ')') {
            this.index += 1;
            break;
          }
          const argName = this.name();
          this.expect(':');
          args[argName] = this.value();
        }
      }
      this.skip();
      const selections = this.text[this.index] === '{' ? this.selectionSet() : [];
      // Directives (@include etc.) are skipped with their arguments.
      this.skip();
      while (this.text[this.index] === '@') {
        this.index += 1;
        this.name();
        this.skip();
        if (this.text[this.index] === '(') this.skipBalanced('(', ')');
        this.skip();
      }
      out.push({ kind: 'field', alias, name: fieldName, args, selections });
    }
  }

  private value(): ValueNode {
    this.skip();
    const char = this.text[this.index];
    if (char === '$') {
      this.index += 1;
      return { kind: 'variable', name: this.name() };
    }
    if (char === '"') return { kind: 'literal', value: this.string() };
    if (char === '[') {
      this.index += 1;
      const list: unknown[] = [];
      for (;;) {
        this.skip();
        if (this.text[this.index] === ']') {
          this.index += 1;
          break;
        }
        const item = this.value();
        list.push(item.kind === 'literal' ? item.value : null);
      }
      return { kind: 'literal', value: list };
    }
    if (char === '{') {
      this.index += 1;
      const object: Record<string, unknown> = {};
      for (;;) {
        this.skip();
        if (this.text[this.index] === '}') {
          this.index += 1;
          break;
        }
        const key = this.name();
        this.expect(':');
        const item = this.value();
        object[key] = item.kind === 'literal' ? item.value : null;
      }
      return { kind: 'literal', value: object };
    }
    const start = this.index;
    while (/[-0-9A-Za-z_.]/.test(this.text[this.index] ?? '')) this.index += 1;
    const text = this.text.slice(start, this.index);
    if (text === 'true') return { kind: 'literal', value: true };
    if (text === 'false') return { kind: 'literal', value: false };
    if (text === 'null') return { kind: 'literal', value: null };
    if (/^-?\d+(\.\d+)?$/.test(text)) return { kind: 'literal', value: Number(text) };
    return { kind: 'literal', value: text };
  }
}

// ---------------------------------------------------------------------------------------------
// the executor

interface ExecContext {
  readonly registry: Registry;
  readonly vars: Record<string, unknown>;
  readonly errors: Array<{ message: string; path?: Array<string | number> }>;
}

interface Resolved {
  readonly value: unknown;
  readonly type: string;
}

function argValue(node: ValueNode | undefined, ctx: ExecContext): unknown {
  if (node === undefined) return undefined;
  if (node.kind === 'variable') return ctx.vars[node.name];
  return node.value;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function repoStrings(repo: RepoMeta): Record<string, unknown> {
  return {
    __typename: 'Repository',
    id: globalId('Repository', repo.id),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner ?? 'forge'}/${repo.name}`,
    owner: { __typename: 'User', login: repo.owner ?? 'forge', id: globalId('User', 1) },
    defaultBranchRef: { __typename: 'Ref', name: repo.defaultBranch },
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    isPrivate: repo.private,
    description: repo.description,
    isEmpty: false,
    createdAt: repo.createdAt,
    url: null,
    repo,
  };
}

function issueType(issue: IssueRecord): Record<string, unknown> {
  return {
    __typename: 'Issue',
    id: globalId('Issue', issue.id),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    closedAt: issue.closedAt,
    issue,
  };
}

function pullType(pull: PullRecord, repoName = ''): Record<string, unknown> {
  return {
    __repoName: repoName,
    __typename: 'PullRequest',
    id: globalId('PullRequest', pull.id),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED',
    merged: pull.merged,
    headRefName: pull.head,
    baseRefName: pull.base,
    mergeable: 'MERGEABLE',
    mergedAt: pull.mergedAt,
    pull,
  };
}

function repoByName(registry: Registry, owner: string, name: string): RepoMeta | null {
  return registry.resolve(name, owner === '' ? registry.viewer() : owner);
}

function storeFor(registry: Registry, repo: RepoMeta): ObjectStore {
  return registry.store(repo.name);
}

/** Resolve one field on one object; unknown fields push an error naming the field and the type. */
function resolveField(target: Record<string, unknown>, name: string, args: Record<string, unknown>, ctx: ExecContext): Resolved | null {
  const type = String(target.__typename ?? 'Unknown');
  const known = (value: unknown, typeName: string): Resolved => ({ value, type: typeName });
  const registry = ctx.registry;

  if (type === 'Repository') {
    const repo = target.repo as RepoMeta;
    switch (name) {
      case 'id':
      case 'databaseId':
      case 'name':
      case 'nameWithOwner':
      case 'owner':
      case 'defaultBranchRef':
      case 'viewerPermission':
      case 'hasIssuesEnabled':
      case 'isPrivate':
      case 'description':
      case 'createdAt':
      case 'url':
      case 'isEmpty':
        return null; // served straight off the object by the projection
      case 'issue': {
        const data = records.of(repo.name);
        const number = Number(args.number);
        const issue = Number.isFinite(number) ? data.issueByNumber(number) : null;
        return known(issue === null ? null : issueType(issue), 'Issue');
      }
      case 'issues':
        return known(issueConnection(repo, args, ctx), 'IssueConnection');
      case 'pullRequest': {
        const data = records.of(repo.name);
        const number = Number(args.number);
        const pull = Number.isFinite(number) ? data.pullByNumber(number) : null;
        return known(pull === null ? null : pullType(pull, repo.name), 'PullRequest');
      }
      case 'pullRequests':
        return known(pullConnection(repo, args), 'PullRequestConnection');
      default:
        ctx.errors.push({ message: `Cannot query field "${name}" on type "Repository".` });
        return null;
    }
  }

  if (type.endsWith('Connection')) {
    switch (name) {
      case 'nodes':
      case 'pageInfo':
      case 'totalCount':
        return null;
      default:
        ctx.errors.push({ message: `Cannot query field "${name}" on type "${type}".` });
        return null;
    }
  }

  if (type === 'PullRequest' && name === 'files') {
    const pull = target.pull as PullRecord;
    const store = registry.store(String(target.__repoName ?? '') );
    const files = pullFiles(store, pull).map((file) => ({
      __typename: 'PullRequestChangedFile',
      path: str(file.filename),
      additions: Number(file.additions ?? 0),
      deletions: Number(file.deletions ?? 0),
      changeType: 'MODIFIED',
    }));
    return known(wrapConnection(files, Number(args.first ?? files.length), null, 'PullRequestChangedFileConnection'), 'PullRequestChangedFileConnection');
  }

  if (type === 'User') {
    if (name === 'login' || name === 'id') return null;
    ctx.errors.push({ message: `Cannot query field "${name}" on type "User".` });
    return null;
  }

  if (type === '__Type') {
    if (name === 'fields' || name === 'enumValues' || name === 'name' || name === 'kind') return null;
    ctx.errors.push({ message: `Cannot query field "${name}" on type "__Type".` });
    return null;
  }

  if (type === '__Field' || type === '__EnumValue') {
    if (name === 'name') return null;
    ctx.errors.push({ message: `Cannot query field "${name}" on type "${type}".` });
    return null;
  }

  if (type === 'PageInfo') {
    if (name === 'hasNextPage' || name === 'endCursor' || name === 'hasPreviousPage' || name === 'startCursor') return null;
    ctx.errors.push({ message: `Cannot query field "${name}" on type "PageInfo".` });
    return null;
  }

  // A field the type does not hold at all (an Issue's scalar fields are always known).
  if (name in target) return known(target[name], scalarTypeOf(name));
  ctx.errors.push({ message: `Cannot query field "${name}" on type "${type}".` });
  return null;
}

function scalarTypeOf(name: string): string {
  if (name === 'labels') return 'Label';
  return 'String';
}

function wrapConnection(nodes: unknown[], first: number, after: string | null, typeName = 'Connection'): Record<string, unknown> {
  const start = after === null ? 0 : nodes.findIndex((node) => `cursor:${String((node as { number?: number }).number)}` === after) + 1;
  const from = start < 0 ? 0 : start;
  const limit = Number.isFinite(first) && first > 0 ? Math.min(first, nodes.length) : nodes.length;
  const page = from === 0 && !Number.isFinite(first) ? nodes : nodes.slice(from, from + limit);
  const hasNextPage = from + page.length < nodes.length;
  const last = page[page.length - 1] as { number?: number } | undefined;
  const endCursor = last === undefined ? null : Buffer.from(`cursor:${String(last.number)}`).toString('base64');
  return {
    __typename: typeName,
    nodes: page,
    totalCount: nodes.length,
    pageInfo: { __typename: 'PageInfo', hasNextPage, endCursor, hasPreviousPage: from > 0, startCursor: null },
  };
}

function issueConnection(repo: RepoMeta, args: Record<string, unknown>, ctx: ExecContext): Record<string, unknown> {
  const data = records.of(repo.name);
  const states = Array.isArray(args.states) ? args.states.map((state) => String(state).toUpperCase()) : ['OPEN'];
  const orderBy = typeof args.orderBy === 'object' && args.orderBy !== null ? (args.orderBy as Record<string, unknown>) : {};
  const direction = String(orderBy.direction ?? 'DESC').toUpperCase();
  const filtered = data.issues.filter((issue) => states.includes(issue.state === 'open' ? 'OPEN' : 'CLOSED'));
  const sorted = [...filtered].sort((a, b) => (direction === 'ASC' ? a.number - b.number : b.number - a.number));
  return wrapConnection(sorted.map(issueType), Number(args.first ?? sorted.length), afterCursor(args, ctx), 'IssueConnection');
}

function pullConnection(repo: RepoMeta, args: Record<string, unknown>): Record<string, unknown> {
  const data = records.of(repo.name);
  const states = Array.isArray(args.states) ? args.states.map((state) => String(state).toUpperCase()) : ['OPEN'];
  const filtered = data.pulls.filter((pull) => (states.includes('OPEN') && pull.state === 'open') || (states.includes('CLOSED') && pull.state === 'closed') || (states.includes('MERGED') && pull.merged));
  const sorted = [...filtered].sort((a, b) => b.number - a.number);
  return wrapConnection(sorted.map((pull) => pullType(pull, repo.name)), Number(args.first ?? sorted.length), null, 'PullRequestConnection');
}

function afterCursor(args: Record<string, unknown>, ctx: ExecContext): string | null {
  const raw = args.after;
  void ctx;
  if (typeof raw !== 'string' || raw === '') return null;
  try {
    return Buffer.from(raw, 'base64').toString('utf8');
  } catch {
    return null;
  }
}

const INTROSPECTION: Record<string, { fields: string[]; enumValues?: string[]; kind: string }> = {
  Issue: {
    kind: 'OBJECT',
    fields: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'closedAt', 'labels', 'comments', 'author', 'repository'],
  },
  PullRequest: {
    kind: 'OBJECT',
    fields: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergedAt', 'mergeable', 'headRefName', 'baseRefName', 'files', 'headRefOid', 'baseRefOid', 'commits', 'comments', 'createdAt', 'updatedAt'],
  },
  Repository: {
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'isPrivate', 'description', 'createdAt', 'url'],
  },
  SearchType: { kind: 'ENUM', fields: [], enumValues: ['ISSUE', 'REPOSITORY', 'USER'] },
};

/** Resolve a root field of an operation. */
function rootField(node: FieldNode, ctx: ExecContext): Resolved | null {
  const args: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node.args)) args[key] = argValue(value, ctx);
  const registry = ctx.registry;

  if (node.name === '__type') {
    const wanted = str(args.name);
    const described = INTROSPECTION[wanted];
    if (described === undefined) return { value: null, type: '__Type' };
    return {
      value: {
        __typename: '__Type',
        name: wanted,
        kind: described.kind,
        fields: described.fields.map((fieldName) => ({ __typename: '__Field', name: fieldName })),
        enumValues: (described.enumValues ?? []).map((value) => ({ __typename: '__EnumValue', name: value })),
      },
      type: '__Type',
    };
  }

  if (node.name === 'viewer') {
    const login = registry.viewer();
    return { value: { __typename: 'User', login, id: globalId('User', 1), name: login }, type: 'User' };
  }

  if (node.name === 'repository') {
    const repo = repoByName(registry, str(args.owner), str(args.name));
    return { value: repo === null ? null : repoStrings(repo), type: 'Repository' };
  }

  if (node.name === 'node') {
    const parsed = parseGlobalId(str(args.id));
    if (parsed === null) return { value: null, type: 'Node' };
    if (parsed.kind === 'Repository') {
      const repo = registry.list().find((candidate) => candidate.id === parsed.id) ?? null;
      return { value: repo === null ? null : repoStrings(repo), type: 'Repository' };
    }
    if (parsed.kind === 'Issue') {
      for (const repo of registry.list()) {
        const issue = records.of(repo.name).issues.find((candidate) => candidate.id === parsed.id);
        if (issue !== undefined) return { value: issueType(issue), type: 'Issue' };
      }
    }
    return { value: null, type: 'Node' };
  }

  if (node.name === 'createIssue') {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const parsed = parseGlobalId(str(input.repositoryId));
    const repo = parsed === null ? null : registry.list().find((candidate) => candidate.id === parsed.id) ?? null;
    if (repo === null) throw new HttpError(200, 'Could not resolve to a Repository with that id');
    const issue = createIssueRecord(repo, { title: str(input.title), body: str(input.body), labels: [] });
    return { value: { __typename: 'CreateIssuePayload', issue: issueType(issue) }, type: 'CreateIssuePayload' };
  }

  if (node.name === 'closeIssue' || node.name === 'reopenIssue') {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const parsed = parseGlobalId(str(input.issueId));
    let found: IssueRecord | null = null;
    for (const repo of registry.list()) {
      const issue = records.of(repo.name).issues.find((candidate) => candidate.id === parsed?.id);
      if (issue !== undefined) found = issue;
    }
    if (found === null) throw new HttpError(200, 'Could not resolve to an Issue with that id');
    found.state = node.name === 'closeIssue' ? 'closed' : 'open';
    return { value: { __typename: 'IssuePayload', issue: issueType(found) }, type: 'IssuePayload' };
  }

  if (node.name === 'createPullRequest') {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const parsed = parseGlobalId(str(input.repositoryId));
    const repo = parsed === null ? null : registry.list().find((candidate) => candidate.id === parsed.id) ?? null;
    if (repo === null) throw new HttpError(200, 'Could not resolve to a Repository with that id');
    const pull = createPullRecord(storeFor(registry, repo), repo, {
      title: str(input.title),
      body: str(input.body),
      head: str(input.headRefName),
      base: str(input.baseRefName),
    });
    return { value: { __typename: 'CreatePullRequestPayload', pullRequest: pullType(pull) }, type: 'CreatePullRequestPayload' };
  }

  if (node.name === 'mergePullRequest') {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const parsed = parseGlobalId(str(input.pullRequestId));
    let found: { pull: PullRecord; repo: RepoMeta } | null = null;
    for (const repo of registry.list()) {
      const pull = records.of(repo.name).pulls.find((candidate) => candidate.id === parsed?.id);
      if (pull !== undefined) found = { pull, repo };
    }
    if (found === null) throw new HttpError(200, 'Could not resolve to a PullRequest with that id');
    mergePullRecord(storeFor(registry, found.repo), found.repo, found.pull);
    return { value: { __typename: 'MergePullRequestPayload', pullRequest: pullType(found.pull) }, type: 'MergePullRequestPayload' };
  }

  if (node.name === 'addComment') {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const parsed = parseGlobalId(str(input.subjectId));
    let found: { issue: IssueRecord; repo: RepoMeta } | null = null;
    for (const repo of registry.list()) {
      const issue = records.of(repo.name).issues.find((candidate) => candidate.id === parsed?.id);
      if (issue !== undefined) found = { issue, repo };
    }
    if (found === null) throw new HttpError(200, 'Could not resolve to an Issue with that id');
    const comment = records.of(found.repo.name).addComment(found.issue, str(input.body), found.repo.owner ?? registry.viewer());
    return {
      value: {
        __typename: 'AddCommentPayload',
        commentEdge: { __typename: 'IssueCommentEdge', node: { __typename: 'IssueComment', id: globalId('IssueComment', comment.id), body: comment.body } },
      },
      type: 'AddCommentPayload',
    };
  }

  ctx.errors.push({ message: `Cannot query field "${node.name}" on type "Query".` });
  return null;
}

/** Project one selection set onto one resolved value. */
function project(resolved: Resolved, selections: SelectionNode[], ctx: ExecContext): unknown {
  const value = resolved.value;
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((item) => project({ value: item, type: resolved.type }, selections, ctx));
  if (typeof value !== 'object') return value;
  const target = value as Record<string, unknown>;
  const typeName = String(target.__typename ?? resolved.type);
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      if (selection.onType !== null && selection.onType !== typeName) continue;
      const inner = project({ value: target, type: typeName }, selection.selections, ctx);
      if (inner !== null && typeof inner === 'object') Object.assign(out, inner as Record<string, unknown>);
      continue;
    }
    const key = selection.alias ?? selection.name;
    const args: Record<string, unknown> = {};
    for (const [argName, node] of Object.entries(selection.args)) args[argName] = argValue(node, ctx);
    const child = resolveField(target, selection.name, args, ctx);
    const raw = child === null ? (selection.name in target ? { value: target[selection.name], type: scalarTypeOf(selection.name) } : null) : child;
    if (raw === null) {
      if (!(selection.name in target)) continue;
      out[key] = null;
      continue;
    }
    if (selection.selections.length === 0) out[key] = raw.value;
    else out[key] = project(raw, selection.selections, ctx);
  }
  return out;
}

/** Execute one operation document. */
function execute(registry: Registry, document: string, variables: Record<string, unknown>): Record<string, unknown> {
  const ctx: ExecContext = { registry, vars: variables, errors: [] };
  let selections: SelectionNode[];
  try {
    selections = new Reader(document).document();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  const data: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') continue;
    const key = selection.alias ?? selection.name;
    const resolved = rootField(selection, ctx);
    if (resolved === null) {
      data[key] = null;
      continue;
    }
    data[key] = selection.selections.length === 0 ? resolved.value : project(resolved, selection.selections, ctx);
  }
  const answer: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) answer.errors = ctx.errors;
  return answer;
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

/** POST /api/graphql: one document, or an array of them (GitHub's operation batching). */
export async function handleGraphQL(registry: Registry, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readBody(req, 8 * 1024 * 1024);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8') || '{}');
  } catch {
    send(res, 400, { message: 'Problems parsing JSON' });
    return;
  }
  if (Array.isArray(parsed)) {
    const answers = parsed.map((entry) => {
      const body = typeof entry === 'object' && entry !== null ? (entry as Record<string, unknown>) : {};
      return execute(registry, str(body.query), (body.variables ?? {}) as Record<string, unknown>);
    });
    send(res, 200, answers);
    return;
  }
  const body = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  const query = str(body.query);
  if (query === '') {
    send(res, 200, { data: null, errors: [{ message: 'A query document is required' }] });
    return;
  }
  send(res, 200, execute(registry, query, (body.variables ?? {}) as Record<string, unknown>));
}

/** The global id form the REST repository view shares with this surface. */
export function repoGlobalId(repo: RepoMeta): string {
  return globalId('Repository', repo.id);
}
