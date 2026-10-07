/*
  DNS messages as mDNS carries them (RFC 6762, RFC 6763): enough to ask
  which instances of a service are on the home network, and to read what
  they answer — the PTR naming each instance, its SRV (where), its TXT
  (what it says of itself) and the address of the host it names. Pure:
  bytes in, records out, so it is tested without a network.
*/

const RECORD = { A: 1, PTR: 12, TXT: 16, AAAA: 28, SRV: 33 } as const;

/** One record of an answer, read as far as discovery needs it; any other type is kept as its type alone. */
export type DnsRecord =
  | { type: 'A'; name: string; ttl: number; address: string }
  | { type: 'PTR'; name: string; ttl: number; target: string }
  | { type: 'TXT'; name: string; ttl: number; txt: Record<string, string> }
  | { type: 'SRV'; name: string; ttl: number; port: number; target: string }
  | { type: 'other'; name: string; ttl: number };

/** A message read: whether it answers, and every record it carries — answers and additionals alike. */
export type DnsMessage = { response: boolean; questions: string[]; records: DnsRecord[] };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** A name as labels on the wire: `_airplay._tcp.local`. */
function nameBytes(name: string): number[] {
  const bytes: number[] = [];
  for (const label of name.split('.').filter(Boolean)) {
    const encoded = encoder.encode(label);
    if (encoded.length > 63) throw new Error(`"${label}" is too long for a DNS label`);
    bytes.push(encoded.length, ...encoded);
  }
  bytes.push(0);
  return bytes;
}

/** A query asking, for each name, what points at its instances (PTR): how a browser asks who offers a service. */
export function ptrQuery(names: readonly string[]): Uint8Array {
  const bytes = [0, 0, 0, 0, names.length >> 8, names.length & 0xff, 0, 0, 0, 0, 0, 0];
  for (const name of names) bytes.push(...nameBytes(name), 0, RECORD.PTR, 0, 1);
  return new Uint8Array(bytes);
}

/** Reads a name at `offset`, following compression pointers: the name, and where what follows it begins. */
function readName(data: Uint8Array, offset: number): { name: string; next: number } {
  const labels: string[] = [];
  let at = offset;
  let next = -1;
  for (let jumps = 0; jumps < 64; jumps++) {
    if (at >= data.length) throw new Error('A name runs past the end');
    const length = data[at]!;
    if (length === 0) {
      return { name: labels.join('.'), next: next < 0 ? at + 1 : next };
    }
    if ((length & 0xc0) === 0xc0) {
      if (at + 1 >= data.length) throw new Error('A pointer runs past the end');
      if (next < 0) next = at + 2;
      at = ((length & 0x3f) << 8) | data[at + 1]!;
      continue;
    }
    labels.push(decoder.decode(data.subarray(at + 1, at + 1 + length)));
    at += 1 + length;
  }
  throw new Error('A name points in a loop');
}

/** TXT data as its key=value pairs; a key with no value is said with none. */
function readTxt(data: Uint8Array): Record<string, string> {
  const txt: Record<string, string> = {};
  for (let at = 0; at < data.length; ) {
    const length = data[at]!;
    const entry = decoder.decode(data.subarray(at + 1, at + 1 + length));
    at += 1 + length;
    if (!entry) continue;
    const equals = entry.indexOf('=');
    const key = (equals < 0 ? entry : entry.slice(0, equals)).toLowerCase();
    // The first of a key is its value (RFC 6763 §6.4).
    if (!(key in txt)) txt[key] = equals < 0 ? '' : entry.slice(equals + 1);
  }
  return txt;
}

/** Reads one message. Throws on bytes that are not one: what came in on 5353 is anyone's. */
export function readMessage(data: Uint8Array): DnsMessage {
  if (data.length < 12) throw new Error('Too short to be a DNS message');
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const response = (view.getUint16(2) & 0x8000) !== 0;
  const counts = [view.getUint16(4), view.getUint16(6), view.getUint16(8), view.getUint16(10)] as const;
  let at = 12;
  const questions: string[] = [];
  for (let index = 0; index < counts[0]; index++) {
    const { name, next } = readName(data, at);
    questions.push(name);
    at = next + 4;
  }
  const records: DnsRecord[] = [];
  for (let index = 0; index < counts[1] + counts[2] + counts[3]; index++) {
    const { name, next } = readName(data, at);
    if (next + 10 > data.length) throw new Error('A record runs past the end');
    const type = view.getUint16(next);
    const ttl = view.getUint32(next + 4);
    const length = view.getUint16(next + 8);
    const start = next + 10;
    if (start + length > data.length) throw new Error('A record runs past the end');
    const rdata = data.subarray(start, start + length);
    switch (type) {
      case RECORD.A:
        records.push(length === 4 ? { type: 'A', name, ttl, address: [...rdata].join('.') } : { type: 'other', name, ttl });
        break;
      case RECORD.PTR:
        records.push({ type: 'PTR', name, ttl, target: readName(data, start).name });
        break;
      case RECORD.TXT:
        records.push({ type: 'TXT', name, ttl, txt: readTxt(rdata) });
        break;
      case RECORD.SRV:
        records.push({ type: 'SRV', name, ttl, port: view.getUint16(start + 4), target: readName(data, start + 6).name });
        break;
      default:
        records.push({ type: 'other', name, ttl });
    }
    at = start + length;
  }
  return { response, questions, records };
}

/** Writes a response carrying these records: what a test plays a device with. */
export function writeResponse(records: readonly DnsRecord[]): Uint8Array {
  const written = records.filter((record) => record.type !== 'other');
  const bytes = [0, 0, 0x84, 0, 0, 0, written.length >> 8, written.length & 0xff, 0, 0, 0, 0];
  for (const record of written) {
    let type: number;
    let rdata: number[];
    switch (record.type) {
      case 'A':
        type = RECORD.A;
        rdata = record.address.split('.').map(Number);
        break;
      case 'PTR':
        type = RECORD.PTR;
        rdata = nameBytes(record.target);
        break;
      case 'TXT':
        type = RECORD.TXT;
        rdata = Object.entries(record.txt).flatMap(([key, value]) => {
          const entry = encoder.encode(`${key}=${value}`);
          return [entry.length, ...entry];
        });
        break;
      case 'SRV':
        type = RECORD.SRV;
        rdata = [0, 0, 0, 0, record.port >> 8, record.port & 0xff, ...nameBytes(record.target)];
        break;
      default:
        continue;
    }
    bytes.push(...nameBytes(record.name), type >> 8, type & 0xff, 0x80, 1, (record.ttl >>> 24) & 0xff, (record.ttl >>> 16) & 0xff, (record.ttl >>> 8) & 0xff, record.ttl & 0xff, rdata.length >> 8, rdata.length & 0xff, ...rdata);
  }
  return new Uint8Array(bytes);
}
