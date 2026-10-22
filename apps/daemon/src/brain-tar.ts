// A minimal ustar writer: regular files only, no links, no devices, no absolute names. The snapshot
// travels as one of these over `machine run -i`, so it is built in memory (no temp folder on the host,
// no macOS AppleDouble extras) and can hold nothing but plain files by construction.

export interface TarFile {
  /** Relative, with `/` separators; the caller has checked it (isSafeSnapshotPath). */
  path: string;
  data: Uint8Array;
  /** Default 0o644; 0o755 for the shipped command. */
  mode?: number;
}

const block = 512;

function octal(n: number, width: number): string {
  return `${n.toString(8).padStart(width - 1, "0")}\0`;
}

function put(buf: Buffer, at: number, text: string, max: number): void {
  const b = Buffer.from(text, "utf8");
  if (b.length > max) throw new Error(`tar field too long: ${text}`);
  b.copy(buf, at);
}

/** Splits a path into ustar's name (at most 100 bytes) and prefix (at most 155), on a `/`. */
function splitName(path: string): { name: string; prefix: string } {
  if (Buffer.byteLength(path) <= 100) return { name: path, prefix: "" };
  for (let i = path.indexOf("/"); i !== -1; i = path.indexOf("/", i + 1)) {
    const prefix = path.slice(0, i);
    const name = path.slice(i + 1);
    if (Buffer.byteLength(name) <= 100 && Buffer.byteLength(prefix) <= 155) return { name, prefix };
  }
  throw new Error(`path too long for tar: ${path}`);
}

/** The archive for these files, in the order given, ending with the two empty blocks. */
export function tar(files: TarFile[], mtime = 0): Buffer {
  const parts: Buffer[] = [];
  for (const f of files) {
    if (f.path.startsWith("/") || f.path.split("/").includes("..") || f.path === "") {
      throw new Error(`not a safe tar path: ${f.path}`);
    }
    const { name, prefix } = splitName(f.path);
    const h = Buffer.alloc(block);
    put(h, 0, name, 100);
    put(h, 100, octal(f.mode ?? 0o644, 8), 8);
    put(h, 108, octal(0, 8), 8); // uid
    put(h, 116, octal(0, 8), 8); // gid
    put(h, 124, octal(f.data.length, 12), 12);
    put(h, 136, octal(mtime, 12), 12);
    h.fill(0x20, 148, 156); // the checksum counts itself as spaces
    h[156] = 0x30; // '0': a regular file
    put(h, 257, "ustar\0", 6);
    put(h, 263, "00", 2);
    put(h, 345, prefix, 155);
    let sum = 0;
    for (const b of h) sum += b;
    put(h, 148, `${sum.toString(8).padStart(6, "0")}\0 `, 8);
    parts.push(h, Buffer.from(f.data));
    const pad = (block - (f.data.length % block)) % block;
    if (pad) parts.push(Buffer.alloc(pad));
  }
  parts.push(Buffer.alloc(block * 2));
  return Buffer.concat(parts);
}
