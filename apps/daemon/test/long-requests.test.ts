// Which requests main.ts lets run past Bun's idle timeout: the owner's long actions, and nothing else.
import { describe, expect, it } from "vitest";
import { isLongRequest, LONG_REQUEST_SEC } from "../src/long-requests.ts";

describe("the long owner actions", () => {
  const table: [string, string, boolean][] = [
    ["GET", "/api/conversations/c1/ship?preview=1", true],
    ["GET", "/api/conversations/c1/ship?x=2&preview=1", true],
    ["POST", "/api/conversations/c1/ticket", true],
    ["POST", "/api/conversations/c1/pr", true],
    ["POST", "/api/conversations/c1/take-back", true],
    ["POST", "/api/conversations", true],
    // the 30 s ship poll and the rest of the chat's traffic keep the server's idle timeout
    ["GET", "/api/conversations/c1/ship", false],
    ["GET", "/api/conversations/c1/ship?preview=0", false],
    ["GET", "/api/conversations", false],
    ["GET", "/api/conversations/c1", false],
    ["GET", "/api/conversations/c1/ticket", false],
    ["POST", "/api/conversations/c1/ship?preview=1", false],
    ["PATCH", "/api/conversations/c1", false],
    ["DELETE", "/api/conversations/c1/pr", false],
    ["POST", "/api/conversations/c1/pr/x", false],
    ["POST", "/api/conversations//ticket", false],
    ["POST", "/api/conversations/a/b/ticket", false],
    ["POST", "/api/tickets", false],
    ["GET", "/api/events", false],
  ];
  for (const [method, path, long] of table) {
    it(`${method} ${path}: ${long ? "long" : "not long"}`, () => {
      expect(isLongRequest(method, new URL(`http://127.0.0.1:7420${path}`))).toBe(long);
    });
  }

  it("asks for the longest wait Bun allows", () => {
    expect(LONG_REQUEST_SEC).toBe(255);
  });
});
