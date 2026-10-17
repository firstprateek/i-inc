// DNS filter for sandboxes: refuses .ts.net and .local queries so tailnet device names never leak.
// Checked in M1 (docs/m1-findings.md step 3).

/**
 * Parses the QNAME from a DNS query packet header + question section.
 * Returns null if the packet is malformed or contains no question.
 */
export function parseDnsQuestionName(packet: Uint8Array): string | null {
  if (packet.length < 12) return null;
  const b4 = packet[4];
  const b5 = packet[5];
  if (b4 === undefined || b5 === undefined) return null;
  const qdcount = (b4 << 8) | b5;
  if (qdcount < 1) return null;

  const labels: string[] = [];
  let offset = 12;

  while (offset < packet.length) {
    const len = packet[offset++];
    if (len === undefined) return null;
    if (len === 0) {
      return labels.join(".");
    }
    // DNS labels can be at most 63 bytes.
    // If top 2 bits are set (0xc0), it's a compression pointer (invalid in question section of query).
    if (len > 63 || offset + len > packet.length) {
      return null;
    }
    const labelBytes = packet.subarray(offset, offset + len);
    labels.push(new TextDecoder().decode(labelBytes));
    offset += len;
  }

  return null;
}

/**
 * Returns true if the domain name is within .ts.net or .local (case-insensitive).
 */
export function isBlockedSandboxDomain(name: string): boolean {
  const lower = name.toLowerCase().replace(/\.+$/, "");
  return lower === "ts.net" || lower.endsWith(".ts.net") || lower === "local" || lower.endsWith(".local");
}

/**
 * Constructs a valid DNS response packet copying the transaction ID and question section
 * with QR=1 (response) and RCODE=5 (REFUSED).
 */
export function makeDnsRefusedResponse(query: Uint8Array): Uint8Array {
  let questionEnd = 12;
  if (query.length >= 12) {
    let offset = 12;
    while (offset < query.length) {
      const len = query[offset++];
      if (len === undefined) break;
      if (len === 0) {
        questionEnd = Math.min(query.length, offset + 4);
        break;
      }
      if (len > 63) {
        break;
      }
      offset += len;
    }
  }

  const res = new Uint8Array(questionEnd);
  res.set(query.subarray(0, questionEnd));

  if (res.length >= 12) {
    // Transaction ID (bytes 0-1) preserved from query.
    // Set QR=1 (bit 7 of byte 2): preserve opcode & RD from query.
    res[2] = (query[2] ?? 0) | 0x80;
    // Set RCODE=5 (REFUSED: bits 0-3 of byte 3).
    res[3] = ((query[3] ?? 0) & 0xf0) | 0x05;
    // QDCOUNT = 1
    res[4] = 0x00;
    res[5] = 0x01;
    // ANCOUNT = 0
    res[6] = 0x00;
    res[7] = 0x00;
    // NSCOUNT = 0
    res[8] = 0x00;
    res[9] = 0x00;
    // ARCOUNT = 0
    res[10] = 0x00;
    res[11] = 0x00;
  }

  return res;
}

/**
 * Processes a DNS query: refuses queries for blocked domains, or forwards them otherwise.
 */
export async function handleDnsQuery(
  query: Uint8Array,
  forward: (q: Uint8Array) => Promise<Uint8Array>,
  onLog?: (info: { name: string | null; blocked: boolean }) => void,
): Promise<Uint8Array> {
  const name = parseDnsQuestionName(query);
  const blocked = name !== null && isBlockedSandboxDomain(name);
  onLog?.({ name, blocked });
  if (blocked) {
    return makeDnsRefusedResponse(query);
  }
  return forward(query);
}
