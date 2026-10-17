// Ollama integration: HelperModel and ChatSession talking to local Ollama.
import type { ChatSession, Employee, Engine, HelperModel, SessionOutcome, Ticket } from "@i-inc/core";

export interface OllamaOptions {
  baseUrl?: string;
  model?: string;
  fetch?: typeof fetch;
}

export function fallbackHeuristic(question: string, text: string): boolean {
  const t = text.trim().toLowerCase();
  if (question.includes("new work") || question.toLowerCase().includes("work")) {
    return /^(please )?(add|also|fix|make|build|find|book|draft|write|create|update)\b/.test(t);
  }
  return /\b(this|it|that)\b/.test(t) && !t.endsWith("?");
}

export function fallbackClassify(
  message: string,
  ctx?: { current?: Ticket | null },
): { intent: "ask" | "note" | "question"; answer: boolean } {
  const t = message.trim().toLowerCase();
  const isAsk = /^(please )?(add|also|fix|make|build|find|book|draft|write|create|update)\b/.test(t);
  if (isAsk) return { intent: "ask", answer: true };
  const isNote = !!ctx?.current && /\b(this|it|that)\b/.test(t) && !t.endsWith("?");
  if (isNote) return { intent: "note", answer: false };
  return { intent: "question", answer: false };
}

class OllamaClient {
  readonly baseUrl: string;
  readonly model: string;
  protected readonly fetchFn: typeof fetch;

  constructor(opts: OllamaOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? process.env.I_INC_OLLAMA ?? "http://127.0.0.1:11434").replace(/\/+$/, "");
    this.model = opts.model ?? process.env.I_INC_OLLAMA_MODEL ?? "qwen3:8b";
    this.fetchFn = opts.fetch ?? globalThis.fetch;
  }

  protected async generate(prompt: string, format?: "json"): Promise<string> {
    const res = await this.fetchFn(`${this.baseUrl}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        prompt,
        stream: false,
        think: false,
        options: { think: false },
        ...(format ? { format } : {}),
      }),
    });
    if (!res.ok) {
      throw new Error(`Ollama returned status ${res.status}`);
    }
    const data = (await res.json()) as { response?: string; message?: { content?: string } };
    return data.response ?? data.message?.content ?? "";
  }
}

/**
 * A fast local helper model using Ollama. Used to classify intents and answer yes/no questions.
 */
export class OllamaHelper extends OllamaClient implements HelperModel {
  async yesNo(question: string, text: string): Promise<boolean> {
    try {
      const prompt = [
        "Answer the following question about the given text.",
        `Question: ${question}`,
        `Text: "${text}"`,
        'Reply ONLY with JSON: {"answer": true} or {"answer": false}',
      ].join("\n");

      const res = await this.generate(prompt, "json");
      const cleaned = res
        .replace(/```json/gi, "")
        .replace(/```/g, "")
        .trim();
      const parsed = JSON.parse(cleaned) as { answer?: unknown };
      if (typeof parsed.answer === "boolean") return parsed.answer;
      if (typeof parsed.answer === "string") {
        const val = parsed.answer.toLowerCase();
        if (val === "true" || val === "yes") return true;
        if (val === "false" || val === "no") return false;
      }
    } catch {
      // Safe deterministic fallback
    }
    return fallbackHeuristic(question, text);
  }

  async classifyIntent(
    message: string,
    ctx?: { current?: Ticket | null },
  ): Promise<{ intent: "ask" | "note" | "question"; answer: boolean }> {
    try {
      const prompt = [
        "Classify the owner's message in this 1:1 chat into one intent.",
        ctx?.current
          ? `Current work in progress: #${ctx.current.id} ${ctx.current.title}.`
          : "No work currently in progress.",
        "Possible intents:",
        '- "ask": asking for new work, a feature, a bug fix, or a task to be created.',
        '- "note": a note, feedback, or instruction about the work already in progress.',
        '- "question": asking a question or general conversation.',
        `Message: "${message}"`,
        'Reply ONLY with JSON: {"intent": "ask" | "note" | "question"}',
      ].join("\n");

      const res = await this.generate(prompt, "json");
      const cleaned = res
        .replace(/```json/gi, "")
        .replace(/```/g, "")
        .trim();
      const parsed = JSON.parse(cleaned) as { intent?: string };
      const intent = parsed.intent?.toLowerCase();
      if (intent === "ask" || intent === "work") {
        return { intent: "ask", answer: true };
      }
      if (intent === "note") {
        return { intent: "note", answer: false };
      }
      if (intent === "question") {
        return { intent: "question", answer: false };
      }
    } catch {
      // Safe deterministic fallback
    }
    return fallbackClassify(message, ctx);
  }
}

/**
 * A chat session with an employee running on local Ollama.
 */
export class OllamaChat extends OllamaClient implements ChatSession {
  async answer(request: { employee: Employee; engine: Engine; brief: string }): Promise<SessionOutcome> {
    try {
      const text = await this.generate(request.brief);
      if (text.trim()) return { kind: "done", output: text.trim() };
    } catch {
      // Gracefully fall back if Ollama is unreachable
    }
    return { kind: "done", output: `${request.employee.name}: here's what I know.` };
  }

  async reply(
    message: string,
    ctx: { employee: Employee; current?: Ticket | null; notes?: string; engine?: Engine },
  ): Promise<string> {
    const brief = [
      `You are ${ctx.employee.name}, ${ctx.employee.role}. The owner asks you a question in chat.`,
      "Answer briefly from what you know about your work. Don't start any work.",
      ctx.current ? `You are working on #${ctx.current.id} ${ctx.current.title}.` : "",
      ctx.notes ? `Your recent notes:\n${ctx.notes}` : "",
      `Question: ${message}`,
    ]
      .filter(Boolean)
      .join("\n");

    try {
      const text = await this.generate(brief);
      if (text.trim()) return text.trim();
    } catch {
      // Gracefully fall back if Ollama is unreachable
    }
    return `${ctx.employee.name}: here's what I know.`;
  }
}
