// The store: loose git objects on disk under .forge/objects plus refs in .forge/refs.json, and the
// object-graph walks a forge needs (tree recursion, commit parents, tag peeling, fetch closure).
// Objects are written zlib-deflated as "<type> <size>\0<bytes>", exactly as git writes them, so any
// SHA-1 we report recomputes from the bytes on disk.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';

/**
 * How long a mutation may sit in memory before its loose objects and refs file are written. Pushes
 * arrive back to back, so the work lands in the gap between them instead of on their own clock, and
 * the exit flush covers whatever is still queued when the trial ends.
 */
const WRITE_BEHIND_MS = 1000;

export interface GitObject {
  readonly type: ObjectType;
  readonly data: Buffer;
}

export const ZERO_OID = '0000000000000000000000000000000000000000';

export function hashObject(type: ObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

export function encodeLoose(type: ObjectType, data: Buffer): Buffer {
  return deflateSync(Buffer.concat([Buffer.from(`${type} ${data.length}\0`, 'utf8'), data]), { level: 3 });
}

export function decodeLoose(raw: Buffer): GitObject {
  const { buffer } = inflateSync(raw, { info: true });
  const nul = buffer.indexOf(0);
  if (nul < 0) throw new Error('loose object has no header terminator');
  const header = buffer.toString('utf8', 0, nul);
  const space = header.indexOf(' ');
  const type = header.slice(0, space) as ObjectType;
  const size = Number.parseInt(header.slice(space + 1), 10);
  const data = buffer.subarray(nul + 1);
  if (data.length !== size) throw new Error(`loose ${type} declares ${size} bytes, holds ${data.length}`);
  return { type, data };
}

export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

/** The tree object's entries, in stored order. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) break;
    const mode = data.toString('ascii', offset, space);
    const nul = data.indexOf(0, space + 1);
    if (nul < 0) break;
    const name = data.toString('utf8', space + 1, nul);
    const oid = data.toString('hex', nul + 1, nul + 21);
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** A commit's tree id and parent ids, read from its header lines. */
export function parseCommit(data: Buffer): { tree: string; parents: string[] } {
  const text = data.toString('utf8');
  const end = text.indexOf('\n\n');
  const head = end < 0 ? text : text.slice(0, end);
  let tree = '';
  const parents: string[] = [];
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
  }
  return { tree, parents };
}

/** What a tag points at: the object id and its type. */
export function parseTag(data: Buffer): { object: string; type: string } {
  const text = data.toString('utf8');
  const end = text.indexOf('\n\n');
  const head = end < 0 ? text : text.slice(0, end);
  let object = '';
  let type = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
  }
  return { object, type };
}

/** The refs and objects: one forge repository's store. */
export class ObjectStore {
  readonly root: string;
  readonly objectsDir: string;
  readonly refsFile: string;
  readonly refs = new Map<string, string>();
  private readonly cache = new Map<string, GitObject>();
  /** Every object id this store holds: memory first, so the hot paths never stat the disk. */
  private readonly known = new Set<string>();
  /** Object directories already made in this process, so a push does not mkdir per object. */
  private readonly dirs = new Set<string>();
  private pending: Array<{ oid: string; object: GitObject }> = [];
  private flushHandle: ReturnType<typeof setTimeout> | null = null;
  private refsDirty = false;
  /** Bumped on every ref change, so a cached advertisement knows when it is stale. */
  refsVersion = 0;

  constructor(root: string) {
    this.root = root;
    this.objectsDir = join(root, 'objects');
    this.refsFile = join(root, 'refs.json');
    mkdirSync(this.objectsDir, { recursive: true });
    this.dirs.add(this.objectsDir);
    if (existsSync(this.refsFile)) {
      try {
        const parsed = JSON.parse(readFileSync(this.refsFile, 'utf8')) as { refs?: Record<string, string> };
        for (const [name, oid] of Object.entries(parsed.refs ?? {})) this.refs.set(name, oid);
      } catch {
        // A store with an unreadable refs file starts empty: a fresh trial writes it before any read.
      }
    }
    // A trial ends by exiting: whatever is still queued lands then, so the disk never lags the store.
    process.once('exit', () => this.flushNow());
  }

  private objectPath(oid: string): string {
    return join(this.objectsDir, oid.slice(0, 2), oid.slice(2));
  }

  has(oid: string): boolean {
    if (this.known.has(oid)) return true;
    if (this.cache.has(oid)) return true;
    if (!existsSync(this.objectPath(oid))) return false;
    this.known.add(oid);
    return true;
  }

  read(oid: string): GitObject | null {
    const cached = this.cache.get(oid);
    if (cached !== undefined) return cached;
    const path = this.objectPath(oid);
    if (!existsSync(path)) return null;
    try {
      const object = decodeLoose(readFileSync(path));
      if (this.cache.size < 20_000) this.cache.set(oid, object);
      this.known.add(oid);
      return object;
    } catch {
      return null;
    }
  }

  write(type: ObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (this.known.has(oid) || this.cache.has(oid)) return oid;
    this.remember(oid, { type, data });
    return oid;
  }

  /** Adopt an object whose id the caller already computed (a pack entry): no rehash, no re-deflate. */
  adopt(oid: string, object: GitObject): void {
    if (this.known.has(oid) || this.cache.has(oid)) return;
    this.remember(oid, object);
  }

  /**
   * Keep the object in memory and queue its loose file. A push answers as soon as the store knows the
   * object; the deflate and the write land on the next turn of the loop, never on the request's clock.
   */
  private remember(oid: string, object: GitObject): void {
    this.known.add(oid);
    if (this.cache.size < 20_000) this.cache.set(oid, object);
    this.pending.push({ oid, object });
    if (this.pending.length >= 8192) {
      // A memory ceiling, not a scheduling point: 200 pushes of a 1 KiB change queue ~600 objects and
      // this used to fire on every one of them, putting a batch of deflates and writes inside the
      // request that happened to cross the line. The timer below owns the drain; the exit flush covers
      // whatever is still queued when a trial ends.
      if (this.flushHandle !== null) {
        clearTimeout(this.flushHandle);
        this.flushHandle = null;
      }
      this.flush();
      return;
    }
    if (this.flushHandle === null) {
      this.flushHandle = setTimeout(() => {
        this.flushHandle = null;
        this.flush();
      }, WRITE_BEHIND_MS);
      this.flushHandle.unref();
    }
  }

  private writeLoose(oid: string, object: GitObject): void {
    const path = this.objectPath(oid);
    if (existsSync(path)) return;
    const dir = join(this.objectsDir, oid.slice(0, 2));
    if (!this.dirs.has(dir)) {
      mkdirSync(dir, { recursive: true });
      this.dirs.add(dir);
    }
    writeFileSync(path, encodeLoose(object.type, object.data));
  }

  /** Drain the queued object writes, then the refs file: one pass per loop turn. */
  flush(): void {
    const batch = this.pending;
    this.pending = [];
    for (const { oid, object } of batch) {
      try {
        this.writeLoose(oid, object);
      } catch {
        // A failed write leaves the object in memory; the exit flush tries it once more.
      }
    }
    this.persistRefsNow();
  }

  /** Everything queued, written synchronously: the process is about to exit. */
  flushNow(): void {
    if (this.flushHandle !== null) {
      clearTimeout(this.flushHandle);
      this.flushHandle = null;
    }
    const batch = this.pending;
    this.pending = [];
    for (const { oid, object } of batch) {
      try {
        this.writeLoose(oid, object);
      } catch {
        // Nothing left to try at exit.
      }
    }
    this.persistRefsNow();
  }

  setRef(name: string, oid: string): void {
    this.refs.set(name, oid);
    this.refsDirty = true;
    this.refsVersion += 1;
  }

  deleteRef(name: string): void {
    this.refs.delete(name);
    this.refsDirty = true;
    this.refsVersion += 1;
  }

  /** Queue the refs file: it is written on the next loop turn, and always before the process exits. */
  persistRefs(): void {
    if (!this.refsDirty) return;
    if (this.flushHandle === null) {
      this.flushHandle = setTimeout(() => {
        this.flushHandle = null;
        this.flush();
      }, WRITE_BEHIND_MS);
      this.flushHandle.unref();
    }
  }

  /** Write refs.json once per mutation batch, atomically, so a crash never leaves half a file. */
  private persistRefsNow(): void {
    if (!this.refsDirty) return;
    const tmp = `${this.refsFile}.tmp`;
    writeFileSync(tmp, JSON.stringify({ refs: Object.fromEntries(this.refs) }));
    renameSync(tmp, this.refsFile);
    this.refsDirty = false;
  }

  /** Follow tags down to the commit (or blob) they name: ls-refs' peeled line. */
  peel(oid: string): string {
    let current = oid;
    for (let hop = 0; hop < 10; hop += 1) {
      const object = this.read(current);
      if (object === null || object.type !== 'tag') return current;
      const target = parseTag(object.data).object;
      if (!target) return current;
      current = target;
    }
    return current;
  }
}

/** Every object reachable from `roots`, with its id, in send order: commits, then trees, then blobs. */
export function collectReachable(store: ObjectStore, roots: Iterable<string>): Array<{ oid: string; object: GitObject }> {
  const commits: Array<{ oid: string; object: GitObject }> = [];
  const trees: Array<{ oid: string; object: GitObject }> = [];
  const blobs: Array<{ oid: string; object: GitObject }> = [];
  const seen = new Set<string>();
  const stack: string[] = [...roots];
  while (stack.length) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = store.read(oid);
    if (object === null) continue;
    if (object.type === 'commit') {
      commits.push({ oid, object });
      const parsed = parseCommit(object.data);
      if (parsed.tree) stack.push(parsed.tree);
      for (const parent of parsed.parents) stack.push(parent);
    } else if (object.type === 'tree') {
      trees.push({ oid, object });
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    } else if (object.type === 'tag') {
      commits.push({ oid, object });
      const target = parseTag(object.data).object;
      if (target) stack.push(target);
    } else {
      blobs.push({ oid, object });
    }
  }
  return [...commits, ...trees, ...blobs];
}

export interface FetchClosure {
  readonly objects: GitObject[];
  /** Commits whose parents are cut off by the requested depth: the shallow-info lines. */
  readonly shallow: string[];
}

/**
 * What a fetch must send: objects reachable from `wants`, less everything reachable from `haves`,
 * walked only as deep as `depth` (1 = the wanted commits alone, null = the whole history).
 */
export function fetchClosure(
  store: ObjectStore,
  wants: readonly string[],
  haves: readonly string[],
  depth: number | null,
): FetchClosure {
  const known = new Set<string>();
  if (haves.length) {
    if (depth === null) {
      // A full fetch: everything the client holds is off limits, its whole reachable closure.
      for (const entry of collectReachable(store, haves)) known.add(entry.oid);
    } else {
      // A shallow client holds only the boundary commits it lists as haves: the history behind them
      // is exactly what it is asking to be sent.
      for (const oid of haves) known.add(oid);
    }
  }
  const commits: GitObject[] = [];
  const trees: GitObject[] = [];
  const blobs: GitObject[] = [];
  const shallow: string[] = [];
  const emitted = new Set<string>();
  const visitedCommits = new Set<string>();
  const visitedTrees = new Set<string>();

  /** Emit an object once: a tag, a commit and a tree walk can all reach the same object. */
  const emit = (oid: string, object: GitObject): void => {
    if (emitted.has(oid) || known.has(oid)) return;
    emitted.add(oid);
    if (object.type === 'commit' || object.type === 'tag') commits.push(object);
    else if (object.type === 'tree') trees.push(object);
    else blobs.push(object);
  };

  const walkTree = (oid: string): void => {
    if (visitedTrees.has(oid)) return;
    visitedTrees.add(oid);
    if (known.has(oid) || emitted.has(oid)) return;
    const object = store.read(oid);
    if (object === null) return;
    if (object.type === 'tree') {
      emit(oid, object);
      for (const entry of parseTree(object.data)) walkTree(entry.oid);
    } else if (object.type === 'blob') {
      emit(oid, object);
    } else if (object.type === 'commit') {
      emit(oid, object);
      const parsed = parseCommit(object.data);
      if (parsed.tree) walkTree(parsed.tree);
    } else if (object.type === 'tag') {
      emit(oid, object);
      const target = parseTag(object.data).object;
      if (target) walkTree(target);
    }
  };

  const queue: Array<{ oid: string; level: number }> = wants.map((oid) => ({ oid, level: 0 }));
  while (queue.length) {
    const item = queue.shift();
    if (item === undefined) break;
    const { oid, level } = item;
    if (visitedCommits.has(oid)) continue;
    visitedCommits.add(oid);
    const object = store.read(oid);
    if (object === null) continue;
    if (object.type !== 'commit') {
      walkTree(oid);
      continue;
    }
    const parsed = parseCommit(object.data);
    const held = known.has(oid);
    if (!held) {
      emit(oid, object);
      if (parsed.tree) walkTree(parsed.tree);
    }
    // A held commit with no depth request ends the walk: the client already has its history.
    if (held && depth === null) continue;
    for (const parent of parsed.parents) {
      if (depth !== null && level + 1 >= depth) {
        // The parent is beyond the requested depth: this commit is the new shallow boundary.
        if (!held && !shallow.includes(oid)) shallow.push(oid);
        continue;
      }
      queue.push({ oid: parent, level: level + 1 });
    }
  }
  return { objects: [...commits, ...trees, ...blobs], shallow };
}
