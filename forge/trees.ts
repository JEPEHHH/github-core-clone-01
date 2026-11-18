// Git object writing for the REST surface: trees from a flat path map, commits, ref resolution and
// the diffs the pull-request API needs. Everything is derived from the trial's own clock and the
// store's own bytes, so two runs on one seed write byte-identical commits.

import { parseCommit, parseTree, hashObject } from './objects.ts';
import type { ObjectStore } from './objects.ts';

export interface FlatEntry {
  readonly mode: string;
  readonly oid: string;
}

/** The trial's fixed author identity: no clock, no host name, no user input. */
export const AUTHOR = { name: 'forge', email: 'forge@example.invalid' } as const;

/** The trial's clock in git's "<sec> +0000" form; the instance's opening time, never the host's. */
export function trialStamp(): string {
  const raw = process.env.MAKEFUN_TRIAL_NOW ?? '';
  const parsed = raw === '' ? Number.NaN : Date.parse(raw);
  const seconds = Number.isNaN(parsed) ? 1_735_689_600 : Math.floor(parsed / 1000);
  return `${seconds} +0000`;
}

/** ISO-8601 for the REST replies, from the same fixed clock. */
export function trialIso(): string {
  const raw = process.env.MAKEFUN_TRIAL_NOW ?? '';
  const parsed = raw === '' ? Number.NaN : Date.parse(raw);
  const ms = Number.isNaN(parsed) ? 1_735_689_600_000 : parsed;
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** git's tree ordering: a directory sorts as though its name ended in '/'. */
function treeSortKey(name: string, mode: string): string {
  return mode === '40000' ? `${name}/` : name;
}

/** A tree object's bytes from entries already keyed by name. */
export function treeBytes(entries: ReadonlyArray<{ mode: string; name: string; oid: string }>): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeSortKey(a.name, a.mode);
    const kb = treeSortKey(b.name, b.mode);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Every path under `treeOid` as path -> {mode, oid}, blobs and submodule leaves only. */
export function flattenTree(store: ObjectStore, treeOid: string, prefix = ''): Map<string, FlatEntry> {
  const out = new Map<string, FlatEntry>();
  const object = store.read(treeOid);
  if (object === null || object.type !== 'tree') return out;
  for (const entry of parseTree(object.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') {
      for (const [childPath, child] of flattenTree(store, entry.oid, path)) out.set(childPath, child);
    } else {
      out.set(path, { mode: entry.mode, oid: entry.oid });
    }
  }
  return out;
}

/** Write the trees for a flat path map, bottom up; an empty map writes the empty tree. */
export function buildTree(store: ObjectStore, entries: ReadonlyMap<string, FlatEntry>): string {
  interface Node {
    readonly files: Array<{ name: string; mode: string; oid: string }>;
    readonly dirs: Map<string, Node>;
  }
  const root: Node = { files: [], dirs: new Map() };
  for (const [path, entry] of entries) {
    const parts = path.split('/').filter((part) => part !== '');
    if (parts.length === 0) continue;
    let node = root;
    for (let index = 0; index < parts.length - 1; index += 1) {
      const name = parts[index] as string;
      let child = node.dirs.get(name);
      if (child === undefined) {
        child = { files: [], dirs: new Map() };
        node.dirs.set(name, child);
      }
      node = child;
    }
    node.files.push({ name: parts[parts.length - 1] as string, mode: entry.mode, oid: entry.oid });
  }
  const write = (node: Node): string => {
    const items: Array<{ mode: string; name: string; oid: string }> = [...node.files];
    for (const [name, child] of node.dirs) items.push({ mode: '40000', name, oid: write(child) });
    return store.write('tree', treeBytes(items));
  };
  return write(root);
}

export interface CommitInput {
  readonly tree: string;
  readonly parents: readonly string[];
  readonly message: string;
}

/** A commit object's bytes, in git's own header order. */
export function commitBytes(input: CommitInput): Buffer {
  const stamp = trialStamp();
  const lines = [`tree ${input.tree}`];
  for (const parent of input.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${AUTHOR.name} <${AUTHOR.email}> ${stamp}`);
  lines.push(`committer ${AUTHOR.name} <${AUTHOR.email}> ${stamp}`);
  lines.push('', input.message.endsWith('\n') ? input.message : `${input.message}\n`);
  return Buffer.from(lines.join('\n'), 'utf8');
}

/** Write a commit and return its id. */
export function createCommit(store: ObjectStore, input: CommitInput): string {
  return store.write('commit', commitBytes(input));
}

/** Resolve a ref name, branch name, tag or object id to an object id; null when it does not resolve. */
export function resolveRef(store: ObjectStore, ref: string, defaultBranch: string): string | null {
  if (ref === '') ref = defaultBranch;
  if (/^[0-9a-f]{40}$/.test(ref) && store.has(ref)) return ref;
  const candidates = [
    ref,
    `refs/heads/${ref}`,
    `refs/tags/${ref}`,
    `refs/remotes/${ref}`,
    ref === 'HEAD' ? `refs/heads/${defaultBranch}` : '',
  ];
  for (const candidate of candidates) {
    if (candidate === '') continue;
    const oid = store.refs.get(candidate);
    if (oid !== undefined) return store.peel(oid);
  }
  return null;
}

/** The commit a branch points at, or null when the branch has no commit yet. */
export function branchTip(store: ObjectStore, branch: string): string | null {
  const oid = store.refs.get(`refs/heads/${branch}`);
  return oid === undefined ? null : store.peel(oid);
}

/** A commit's message body (what GitHub reports as commit.message). */
export function commitMessage(store: ObjectStore, oid: string): string {
  const object = store.read(oid);
  if (object === null || object.type !== 'commit') return '';
  const text = object.data.toString('utf8');
  const end = text.indexOf('\n\n');
  return end < 0 ? '' : text.slice(end + 2).replace(/\n$/, '');
}

/** A commit's fields for the REST shape: tree, parents, author, committer, message. */
export interface CommitInfo {
  readonly sha: string;
  readonly tree: string;
  readonly parents: string[];
  readonly authorLine: string;
  readonly message: string;
}

export function commitInfo(store: ObjectStore, oid: string): CommitInfo | null {
  const object = store.read(oid);
  if (object === null || object.type !== 'commit') return null;
  const parsed = parseCommit(object.data);
  const text = object.data.toString('utf8');
  const author = /^author (.+)$/m.exec(text)?.[1] ?? '';
  return { sha: oid, tree: parsed.tree, parents: parsed.parents, authorLine: author, message: commitMessage(store, oid) };
}

/** The commits reachable from `from` that `stop` does not reach, newest first, bounded by `limit`. */
export function commitsSince(store: ObjectStore, from: string | null, stop: readonly string[], limit = 100): string[] {
  if (from === null) return [];
  const held = new Set<string>();
  const stack = [...stop];
  while (stack.length) {
    const oid = stack.pop() as string;
    if (held.has(oid)) continue;
    held.add(oid);
    const info = commitInfo(store, oid);
    if (info === null) continue;
    for (const parent of info.parents) stack.push(parent);
  }
  const out: string[] = [];
  const seen = new Set<string>();
  const queue: string[] = [from];
  while (queue.length && out.length < limit) {
    const oid = queue.shift() as string;
    if (seen.has(oid) || held.has(oid)) continue;
    seen.add(oid);
    const info = commitInfo(store, oid);
    if (info === null) continue;
    out.push(oid);
    for (const parent of info.parents) queue.push(parent);
  }
  return out;
}

/** Everything reachable from one commit, for ancestry tests. */
function reachable(store: ObjectStore, oid: string): Set<string> {
  const seen = new Set<string>();
  const stack = [oid];
  while (stack.length) {
    const current = stack.pop() as string;
    if (seen.has(current)) continue;
    seen.add(current);
    const info = commitInfo(store, current);
    if (info === null) continue;
    for (const parent of info.parents) stack.push(parent);
  }
  return seen;
}

/** True when `ancestor` is reachable from `descendant` (or they are the same commit). */
export function isAncestor(store: ObjectStore, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  return reachable(store, descendant).has(ancestor);
}

/** A path-by-path diff of two trees: path -> {mode, oid} on each side that differ. */
export interface TreeDiffEntry {
  readonly path: string;
  readonly before: FlatEntry | null;
  readonly after: FlatEntry | null;
}

export function diffTrees(store: ObjectStore, beforeTree: string | null, afterTree: string | null): TreeDiffEntry[] {
  const before = beforeTree === null ? new Map<string, FlatEntry>() : flattenTree(store, beforeTree);
  const after = afterTree === null ? new Map<string, FlatEntry>() : flattenTree(store, afterTree);
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
  const out: TreeDiffEntry[] = [];
  for (const path of paths) {
    const a = before.get(path) ?? null;
    const b = after.get(path) ?? null;
    if (a !== null && b !== null && a.oid === b.oid && a.mode === b.mode) continue;
    out.push({ path, before: a, after: b });
  }
  return out;
}

/** A blob's bytes as UTF-8 text (an empty string when it is not a blob). */
export function blobText(store: ObjectStore, oid: string): string {
  const object = store.read(oid);
  return object === null || object.type !== 'blob' ? '' : object.data.toString('utf8');
}

/** Line counts for a pull request's file entry: additions and deletions of the blob pair. */
export function changeCounts(store: ObjectStore, before: FlatEntry | null, after: FlatEntry | null): { additions: number; deletions: number } {
  const beforeText = before === null ? '' : blobText(store, before.oid);
  const afterText = after === null ? '' : blobText(store, after.oid);
  const beforeLines = beforeText === '' ? [] : beforeText.split('\n');
  const afterLines = afterText === '' ? [] : afterText.split('\n');
  const counts = new Map<string, number>();
  for (const line of beforeLines) counts.set(line, (counts.get(line) ?? 0) - 1);
  for (const line of afterLines) counts.set(line, (counts.get(line) ?? 0) + 1);
  let additions = 0;
  let deletions = 0;
  for (const value of counts.values()) {
    if (value > 0) additions += value;
    else deletions += -value;
  }
  return { additions, deletions };
}

/** The blob id of a path in a tree, or null. */
export function blobAt(store: ObjectStore, treeOid: string | null, path: string): FlatEntry | null {
  if (treeOid === null) return null;
  return flattenTree(store, treeOid).get(path) ?? null;
}

/** An object id for a blob's bytes, written into the store. */
export function writeBlob(store: ObjectStore, bytes: Buffer): string {
  return store.write('blob', bytes);
}

/** Recompute an object's id from its bytes: the checks' own test that what we report is real. */
export function oidOfBytes(type: 'blob' | 'tree' | 'commit', bytes: Buffer): string {
  return hashObject(type, bytes);
}
