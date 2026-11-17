// Stub de la Bot API de Telegram para el simulador (sucesor del `transformer` de spikes/telegram/src/sim.ts).
// Registra cada método llamado y responde sin red. Cualquier llamada a otro host queda en `unexpected`.

export type BotApiError = { error_code: number; description: string };
export type BotApiCall = { method: string; payload: Record<string, unknown> };

const API_HOST = "api.telegram.org";

export interface StubBotApi {
  /** Métodos de la Bot API llamados, en orden. */
  calls: BotApiCall[];
  /** Hosts distintos de la Bot API a los que se intentó llegar: debe quedar vacío. */
  unexpected: string[];
  /** fetch falso; se puede usar directamente. */
  fetch: typeof fetch;
  /** Reemplaza `globalThis.fetch` por el stub; devuelve la función que lo restaura. */
  install(): () => void;
}

export function createStubBotApi(opts: { errors?: Record<string, BotApiError> } = {}): StubBotApi {
  const calls: BotApiCall[] = [];
  const unexpected: string[] = [];

  const stubFetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    if (url.hostname !== API_HOST) {
      unexpected.push(url.hostname);
      return new Response("unexpected host", { status: 599 });
    }

    // Descarga de archivos: /file/bot<token>/<ruta>
    if (/^\/file\/bot[^/]+\//.test(url.pathname)) {
      calls.push({ method: "downloadFile", payload: { path: url.pathname } });
      return new Response("fake-bytes", { status: 200 });
    }

    // Métodos: /bot<token>/<método>
    const method = /^\/bot[^/]+\/([^/]+)$/.exec(url.pathname)?.[1] ?? url.pathname;
    let payload: Record<string, unknown> = Object.fromEntries(url.searchParams);
    const raw = req.method === "POST" ? await req.text() : "";
    if (raw) {
      try {
        payload = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        payload = { raw };
      }
    }
    calls.push({ method, payload });

    const err = opts.errors?.[method];
    if (err) return Response.json({ ok: false, ...err }, { status: err.error_code });
    return Response.json({ ok: true, result: resultFor(method, payload) });
  }) as typeof fetch;

  return {
    calls,
    unexpected,
    fetch: stubFetch,
    install() {
      const real = globalThis.fetch;
      globalThis.fetch = stubFetch;
      return () => {
        globalThis.fetch = real;
      };
    },
  };
}

function resultFor(method: string, payload: Record<string, unknown>): unknown {
  switch (method) {
    case "getFile":
      return { file_id: payload.file_id, file_unique_id: "fake-unique", file_size: 1024, file_path: "fake/file.bin" };
    case "sendMessage":
      return { message_id: 1, date: 0, chat: { id: payload.chat_id, type: "private" }, text: payload.text };
    default:
      return true;
  }
}
