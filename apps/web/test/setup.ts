// Global test setup for @i-inc/web
// Suppress noisy happy-dom teardown AbortErrors and unhandled connection errors from unmocked relative fetches.
const isNoise = (val: unknown): boolean => {
  const str =
    val instanceof Error ? (val.stack ?? val.message) : typeof val === "string" ? val : JSON.stringify(val);
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
  return (origWrite as Function).apply(process.stderr, [chunk, ...args]);
};

process.on("unhandledRejection", (reason: unknown) => {
  if (isNoise(reason)) return;
});
