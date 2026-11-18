// The forge's repositories: a registry under .forge/repos.json, and one ObjectStore per repository
// under .forge/repos/<name>/. A repository is created through REST (POST /api/v3/user/repos) and a
// push can never invent one. Ownership is claimed by the first owner-path that reaches the repo: the
// suite's bearer token names a login the entry is never told, so the first /<owner>/<repo>.git request
// (or the matching REST read) binds the repo to that owner, and another owner then sees a 404.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ObjectStore } from './objects.ts';

export interface RepoMeta {
  id: number;
  name: string;
  owner: string | null;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdAt: string;
}

export interface RegistryFile {
  nextId: number;
  repos: RepoMeta[];
}

/** A trial's clock: the instance's opening time, never the host's. */
function trialNow(): string {
  const raw = process.env.MAKEFUN_TRIAL_NOW ?? '';
  const parsed = raw === '' ? Number.NaN : Date.parse(raw);
  if (Number.isNaN(parsed)) return '2026-11-14T06:30:00Z';
  return new Date(parsed).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export class Registry {
  readonly root: string;
  readonly reposDir: string;
  readonly metaFile: string;
  readonly repos = new Map<string, RepoMeta>();
  private readonly stores = new Map<string, ObjectStore>();
  private nextId = 1;
  private dirty = false;

  constructor(root: string) {
    this.root = root;
    this.reposDir = join(root, 'repos');
    this.metaFile = join(this.reposDir, 'repos.json');
    mkdirSync(this.reposDir, { recursive: true });
    if (existsSync(this.metaFile)) {
      try {
        const parsed = JSON.parse(readFileSync(this.metaFile, 'utf8')) as RegistryFile;
        for (const repo of parsed.repos ?? []) this.repos.set(repo.name, repo);
        this.nextId = parsed.nextId ?? this.repos.size + 1;
      } catch {
        // An unreadable registry starts empty; a fresh trial writes it before any read.
      }
    }
  }

  /** A store handle per repository name; the ObjectStore itself owns objects and refs. */
  store(name: string): ObjectStore {
    const existing = this.stores.get(name);
    if (existing !== undefined) return existing;
    const store = new ObjectStore(join(this.reposDir, name));
    this.stores.set(name, store);
    return store;
  }

  get(name: string): RepoMeta | null {
    return this.repos.get(name) ?? null;
  }

  /** Create a repo, or return the one that is already there (the idempotent REST create). */
  create(name: string, options: { description?: string; private?: boolean } = {}): RepoMeta {
    const existing = this.repos.get(name);
    if (existing !== undefined) return existing;
    const repo: RepoMeta = {
      id: this.nextId,
      name,
      owner: null,
      description: options.description ?? '',
      private: options.private ?? false,
      defaultBranch: 'main',
      createdAt: trialNow(),
    };
    this.nextId += 1;
    this.repos.set(name, repo);
    this.dirty = true;
    this.persist();
    return repo;
  }

  /**
   * Resolve a repo for an owner: null when it does not exist, or when another owner already holds it.
   * The first owner to reach a repo claims it, which is how the token's login binds without the entry
   * being told its name.
   */
  resolve(name: string, owner: string): RepoMeta | null {
    const repo = this.repos.get(name);
    if (repo === undefined) return null;
    if (repo.owner === null) {
      repo.owner = owner;
      this.dirty = true;
      this.persist();
      return repo;
    }
    return repo.owner === owner ? repo : null;
  }

  /** Delete a repo and everything it holds. */
  remove(name: string): boolean {
    if (!this.repos.has(name)) return false;
    this.repos.delete(name);
    this.stores.delete(name);
    this.dirty = true;
    this.persist();
    return true;
  }

  /** The viewer's repositories, oldest id first: /user/repos and the Link chain page over this. */
  list(): RepoMeta[] {
    return [...this.repos.values()].sort((a, b) => a.id - b.id);
  }

  /**
   * The login this trial's token owns. The entry is never told it: the first owner path to reach a
   * repository binds it (resolve), so the first bound owner is the token's login, and every surface
   * that must name the viewer (GET /user, GraphQL's viewer, an MCP create) reads it from here.
   */
  viewer(): string {
    for (const repo of this.list()) {
      if (repo.owner !== null && repo.owner !== '') return repo.owner;
    }
    return 'forge';
  }

  persist(): void {
    if (!this.dirty) return;
    const body: RegistryFile = { nextId: this.nextId, repos: [...this.repos.values()] };
    const tmp = `${this.metaFile}.tmp`;
    writeFileSync(tmp, JSON.stringify(body));
    renameSync(tmp, this.metaFile);
    this.dirty = false;
  }
}

/** The process's forge root: writable space, never the read-only /bot mount. */
export function forgeRoot(): string {
  return process.env.FORGE_STORE ?? join(process.env.TMPDIR ?? '/tmp', `gh-forge-${process.pid}`);
}
