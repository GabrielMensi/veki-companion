import { ProviderError, doFetch, readJson } from "./errors";
import type { SttProvider, SttResult } from "./types";

const ENDPOINT = "https://api.groq.com/openai/v1/audio/transcriptions";
const DEFAULT_PROMPT = "neceser, mantel, cartuchera, tela, bordado, feria, puesto";

export type GroqSttOpts = { apiKey: string; model: string; prompt?: string; fetch?: typeof fetch };

export class GroqStt implements SttProvider {
  constructor(private o: GroqSttOpts) {}

  async transcribe(audio: ArrayBuffer, mime: string): Promise<SttResult> {
    const label = `groq:${this.o.model}`;
    const form = new FormData();
    form.append("file", new Blob([audio], { type: mime }), mime.includes("ogg") ? "audio.ogg" : "audio");
    form.append("model", this.o.model);
    form.append("language", "es");
    form.append("temperature", "0");
    form.append("response_format", "verbose_json");
    form.append("prompt", this.o.prompt ?? DEFAULT_PROMPT);
    const res = await doFetch(this.o.fetch ?? fetch, label, ENDPOINT, {
      method: "POST", headers: { authorization: `Bearer ${this.o.apiKey}` }, body: form,
    });
    const j = (await readJson(res, label)) as {
      text?: unknown; duration?: number; segments?: { avg_logprob?: number; no_speech_prob?: number }[];
    };
    if (typeof j.text !== "string") throw new ProviderError("bad_output", `${label}: missing text`);
    const text = j.text.trim();
    const segs = j.segments ?? [];
    const lowConfidence = text === "" || segs.some((s) => (s.avg_logprob ?? 0) < -1 || (s.no_speech_prob ?? 0) > 0.6);
    return { text, lowConfidence, audioS: j.duration };
  }
}
