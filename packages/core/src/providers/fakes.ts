import type {
  ChatProvider, ChatRequest, ChatResult, ProviderState, ProviderStateStore, SttProvider, SttResult, UsageDelta, UsageSink,
} from "./types";


/** Scripted chat provider: returns/throws queued items in order; records requests. */
export class FakeChatProvider implements ChatProvider {
  readonly requests: ChatRequest[] = [];
  constructor(private script: (ChatResult | Error | ((r: ChatRequest) => ChatResult))[]) {}
  async complete(req: ChatRequest): Promise<ChatResult> {
    this.requests.push(req);
    const next = this.script.length > 1 ? this.script.shift()! : this.script[0];
    if (!next) throw new Error("FakeChatProvider: empty script");
    if (next instanceof Error) throw next;
    return typeof next === "function" ? next(req) : next;
  }
}

export class FakeSttProvider implements SttProvider {
  readonly calls: { bytes: number; mime: string }[] = [];
  constructor(private script: (SttResult | Error)[]) {}
  async transcribe(audio: ArrayBuffer, mime: string): Promise<SttResult> {
    this.calls.push({ bytes: audio.byteLength, mime });
    const next = this.script.length > 1 ? this.script.shift()! : this.script[0];
    if (!next) throw new Error("FakeSttProvider: empty script");
    if (next instanceof Error) throw next;
    return next;
  }
}

export class InMemoryStateStore implements ProviderStateStore {
  readonly rows = new Map<string, ProviderState>();
  async get(id: string): Promise<ProviderState> {
    return this.rows.get(id) ?? { consecutiveFailures: 0, cooldownUntil: null };
  }
  async set(id: string, s: ProviderState): Promise<void> {
    this.rows.set(id, { ...s });
  }
}

export class InMemoryUsageSink implements UsageSink {
  readonly deltas: UsageDelta[] = [];
  async record(d: UsageDelta): Promise<void> {
    this.deltas.push(d);
  }
}

