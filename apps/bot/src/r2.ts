import { ulid } from "@veki/core";

/** Forma mínima del bucket R2 que usamos (no dependemos de @cloudflare/workers-types). */
export interface R2Like {
  put(key: string, value: ArrayBuffer | ArrayBufferView | string, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  delete(key: string): Promise<void>;
}

/** Clave de R2 para un original: `orig/YYYY/MM/<id>.<ext>` (UTC, docs/02 §2.2). */
export function mediaKey(id: string, ext: string, now: number = Date.now()): string {
  const d = new Date(now);
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `orig/${d.getUTCFullYear()}/${mm}/${id}.${ext.replace(/[^a-z0-9]/gi, "").toLowerCase() || "bin"}`;
}

export function newMediaId(now: number = Date.now()): string {
  return ulid(now);
}

export async function putOriginal(bucket: R2Like, key: string, bytes: ArrayBuffer, mime: string): Promise<void> {
  await bucket.put(key, bytes, { httpMetadata: { contentType: mime } });
}
