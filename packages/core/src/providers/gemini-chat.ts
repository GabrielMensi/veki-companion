import { ProviderError, doFetch, readJson } from "./errors";
import type { ChatProvider, ChatRequest, ChatResult, Msg, ToolCall } from "./types";

export type GeminiChatOpts = { apiKey: string; model: string; temperature?: number; fetch?: typeof fetch };

type Part = Record<string, unknown>;

function toContent(m: Msg): { role: string; parts: Part[] } {
  if (m.role === "user") return { role: "user", parts: [{ text: m.content }] };
  if (m.role === "tool") {
    let response: unknown;
    try { response = JSON.parse(m.content); } catch { response = { result: m.content }; }
    if (typeof response !== "object" || response === null || Array.isArray(response)) response = { result: response };
    return { role: "user", parts: [{ functionResponse: { name: m.name, response } }] };
  }
  const parts: Part[] = [];
  if (m.content) parts.push({ text: m.content });
  for (const t of m.toolCalls ?? []) parts.push({ functionCall: { name: t.name, args: t.arguments } });
  return { role: "model", parts };
}

/** Backup chat provider. Disabled by default (Q5): it would send the chat to Gemini free tier. */
export class GeminiChat implements ChatProvider {
  constructor(private o: GeminiChatOpts) {}

  async complete(req: ChatRequest): Promise<ChatResult> {
    const label = `gemini:${this.o.model}`;
    const body: Record<string, unknown> = {
      systemInstruction: { parts: [{ text: req.system }] },
      contents: req.messages.map(toContent),
      generationConfig: { temperature: this.o.temperature ?? 0.3 },
    };
    if (req.tools?.length) {
      body.tools = [{ functionDeclarations: req.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })) }];
    }
    if (req.json) {
      body.generationConfig = { ...(body.generationConfig as object), responseMimeType: "application/json", responseJsonSchema: req.json };
    }
    const res = await doFetch(
      this.o.fetch ?? fetch, label,
      `https://generativelanguage.googleapis.com/v1beta/models/${this.o.model}:generateContent`,
      { method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": this.o.apiKey }, body: JSON.stringify(body) },
    );
    const j = (await readJson(res, label)) as {
      candidates?: { content?: { parts?: Part[] } }[];
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    };
    const parts = j.candidates?.[0]?.content?.parts;
    if (!parts) throw new ProviderError("bad_output", `${label}: no candidates in response`);
    const text = parts.filter((p) => typeof p.text === "string" && !p.thought).map((p) => p.text as string).join("");
    const toolCalls: ToolCall[] = parts
      .filter((p) => p.functionCall)
      .map((p, i) => {
        const fc = p.functionCall as { name: string; args?: Record<string, unknown> };
        return { id: `${fc.name}-${i}`, name: fc.name, arguments: fc.args ?? {} };
      });
    const result: ChatResult = {
      text: text || null, toolCalls,
      usage: { tokensIn: j.usageMetadata?.promptTokenCount ?? 0, tokensOut: j.usageMetadata?.candidatesTokenCount ?? 0 },
    };
    if (req.json && toolCalls.length === 0) {
      try {
        result.json = JSON.parse(text);
      } catch {
        throw new ProviderError("bad_output", `${label}: output is not valid JSON`);
      }
    }
    if (!text && toolCalls.length === 0) throw new ProviderError("bad_output", `${label}: empty output`);
    return result;
  }
}
