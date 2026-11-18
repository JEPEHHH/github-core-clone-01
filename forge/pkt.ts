// pkt-line framing: the length-prefixed packet stream git speaks on every wire.
// "0000" is a flush, "0001" a delimiter, "0002" a response-end; anything else is data whose 4 hex
// digits count the whole packet, header included. Every git surface here is built from these.

export type PacketKind = 'data' | 'flush' | 'delim' | 'response-end';

export interface Packet {
  readonly kind: PacketKind;
  readonly payload: Buffer;
}

export const FLUSH: Buffer = Buffer.from('0000', 'ascii');
export const DELIM: Buffer = Buffer.from('0001', 'ascii');

/** The largest payload one packet may carry: the 65520-byte pkt-line ceiling less its header. */
export const MAX_PACKET_PAYLOAD = 65516;

export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length > MAX_PACKET_PAYLOAD) throw new Error(`pkt-line payload of ${data.length} bytes is over the ceiling`);
  const header = Buffer.from((data.length + 4).toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, data]);
}

export function pktLines(parts: ReadonlyArray<string | Buffer | 'flush' | 'delim'>): Buffer {
  const out: Buffer[] = [];
  for (const part of parts) {
    if (part === 'flush') out.push(FLUSH);
    else if (part === 'delim') out.push(DELIM);
    else out.push(pktLine(part));
  }
  return Buffer.concat(out);
}

/**
 * Decode every complete packet in `buf`, stopping at the first truncated one. `rest` is what follows
 * the last complete packet: for receive-pack that is the packfile, which is not pkt-framed.
 */
export function decodePackets(buf: Buffer): { packets: Packet[]; rest: Buffer } {
  const packets: Packet[] = [];
  let offset = 0;
  while (offset + 4 <= buf.length) {
    const header = buf.toString('ascii', offset, offset + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(header)) break;
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > buf.length) break;
    packets.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, rest: buf.subarray(offset) };
}

/** Split the data packets of a section into trimmed lines (a packet's trailing newline removed). */
export function packetLines(packets: readonly Packet[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8');
    for (const line of text.split('\n')) if (line !== '') lines.push(line);
  }
  return lines;
}
