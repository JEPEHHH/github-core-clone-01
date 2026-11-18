// The git smart-HTTP surfaces: the upload-pack protocol-v2 advertisement, ls-refs and fetch, and the
// receive-pack v0 advertisement and push. Nothing here frames HTTP; app.ts does that. Every reply is
// bytes, so a mistake is a protocol error rather than a wrong shape in a JSON body.

import { parseCommit, parseTag, parseTree, ZERO_OID, fetchClosure, hashObject } from './objects.ts';
import type { ObjectStore } from './objects.ts';
import { buildPack, readPack } from './pack.ts';
import { DELIM, FLUSH, decodePackets, pktLine, pktLines, type Packet } from './pkt.ts';

const AGENT = 'agent=git/forge-1.0';

/** Largest band-1 slice: a pkt-line may carry 65516 payload bytes, so leave room for the band byte. */
const BAND_CHUNK = 60_000;

export const UPLOAD_PACK_ADVERTISEMENT = 'application/x-git-upload-pack-advertisement';
export const UPLOAD_PACK_RESULT = 'application/x-git-upload-pack-result';
export const RECEIVE_PACK_ADVERTISEMENT = 'application/x-git-receive-pack-advertisement';
export const RECEIVE_PACK_RESULT = 'application/x-git-receive-pack-result';

/** The v2 capability advertisement: the suite's client requires fetch and ls-refs to be there. */
export function uploadPackAdvertisement(): Buffer {
  return pktLines([
    'version 2\n',
    `${AGENT}\n`,
    'ls-refs=unborn\n',
    'fetch=shallow\n',
    'object-format=sha1\n',
    'server-option\n',
    'flush',
  ]);
}

const RECEIVE_CAPABILITIES = ['report-status', 'side-band-64k', 'delete-refs', 'ofs-delta', AGENT];

/** The refs of a repo as v0 advertisement lines; an empty repo answers the capabilities^{} line. */
function advertisementRefs(store: ObjectStore, capabilities: readonly string[]): Buffer {
  const names = [...store.refs.keys()].sort((a, b) => {
    const rank = (name: string): number => (name === 'refs/heads/main' ? 0 : name.startsWith('refs/heads/') ? 1 : name.startsWith('refs/tags/') ? 2 : 3);
    const byRank = rank(a) - rank(b);
    return byRank !== 0 ? byRank : a < b ? -1 : a > b ? 1 : 0;
  });
  const parts: Buffer[] = [];
  if (names.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\u0000${capabilities.join(' ')}\n`));
  } else {
    names.forEach((name, index) => {
      const oid = store.refs.get(name) as string;
      parts.push(pktLine(index === 0 ? `${oid} ${name}\u0000${capabilities.join(' ')}\n` : `${oid} ${name}\n`));
    });
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

/** receive-pack is v0 only: the service preamble, then the ref advertisement carrying the push caps. */
export function receivePackAdvertisement(store: ObjectStore): Buffer {
  return Buffer.concat([
    pktLine('# service=git-receive-pack\n'),
    FLUSH,
    advertisementRefs(store, RECEIVE_CAPABILITIES),
  ]);
}

/** The v0 upload-pack preamble, for a client that did not ask for v2. */
export function uploadPackAdvertisementV0(store: ObjectStore): Buffer {
  const capabilities = ['side-band-64k', 'ofs-delta', 'shallow', 'multi_ack_detailed', AGENT];
  return Buffer.concat([
    pktLine('# service=git-upload-pack\n'),
    FLUSH,
    advertisementRefs(store, capabilities),
  ]);
}

interface V2Request {
  readonly command: string;
  readonly capabilities: Map<string, string>;
  readonly args: string[];
}

/** Split a v2 request body: the command line, the capability lines, then the argument lines. */
function parseV2Request(body: Buffer): V2Request {
  const { packets } = decodePackets(body);
  let command = '';
  const capabilities = new Map<string, string>();
  const args: string[] = [];
  let inArgs = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      inArgs = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8').replace(/\n$/, '');
    if (text === '') continue;
    if (!inArgs) {
      const equals = text.indexOf('=');
      if (command === '' && text.startsWith('command=')) {
        command = text.slice('command='.length);
      } else if (equals < 0) {
        capabilities.set(text, '');
      } else {
        capabilities.set(text.slice(0, equals), text.slice(equals + 1));
      }
      continue;
    }
    args.push(text);
  }
  return { command, capabilities, args };
}

/** ls-refs: the refs, HEAD's symref target and a tag's peeled commit, filtered by ref-prefix. */
function lsRefs(store: ObjectStore, args: readonly string[]): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg === 'unborn') unborn = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  for (const name of [...store.refs.keys()].sort()) {
    if (!matches(name)) continue;
    const oid = store.refs.get(name) as string;
    let line = `${oid} ${name}`;
    if (peel && name.startsWith('refs/tags/')) {
      const peeled = store.peel(oid);
      if (peeled !== oid) line += ` peeled:${peeled}`;
    }
    parts.push(pktLine(`${line}\n`));
  }
  const headTarget = 'refs/heads/main';
  const headOid = store.refs.get(headTarget);
  if (matches('HEAD')) {
    if (headOid !== undefined) {
      parts.push(pktLine(`${headOid} HEAD${symrefs ? ` symref-target:${headTarget}` : ''}\n`));
    } else if (unborn) {
      parts.push(pktLine(`unborn HEAD${symrefs ? ` symref-target:${headTarget}` : ''}\n`));
    }
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

/** One band-1 sideband packet per slice, so no pkt-line passes the 65520-byte ceiling. */
function sideband(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  for (let offset = 0; offset < pack.length; offset += BAND_CHUNK) {
    const slice = pack.subarray(offset, Math.min(offset + BAND_CHUNK, pack.length));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  return parts;
}

/** The generation of each commit reachable from `wants`, out to `maxLevel`: for deepen-relative. */
function commitLevels(store: ObjectStore, wants: readonly string[], maxLevel: number): Map<string, number> {
  const levels = new Map<string, number>();
  const queue: Array<{ oid: string; level: number }> = wants.map((oid) => ({ oid, level: 0 }));
  while (queue.length) {
    const item = queue.shift();
    if (item === undefined) break;
    if (levels.has(item.oid)) continue;
    levels.set(item.oid, item.level);
    if (item.level >= maxLevel) continue;
    const object = store.read(item.oid);
    if (object === null || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queue.push({ oid: parent, level: item.level + 1 });
  }
  return levels;
}

/** fetch: the objects the wants reach and the haves do not, then shallow-info when depth cuts. */
function fetch(store: ObjectStore, args: readonly string[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const boundaries: string[] = [];
  let depth: number | null = null;
  let relative = false;
  for (const arg of args) {
    if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
    else if (arg === 'deepen-relative') relative = true;
    else if (arg.startsWith('shallow ')) boundaries.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) {
      const parsed = Number.parseInt(arg.slice(7).trim(), 10);
      if (Number.isFinite(parsed) && parsed > 0) depth = parsed;
    }
  }
  // "deepen 1" with deepen-relative means one generation past the client's own boundary, not a
  // total depth of one: the boundary's level from the wants says where the new cut belongs.
  if (relative && depth !== null && boundaries.length && wants.length) {
    const levels = commitLevels(store, wants, boundaries.length ? 1000 : 0);
    let furthest = -1;
    for (const boundary of boundaries) {
      const level = levels.get(boundary);
      if (level !== undefined && level > furthest) furthest = level;
    }
    if (furthest >= 0) depth = furthest + 1 + depth;
  }
  if (wants.length === 0) return FLUSH;
  const closure = fetchClosure(store, wants, haves, depth);
  const pack = buildPack(closure.objects);
  const parts: Buffer[] = [];
  if (closure.shallow.length) {
    // The boundary section goes first: a client that reads acknowledgments counts on the packfile
    // (or its shallow boundary) arriving straight after a "ready".
    parts.push(pktLine('shallow-info\n'));
    for (const oid of closure.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    parts.push(FLUSH);
  }
  if (haves.length) {
    // A client that sent haves reads the acknowledgments section before the pack; "ready" then
    // tells it the pack follows in this same response, as a delim-pkt introduces it.
    parts.push(pktLine('acknowledgments\n'));
    for (const have of haves) {
      if (store.has(have)) parts.push(pktLine(`ACK ${have}\n`));
    }
    parts.push(pktLine('ready\n'));
    parts.push(DELIM);
  }
  parts.push(pktLine('packfile\n'));
  parts.push(...sideband(pack));
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

/** Answer a POST /git-upload-pack body. Throws on a body that is not a v2 command. */
export function handleUploadPack(store: ObjectStore, body: Buffer): Buffer {
  const request = parseV2Request(body);
  if (request.command === 'ls-refs') return lsRefs(store, request.args);
  if (request.command === 'fetch') return fetch(store, request.args);
  throw new Error(`unsupported upload-pack command ${JSON.stringify(request.command)}`);
}

interface PushCommand {
  readonly oldOid: string;
  readonly newOid: string;
  readonly ref: string;
}

/** The command list of a receive-pack body: pkt-lines up to the flush, then the pack. */
function parsePushBody(body: Buffer): { commands: PushCommand[]; capabilities: Set<string>; pack: Buffer } {
  const { packets, rest } = decodePackets(body);
  const commands: PushCommand[] = [];
  const capabilities = new Set<string>();
  let first = true;
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line === '') continue;
    if (first) {
      const nul = line.indexOf('\u0000');
      if (nul >= 0) {
        for (const capability of line.slice(nul + 1).split(' ')) if (capability !== '') capabilities.add(capability);
        line = line.slice(0, nul);
      }
      first = false;
    }
    const parts = line.split(' ');
    if (parts.length < 3) throw new Error(`push command line ${JSON.stringify(line.slice(0, 80))} is not "<old> <new> <ref>"`);
    const [oldOid, newOid, ref] = parts as [string, string, string];
    if (!/^[0-9a-f]{40}$/.test(oldOid) || !/^[0-9a-f]{40}$/.test(newOid)) throw new Error('push command names a bad object id');
    if (!ref.startsWith('refs/')) throw new Error(`push command names a bad ref ${JSON.stringify(ref)}`);
    commands.push({ oldOid, newOid, ref });
  }
  return { commands, capabilities, pack: rest };
}

/** True when `oldOid` is an ancestor of `newOid` (or the same commit): every branch update must be one. */
function isFastForward(store: ObjectStore, oldOid: string, newOid: string): boolean {
  if (oldOid === newOid) return true;
  const stack = [newOid];
  const seen = new Set<string>();
  while (stack.length) {
    const oid = stack.pop() as string;
    if (oid === oldOid) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = store.read(oid);
    if (object === null || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) stack.push(parent);
  }
  return false;
}

/** Apply a push: unpack the pack into the store, then move each ref or refuse it per-ref. */
export function handleReceivePack(store: ObjectStore, body: Buffer): Buffer {
  const { commands, capabilities, pack } = parsePushBody(body);
  let unpackDetail = 'ok';
  if (pack.length > 0) {
    try {
      const read = readPack(pack, (oid) => store.read(oid));
      if (!read.checksumOk) throw new Error('pack trailer does not match its bytes');
      for (const entry of read.objects) store.adopt(entry.oid, entry.object);
    } catch (err) {
      unpackDetail = err instanceof Error ? err.message : String(err);
    }
  }
  const lines: string[] = [`unpack ${unpackDetail}\n`];
  if (unpackDetail === 'ok') {
    for (const command of commands) {
      const current = store.refs.get(command.ref) ?? ZERO_OID;
      if (command.newOid === ZERO_OID) {
        if (current === ZERO_OID) {
          lines.push(`ok ${command.ref}\n`);
        } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
          lines.push(`ng ${command.ref} stale info\n`);
        } else {
          store.deleteRef(command.ref);
          lines.push(`ok ${command.ref}\n`);
        }
        continue;
      }
      if (!store.has(command.newOid)) {
        lines.push(`ng ${command.ref} missing necessary objects\n`);
        continue;
      }
      if (command.oldOid === ZERO_OID) {
        if (current !== ZERO_OID) {
          lines.push(`ng ${command.ref} already exists\n`);
          continue;
        }
      } else if (current !== command.oldOid) {
        lines.push(`ng ${command.ref} stale info\n`);
        continue;
      } else if (command.ref.startsWith('refs/heads/') && !isFastForward(store, command.oldOid, command.newOid)) {
        lines.push(`ng ${command.ref} non-fast-forward\n`);
        continue;
      }
      store.setRef(command.ref, command.newOid);
      lines.push(`ok ${command.ref}\n`);
    }
  } else {
    for (const command of commands) lines.push(`ng ${command.ref} unpacker error\n`);
  }
  store.persistRefs();
  const report = pktLines([...lines, 'flush']);
  if (capabilities.has('side-band-64k')) {
    return Buffer.concat([pktLine(Buffer.concat([Buffer.from([1]), report])), FLUSH]);
  }
  return report;
}

/** A tree's entries as the REST contents API lists them (used by the REST module too). */
export function treeEntries(store: ObjectStore, oid: string): Array<{ mode: string; name: string; oid: string }> {
  const object = store.read(oid);
  if (object === null || object.type !== 'tree') return [];
  return parseTree(object.data);
}

/** Follow a tag to its target, as the REST refs surface reports it. */
export function peelTag(store: ObjectStore, oid: string): string {
  return store.peel(oid);
}

/** The commit a ref resolves to, for the REST branches/commits surface. */
export function commitOf(store: ObjectStore, oid: string): { tree: string; parents: string[] } | null {
  const object = store.read(oid);
  if (object === null || object.type !== 'commit') return null;
  return parseCommit(object.data);
}

/** An object id recomputed from bytes, for the REST blob shas. */
export function oidOf(store: ObjectStore, oid: string): string | null {
  const object = store.read(oid);
  if (object === null) return null;
  return hashObject(object.type, object.data);
}

/** Exported for the REST contents surface: a tag object's target type. */
export function tagTarget(store: ObjectStore, oid: string): { object: string; type: string } | null {
  const object = store.read(oid);
  if (object === null || object.type !== 'tag') return null;
  return parseTag(object.data);
}

export type { Packet };
