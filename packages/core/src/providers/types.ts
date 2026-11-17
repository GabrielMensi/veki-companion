export type JsonSchema = Record<string, unknown>;

export type ToolCall = { id: string; name: string; arguments: Record<string, unknown> };

export type Msg =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string };

export type ToolDef = { name: string; description: string; parameters: JsonSchema };

export type ChatRequest = { system: string; messages: Msg[]; tools?: ToolDef[]; json?: JsonSchema };

export type Usage = { tokensIn: number; tokensOut: number; audioS?: number };

export type ChatResult = {
  text: string | null;
  /** Parsed `text` when `json` was requested. */
  json?: unknown;
  toolCalls: ToolCall[];
  usage: Usage;
};

export type SttResult = { text: string; lowConfidence: boolean; audioS?: number };

export interface SttProvider {
  transcribe(audio: ArrayBuffer, mime: string): Promise<SttResult>;
}
export interface ChatProvider {
  complete(req: ChatRequest): Promise<ChatResult>;
  /** Optional per-turn limits (from settings); `AgentDeps` values win when both are present. */
  agentLimits?(): Promise<{ maxLlmCalls?: number; historyLength?: number }>;
}

/** Circuit-breaker row (`provider_state`). Times are epoch milliseconds. */
export type ProviderState = { consecutiveFailures: number; cooldownUntil: number | null };

/** Storage-agnostic port; the D1 implementation lives elsewhere. */
export interface ProviderStateStore {
  get(providerModel: string): Promise<ProviderState>;
  set(providerModel: string, state: ProviderState): Promise<void>;
}

export type UsageDelta = { day: string; providerModel: string; requests: number; tokensIn: number; tokensOut: number; audioS: number; errors: number };

/** One UPSERT per call (`provider_usage`). */
export interface UsageSink {
  record(delta: UsageDelta): Promise<void>;
}

export type ChainEntry<P> = { id: string; provider: P };
