import { copy, type SttProvider } from "@veki/core";
import { runTurn, type TurnDeps, type TurnReply } from "./text";

export type DownloadedAudio = { bytes: ArrayBuffer; mime: string };
export type AudioDownloader = (fileId: string) => Promise<DownloadedAudio>;

export type VoiceDeps = TurnDeps & { stt: SttProvider; download: AudioDownloader };

/** `getFile` + descarga desde Telegram. El audio vive solo en memoria: nunca se guarda. */
export function telegramDownloader(botToken: string, fetchFn: typeof fetch = fetch): AudioDownloader {
  return async (fileId) => {
    const meta = await fetchFn(`https://api.telegram.org/bot${botToken}/getFile?file_id=${encodeURIComponent(fileId)}`);
    const body = (await meta.json()) as { ok?: boolean; result?: { file_path?: string } };
    const path = body.result?.file_path;
    if (!meta.ok || !body.ok || !path) throw new Error("telegram getFile failed");
    const file = await fetchFn(`https://api.telegram.org/file/bot${botToken}/${path}`);
    if (!file.ok) throw new Error("telegram file download failed");
    return { bytes: await file.arrayBuffer(), mime: file.headers.get("content-type") ?? "audio/ogg" };
  };
}

/** Nota de voz: descarga → STT → mismo flujo que el texto. Si no se puede escuchar, texto fijo. */
export async function handleVoice(
  deps: VoiceDeps,
  input: { chatId: number; fileId: string; mime?: string },
): Promise<TurnReply> {
  let transcript: { text: string; lowConfidence: boolean };
  try {
    const audio = await deps.download(input.fileId);
    transcript = await deps.stt.transcribe(audio.bytes, input.mime ?? audio.mime);
  } catch {
    return { texto: copy.noPudeEscuchar, escalate: false, misunderstood: false };
  }
  if (!transcript.text.trim()) return { texto: copy.noPudeEscuchar, escalate: false, misunderstood: false };
  return runTurn(deps, { chatId: input.chatId, text: transcript.text.trim(), lowConfidenceVoice: transcript.lowConfidence });
}
