// The packfile: what upload-pack streams and what receive-pack unpacks. A pack is "PACK", a version,
// an object count, each object's type/size header plus its zlib stream, and a SHA-1 of everything
// before it. Writing sends whole objects (no deltas); reading accepts whole, OFS_DELTA and
// REF_DELTA entries, because a real client may compress its push.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import type { GitObject, ObjectType } from './objects.ts';
import { hashObject } from './objects.ts';

const TYPE_CODE: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** The type/size header of a pack entry: 3 type bits, then 4 size bits and 7-bit continuation groups. */
export function encodeEntryHeader(typeCode: number, size: number): Buffer {
  const bytes: number[] = [];
  let remaining = size;
  let first = (typeCode << 4) | (remaining % 16);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push((first | 0x80) & 0xff);
    first = remaining % 128;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first & 0xff);
  return Buffer.from(bytes);
}

/** A pack holding `objects` whole, checksummed. An empty list still yields a valid 32-byte pack. */
export function buildPack(objects: readonly GitObject[]): Buffer {
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  const parts: Buffer[] = [header];
  for (const object of objects) {
    parts.push(encodeEntryHeader(TYPE_CODE[object.type], object.data.length));
    parts.push(deflateSync(object.data, { level: 3 }));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

function readSize(buffer: Buffer, start: number): { size: number; next: number } {
  let size = 0;
  let shift = 1;
  let offset = start;
  for (;;) {
    const byte = buffer[offset];
    if (byte === undefined) throw new Error('pack entry header runs past the buffer');
    offset += 1;
    size += (byte & 0x7f) * shift;
    if ((byte & 0x80) === 0) return { size, next: offset };
    shift *= 128;
    if (shift > 2 ** 53) throw new Error('pack delta size overflows');
  }
}

function readOfsDeltaBase(buffer: Buffer, start: number): { distance: number; next: number } {
  let offset = start;
  let byte = buffer[offset];
  if (byte === undefined) throw new Error('ofs-delta base runs past the buffer');
  offset += 1;
  let distance = byte & 0x7f;
  while ((byte & 0x80) !== 0) {
    byte = buffer[offset];
    if (byte === undefined) throw new Error('ofs-delta base runs past the buffer');
    offset += 1;
    distance = (distance + 1) * 128 + (byte & 0x7f);
  }
  return { distance, next: offset };
}

/** Apply a git delta: base length, result length, then copy/insert instructions. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const baseSize = readSize(delta, offset);
  offset = baseSize.next;
  const resultSize = readSize(delta, offset);
  offset = resultSize.next;
  if (baseSize.size !== base.length) throw new Error(`delta expects a ${baseSize.size}-byte base, got ${base.length}`);
  const out = Buffer.alloc(resultSize.size);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset] as number;
    offset += 1;
    if (op === 0) throw new Error('delta opcode 0 is reserved');
    if ((op & 0x80) !== 0) {
      let copyOffset = 0;
      let copySize = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if ((op & (1 << bit)) !== 0) {
          copyOffset |= (delta[offset] as number) << (bit * 8);
          offset += 1;
        }
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if ((op & (1 << (4 + bit))) !== 0) {
          copySize |= (delta[offset] as number) << (bit * 8);
          offset += 1;
        }
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else {
      delta.copy(out, written, offset, offset + op);
      written += op;
      offset += op;
    }
  }
  if (written !== resultSize.size) throw new Error(`delta produced ${written} bytes, header says ${resultSize.size}`);
  return out;
}

export interface PackReadResult {
  readonly objects: Array<{ oid: string; object: GitObject }>;
  readonly checksumOk: boolean;
  readonly declaredCount: number;
}

/**
 * Parse a pack, resolving OFS_DELTA and REF_DELTA against entries already read in this pack, then
 * against `lookup` (objects the forge already stores). Throws on a truncated or malformed pack.
 */
export function readPack(pack: Buffer, lookup?: (oid: string) => GitObject | null): PackReadResult {
  if (pack.length < 32) throw new Error('pack is shorter than its header and trailer');
  if (pack.toString('ascii', 0, 4) !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`pack version ${version} is not 2 or 3`);
  const body = pack.subarray(0, pack.length - 20);
  const checksumOk = createHash('sha1').update(body).digest().equals(pack.subarray(pack.length - 20));
  const declaredCount = pack.readUInt32BE(8);
  const byOffset = new Map<number, { oid: string; object: GitObject }>();
  const byOid = new Map<string, GitObject>();
  const objects: Array<{ oid: string; object: GitObject }> = [];
  let offset = 12;

  const resolveOid = (oid: string): GitObject | null => {
    const local = byOid.get(oid);
    if (local !== undefined) return local;
    return lookup ? lookup(oid) : null;
  };

  for (let index = 0; index < declaredCount; index += 1) {
    const start = offset;
    const first = pack[offset];
    if (first === undefined) throw new Error('pack ends inside an entry header');
    const typeCode = (first >> 4) & 0x07;
    let size = first & 0x0f;
    let shift = 16;
    offset += 1;
    let byte = first;
    while ((byte & 0x80) !== 0) {
      byte = pack[offset];
      if (byte === undefined) throw new Error('pack ends inside an entry header');
      offset += 1;
      size += (byte & 0x7f) * shift;
      shift *= 128;
    }
    let object: GitObject;
    if (typeCode === 6) {
      const base = readOfsDeltaBase(pack, offset);
      offset = base.next;
      const inflated = inflateSync(pack.subarray(offset), { info: true });
      offset += inflated.engine.bytesWritten;
      const baseEntry = byOffset.get(start - base.distance);
      if (baseEntry === undefined) throw new Error(`ofs-delta base at ${start - base.distance} is not in this pack`);
      const data = applyDelta(baseEntry.object.data, inflated.buffer);
      object = { type: baseEntry.object.type, data };
    } else if (typeCode === 7) {
      const baseOid = pack.toString('hex', offset, offset + 20);
      offset += 20;
      const inflated = inflateSync(pack.subarray(offset), { info: true });
      offset += inflated.engine.bytesWritten;
      const baseObject = resolveOid(baseOid);
      if (baseObject === null) throw new Error(`ref-delta base ${baseOid} is not in this pack or the store`);
      const data = applyDelta(baseObject.data, inflated.buffer);
      object = { type: baseObject.type, data };
    } else {
      const type = CODE_TYPE[typeCode];
      if (type === undefined) throw new Error(`pack entry type ${typeCode} is not a git object`);
      const inflated = inflateSync(pack.subarray(offset), { info: true });
      offset += inflated.engine.bytesWritten;
      object = { type, data: inflated.buffer };
      if (object.data.length !== size) throw new Error(`pack ${type} declares ${size} bytes, holds ${object.data.length}`);
    }
    const oid = hashObject(object.type, object.data);
    byOid.set(oid, object);
    byOffset.set(start, { oid, object });
    objects.push({ oid, object });
  }
  return { objects, checksumOk, declaredCount };
}
