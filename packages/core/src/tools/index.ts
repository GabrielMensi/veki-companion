import { copy, formatPrecio } from "../copy/es-AR";
import type { Draft } from "../agent/draft";
import { nextMissingField } from "../agent/draft";
import { toolKinds, toolSchemas, type ToolName } from "./defs";

export * from "./defs";

export type PendingActionInput = {
  chatId: number;
  tool: ToolName;
  /** Argumentos ya validados; para `crear_producto` es `{ draft }` con el borrador completo. */
  args: Record<string, unknown>;
  /** Vista previa en texto fijo (la mostrará T18 con los botones Sí / Cambiar / Cancelar). */
  preview: string;
  /** Acción anterior que queda `cancelled` (flujo "Cambiar"). */
  supersedes?: string;
};

/** Puerto con el que el agente toca el mundo. T18 implementa `createPendingAction`; T19 las lecturas. */
export interface ToolHost {
  createPendingAction(input: PendingActionInput): Promise<{ id: string }>;
  /** Lecturas (`buscar_productos`, `ver_producto`, `ver_agenda`, `ver_contenido`). Devuelven texto/JSON corto. */
  read?(name: ToolName, args: Record<string, unknown>): Promise<unknown>;
}

export type ToolOutcome =
  | { kind: "error"; message: string }
  | { kind: "result"; content: string }
  | { kind: "pending"; actionId: string; preview: string };

const draftLine = (d: Draft) => {
  const c = d.campos;
  return d.tipo === "producto"
    ? [
        "Te queda así 👇",
        `🧵 ${c.name} — ${formatPrecio(c.price_ars)}`,
        `Categoría: ${c.category}${c.description ? ` · ${c.description}` : ""}`,
        `Fotos: ${d.media_ids.length} (portada: la primera)`,
      ]
    : [
        "Te queda así 👇",
        `📅 ${c.name} — ${c.place}${c.address ? ` (${c.address})` : ""}`,
        `Desde ${c.starts_at} hasta ${c.ends_at}`,
      ];
};

/** Vista previa fija de una escritura (no la inventa el LLM). */
export function previewFor(tool: ToolName, args: Record<string, unknown>, draft: Draft | null): string {
  if (tool === "crear_producto" && draft) return draftLine(draft).join("\n");
  const resumen = Object.entries(args)
    .map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
    .join(" · ");
  return `Voy a hacer esto 👇\n${tool.replace(/_/g, " ")}${resumen ? ` — ${resumen}` : ""}`;
}

/**
 * Ejecuta una herramienta que NO es `responder` ni `actualizar_borrador` (esas las maneja el ciclo, porque
 * tocan el estado y la salida). Las de escritura nunca escriben: crean una `pending_action`.
 */
export async function runTool(
  host: ToolHost,
  ctx: { chatId: number; draft: Draft | null; awaitingActionId?: string },
  name: ToolName,
  rawArgs: unknown,
): Promise<ToolOutcome> {
  const parsed = toolSchemas[name].safeParse(rawArgs ?? {});
  if (!parsed.success) {
    return { kind: "error", message: `Argumentos inválidos: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}` };
  }
  const args = parsed.data as Record<string, unknown>;
  const kind = toolKinds[name];

  if (kind === "read") {
    if (!host.read) return { kind: "error", message: "Esa consulta todavía no está disponible." };
    const out = await host.read(name, args);
    return { kind: "result", content: typeof out === "string" ? out : JSON.stringify(out) };
  }

  if (kind === "write") {
    let toStore = args;
    if (name === "crear_producto") {
      if (!ctx.draft || ctx.draft.tipo !== "producto") return { kind: "error", message: "No hay borrador de producto. Usá actualizar_borrador primero." };
      const missing = nextMissingField(ctx.draft);
      if (missing) return { kind: "error", message: `Falta ${missing}: preguntale ${copy.campoFaltante[missing]}.` };
      toStore = { draft: ctx.draft };
    }
    const preview = previewFor(name, args, ctx.draft);
    const { id } = await host.createPendingAction({
      chatId: ctx.chatId,
      tool: name,
      args: toStore,
      preview,
      supersedes: ctx.awaitingActionId,
    });
    return { kind: "pending", actionId: id, preview };
  }

  return { kind: "error", message: "Herramienta no disponible." };
}
