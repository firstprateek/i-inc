// Global test setup for @i-inc/web
// Suppress noisy happy-dom teardown AbortErrors and unhandled connection errors from unmocked relative fetches.
const safeString = (val: unknown): string => {
  if (val instanceof Error) return val.stack ?? val.message;
  if (typeof val === "string") return val;
  try {
    return JSON.stringify(val);
  } catch {
    return String(val);
  }
};

const isNoise = (val: unknown): boolean => {
  const str = safeString(val);
  return (
    str.includes("AbortError") ||
    str.includes("The operation was aborted") ||
    (str.includes("ECONNREFUSED") && str.includes("3000"))
  );
};

const origError = console.error;
console.error = (...args: unknown[]) => {
  if (args.some(isNoise)) return;
  origError.apply(console, args);
};

const origWrite = process.stderr.write;
(process.stderr.write as unknown) = (chunk: unknown, ...args: unknown[]) => {
  if (isNoise(chunk)) return true;
  return Reflect.apply(origWrite, process.stderr, [chunk, ...args]);
};

process.on("unhandledRejection", (reason: unknown) => {
  if (isNoise(reason)) return;
});
