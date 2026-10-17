import { defaultSwitchRules, type Employee, type Engine, type Ticket } from "@i-inc/core";
import { describe, expect, it, vi } from "vitest";
import { OllamaChat, OllamaHelper } from "../src/ollama.ts";

const ada: Employee = {
  id: "ada",
  name: "Ada",
  role: "Senior Engineer",
  duties: ["build", "review"],
  engines: { default: "claude", fallbacks: [] },
  switchRules: defaultSwitchRules,
};

const engine: Engine = {
  id: "qwen",
  harness: "opencode",
  model: "qwen3:8b",
  accountId: "local",
  local: true,
};

const ticket: Ticket = {
  id: "42",
  title: "Add retry button",
  project: "Duet",
  type: "feat",
  effort: "low",
  doneWhen: ["retry button works"],
  assignee: "ada",
};

interface GeneratePayload {
  model?: string;
  prompt?: string;
  stream?: boolean;
  think?: boolean;
  options?: { think?: boolean };
  format?: string;
}

describe("OllamaHelper", () => {
  it("classifies intent using Ollama with fast options", async () => {
    let capturedUrl = "";
    let capturedBody: GeneratePayload | undefined;

    const mockFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ response: '{"intent": "ask"}' }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const helper = new OllamaHelper({
      baseUrl: "http://127.0.0.1:11434/",
      model: "qwen3:8b",
      fetch: mockFetch as unknown as typeof fetch,
    });

    const result = await helper.classifyIntent("Add a new button", { current: ticket });
    expect(capturedUrl).toBe("http://127.0.0.1:11434/api/generate");
    expect(capturedBody).toMatchObject({
      model: "qwen3:8b",
      stream: false,
      think: false,
      options: { think: false },
      format: "json",
    });
    expect(result).toEqual({ intent: "ask", answer: true });
  });

  it("classifies note and question intents from Ollama JSON", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ response: '```json\n{"intent": "note"}\n```' }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ response: '{"intent": "question"}' }), { status: 200 }),
      );

    const helper = new OllamaHelper({ fetch: mockFetch as unknown as typeof fetch });

    const noteResult = await helper.classifyIntent("Change this to red", { current: ticket });
    expect(noteResult).toEqual({ intent: "note", answer: false });

    const questionResult = await helper.classifyIntent("How does auth work?");
    expect(questionResult).toEqual({ intent: "question", answer: false });
  });

  it("safely falls back to deterministic heuristics when Ollama is unreachable or errors", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("Connection refused"));
    const helper = new OllamaHelper({ fetch: mockFetch as unknown as typeof fetch });

    // New work heuristic (imperatives like add, fix, build...)
    const askFallback = await helper.classifyIntent("Please add a retry button", { current: ticket });
    expect(askFallback).toEqual({ intent: "ask", answer: true });

    // Note heuristic (mentions this/it/that without a question mark, given current ticket)
    const noteFallback = await helper.classifyIntent("fix this now", { current: ticket });
    expect(noteFallback).toEqual({ intent: "ask", answer: true }); // "fix" matches ask first

    const actualNote = await helper.classifyIntent("Make this blue", { current: ticket });
    expect(actualNote).toEqual({ intent: "ask", answer: true }); // "make" is an imperative ask

    const noteOnly = await helper.classifyIntent("Remember that for later", { current: ticket });
    expect(noteOnly).toEqual({ intent: "note", answer: false });

    // Question fallback
    const questionFallback = await helper.classifyIntent("How does this work?", { current: ticket });
    expect(questionFallback).toEqual({ intent: "question", answer: false });
  });

  it("safely falls back when Ollama returns unparseable output", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("Internal Server Error", { status: 500 }));
    const helper = new OllamaHelper({ fetch: mockFetch as unknown as typeof fetch });

    const res = await helper.classifyIntent("Please create a test");
    expect(res).toEqual({ intent: "ask", answer: true });
  });

  it("answers yesNo questions and falls back when unreachable", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ response: '{"answer": true}' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ response: '{"answer": false}' }), { status: 200 }))
      .mockRejectedValueOnce(new Error("network failure"));

    const helper = new OllamaHelper({ fetch: mockFetch as unknown as typeof fetch });

    expect(await helper.yesNo("Is this work?", "Add a button")).toBe(true);
    expect(await helper.yesNo("Is this work?", "How are you?")).toBe(false);

    // Fallback: heuristic for "new work"
    expect(await helper.yesNo("Is this asking for new work?", "Please build the login page")).toBe(true);
    expect(await helper.yesNo("Is this asking for new work?", "What time is it?")).toBe(false);
  });
});

describe("OllamaChat", () => {
  it("replies in character as the employee given current ticket and notes", async () => {
    let capturedBody: GeneratePayload | undefined;
    const mockFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ response: "Ada: I am making good progress on ticket #42." }), {
        status: 200,
      });
    });

    const chat = new OllamaChat({ fetch: mockFetch as unknown as typeof fetch });
    const reply = await chat.reply("How is it going?", {
      employee: ada,
      current: ticket,
      notes: "#41 done; #42 running",
    });

    expect(capturedBody).toBeDefined();
    expect(capturedBody?.prompt).toContain("You are Ada, Senior Engineer.");
    expect(capturedBody?.prompt).toContain("Question: How is it going?");
    expect(capturedBody?.prompt).toContain("#42 Add retry button");
    expect(capturedBody?.prompt).toContain("Your recent notes:\n#41 done; #42 running");
    expect(capturedBody?.stream).toBe(false);
    expect(capturedBody?.think).toBe(false);
    expect(reply).toBe("Ada: I am making good progress on ticket #42.");
  });

  it("falls back gracefully when Ollama is unreachable in reply and answer", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("connection refused"));
    const chat = new OllamaChat({ fetch: mockFetch as unknown as typeof fetch });

    const reply = await chat.reply("What is your status?", { employee: ada, current: ticket });
    expect(reply).toBe("Ada: here's what I know.");

    const outcome = await chat.answer({
      employee: ada,
      engine,
      brief: "Brief info",
    });
    expect(outcome).toEqual({ kind: "done", output: "Ada: here's what I know." });
  });

  it("handles successful answer call", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ response: "Here is the answer to your brief." }), { status: 200 }),
      );
    const chat = new OllamaChat({ fetch: mockFetch as unknown as typeof fetch });
    const outcome = await chat.answer({
      employee: ada,
      engine,
      brief: "Answer this question",
    });
    expect(outcome).toEqual({ kind: "done", output: "Here is the answer to your brief." });
  });
});
