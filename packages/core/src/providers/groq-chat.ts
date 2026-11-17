import { ProviderError, doFetch, readJson } from "./errors";
import type { ChatProvider, ChatRequest, ChatResult, Msg, ToolCall } from "./types";

const ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";

export type GroqChatOpts = { apiKey: string; model: string; temperature?: number; fetch?: typeof fetch };

function toWire(m: Msg): Record<string, unknown> {
  if (m.role === "user") return { role: "user", content: m.content };
  if (m.role === "tool") return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
  const out: Record<string, unknown> = { role: "assistant", content: m.content };
  if (m.toolCalls?.length) {
    out.tool_calls = m.toolCalls.map((t) => ({
      id: t.id, type: "function", function: { name: t.name, arguments: JSON.stringify(t.arguments) },
    }));
  }
  return out;
}

export class GroqChat implements ChatProvider {
  constructor(private o: GroqChatOpts) {}

  async complete(req: ChatRequest): Promise<ChatResult> {
    const label = `groq:${this.o.model}`;
    const body: Record<string, unknown> = {
      model: this.o.model,
      temperature: this.o.temperature ?? 0.3,
      messages: [{ role: "system", content: req.system }, ...req.messages.map(toWire)],
    };
    if (req.tools?.length) {
      body.tools = req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
    }
    if (req.json) {
      body.response_format = { type: "json_schema", json_schema: { name: "response", schema: req.json } };
    }
    const res = await doFetch(this.o.fetch ?? fetch, label, ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.o.apiKey}` },
      body: JSON.stringify(body),
    });
    const j = (await readJson(res, label)) as {
      choices?: { message?: { content?: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const msg = j.choices?.[0]?.message;
    if (!msg) throw new ProviderError("bad_output", `${label}: no choices in response`);

    const toolCalls: ToolCall[] = (msg.tool_calls ?? []).map((t) => {
      try {
        const args = JSON.parse(t.function.arguments || "{}");
        if (typeof args !== "object" || args === null || Array.isArray(args)) throw new Error("not an object");
        return { id: t.id, name: t.function.name, arguments: args as Record<string, unknown> };
      } catch {
        throw new ProviderError("bad_output", `${label}: invalid tool call arguments for ${t.function.name}`);
      }
    });
    const text = msg.content ?? null;
    const result: ChatResult = {
      text, toolCalls,
      usage: { tokensIn: j.usage?.prompt_tokens ?? 0, tokensOut: j.usage?.completion_tokens ?? 0 },
    };
    if (req.json && toolCalls.length === 0) {
      try {
        result.json = JSON.parse(text ?? "");
      } catch {
        throw new ProviderError("bad_output", `${label}: output is not valid JSON`);
      }
    }
    if (text === null && toolCalls.length === 0) throw new ProviderError("bad_output", `${label}: empty output`);
    return result;
  }
}
