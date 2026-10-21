// Image sniffing shared by the REST API (ticket and chat uploads) and the AHP host (prompt attachments).

/** The image types we take, told by their leading bytes. No SVG: it can carry script. */
export function sniffImage(b: Uint8Array): string | null {
  const starts = (sig: number[], at = 0) => sig.every((x, i) => b[at + i] === x);
  const ascii = (t: string) => [...t].map((c) => c.charCodeAt(0));
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (starts([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (starts(ascii("GIF87a")) || starts(ascii("GIF89a"))) return "image/gif";
  if (starts(ascii("RIFF")) && starts(ascii("WEBP"), 8)) return "image/webp";
  return null;
}
