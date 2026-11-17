import { ProviderError, doFetch, readJson } from "./errors";
import type { SttProvider, SttResult } from "./types";

export type WorkersAiSttOpts = { accountId: string; apiToken: string; model: string; fetch?: typeof fetch };

/** Backup STT over the Workers AI REST API (raw audio bytes as body). */
export class WorkersAiStt implements SttProvider {
  constructor(private o: WorkersAiSttOpts) {}

  async transcribe(audio: ArrayBuffer, mime: string): Promise<SttResult> {
    const label = `workersai:${this.o.model}`;
    const res = await doFetch(
      this.o.fetch ?? fetch, label,
      `https://api.cloudflare.com/client/v4/accounts/${this.o.accountId}/ai/run/${this.o.model}`,
      { method: "POST", headers: { authorization: `Bearer ${this.o.apiToken}`, "content-type": mime }, body: audio },
    );
    const j = (await readJson(res, label)) as { result?: { text?: unknown } };
    if (typeof j.result?.text !== "string") throw new ProviderError("bad_output", `${label}: missing text`);
    const text = j.result.text.trim();
    // This endpoint exposes no confidence; treat it as unverified.
    return { text, lowConfidence: text === "" };
  }
}
