import { copyAcciones, toolSchemas, type PendingActionRow, type ToolName } from "@veki/core";
import type { D1DatabaseLike, D1PreparedStatementLike } from "../env";
import type { LogActor } from "./pending";
import { lastUndoableId, undoAction, type Op } from "./undo";

/** Error "esperable" (la usuaria pidió algo imposible): se cancela la acción y se le avisa con `userMessage`. */
export class ActionError extends Error {
  constructor(readonly userMessage: string) {
    super(userMessage);
    this.name = "ActionError";
  }
}

export type ExecCtx = {
  db: D1DatabaseLike;
  action: PendingActionRow;
  /** `args` guardados (JSON ya parseado). Cada ejecutor valida lo que necesita. */
  args: unknown;
  now: number;
  actor: LogActor;
};

/**
 * Resultado de un ejecutor: `statements` se aplican junto con el `inverse` y el `event_log` en un solo batch.
 * Los ejecutores leen (instantánea previa) pero NO escriben fuera de `statements`.
 */
export type ExecResult = {
  statements: D1PreparedStatementLike[];
  /** Cómo deshacerlo (instantáneas de las filas tocadas). Obligatorio, aunque sea `[]`. */
  inverse: Op[];
  message: string;
  /** Cambia algo que se ve en el sitio → marca `site_state.dirty_since`. */
  public: boolean;
  entity?: string;
  entityId?: string;
  /** Ya registró su propio `event_log`/`dirty_since` (lo hace `deshacer`). */
  selfLogged?: boolean;
};

export type Executor = (ctx: ExecCtx) => Promise<ExecResult>;
export type ExecutorMap = Partial<Record<ToolName, Executor>>;

type Row = Record<string, unknown>;

async function snapshot(db: D1DatabaseLike, table: "products" | "variants" | "fairs", id: string): Promise<Row | null> {
  return db.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(id).first<Row>();
}

/** "2026-12-05T10:00" o "2026-12-05" en hora de Argentina (UTC-3, sin horario de verano) → ms UTC. */
export function arToMs(s: string, endOfDay = false): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/.exec(s);
  if (!m) throw new ActionError(copyAcciones.fechasMal);
  const [, y, mo, d, h, mi] = m;
  const hasTime = h !== undefined;
  const hh = hasTime ? Number(h) : endOfDay ? 23 : 0;
  const mm = hasTime ? Number(mi) : endOfDay ? 59 : 0;
  return Date.UTC(Number(y), Number(mo) - 1, Number(d), hh + 3, mm);
}

/** Armado de `UPDATE <table> SET a=?, b=? ... WHERE id=?` solo con las columnas dadas. */
function updateStmt(db: D1DatabaseLike, table: string, id: string, set: Row): D1PreparedStatementLike {
  const cols = Object.keys(set);
  return db
    .prepare(`UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`)
    .bind(...cols.map((c) => set[c]), id);
}

const parse = <N extends ToolName>(name: N, args: unknown) => {
  const r = toolSchemas[name].safeParse(args);
  if (!r.success) throw new ActionError(copyAcciones.faltaCambio);
  return r.data as import("zod").infer<(typeof toolSchemas)[N]>;
};

const editarProducto: Executor = async ({ db, args, now }) => {
  const a = parse("editar_producto", args);
  if (!a.producto_id) throw new ActionError(copyAcciones.noEncontre);
  const prev = await snapshot(db, "products", a.producto_id);
  if (!prev) throw new ActionError(copyAcciones.noEncontre);
  const set: Row = { ...a.cambios };
  if (Object.keys(set).length === 0) throw new ActionError(copyAcciones.faltaCambio);
  set.updated_at = now;
  return {
    statements: [updateStmt(db, "products", a.producto_id, set)],
    inverse: [{ op: "upsert", table: "products", row: prev }],
    message: copyAcciones.productoEditado(String(a.cambios.name ?? prev.name)),
    public: true,
    entity: "product",
    entityId: a.producto_id,
  };
};

const cambiarStock: Executor = async ({ db, args, now }) => {
  const a = parse("cambiar_stock", args);
  if (!a.variante_id) throw new ActionError(copyAcciones.noEncontre);
  const prev = await snapshot(db, "variants", a.variante_id);
  if (!prev) throw new ActionError(copyAcciones.noEncontre);
  let next: number;
  if (a.fijar !== undefined) next = a.fijar;
  else if (a.delta !== undefined) {
    if (prev.stock === null || prev.stock === undefined) throw new ActionError(copyAcciones.stockDesconocido);
    next = (prev.stock as number) + a.delta;
    if (next < 0) throw new ActionError(copyAcciones.stockNegativo);
  } else throw new ActionError(copyAcciones.faltaCambio);
  const product = await snapshot(db, "products", String(prev.product_id));
  return {
    statements: [updateStmt(db, "variants", a.variante_id, { stock: next, updated_at: now })],
    inverse: [{ op: "upsert", table: "variants", row: prev }],
    message: copyAcciones.stockActualizado(String(product?.name ?? "eso"), next),
    public: true, // la web muestra disponibilidad (docs/02 §5.1)
    entity: "variant",
    entityId: a.variante_id,
  };
};

const crearFeria: Executor = async ({ db, args, now, action }) => {
  const a = parse("crear_feria", args);
  const starts = arToMs(a.inicio);
  const ends = arToMs(a.fin, true);
  if (ends < starts) throw new ActionError(copyAcciones.fechasMal);
  // Id derivado de la acción (se fija al crearla, docs/02 §3.1.6): un reintento no puede duplicar la feria.
  const id = action.id;
  return {
    statements: [
      db
        .prepare(
          "INSERT INTO fairs (id, name, place, address, starts_at, ends_at, status, public, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'confirmed', 1, ?, ?)",
        )
        .bind(id, a.nombre, a.lugar, a.direccion ?? null, starts, ends, now, now),
    ],
    inverse: [{ op: "delete", table: "fairs", id }],
    message: copyAcciones.feriaCreada(a.nombre),
    public: true,
    entity: "fair",
    entityId: id,
  };
};

const editarFeria: Executor = async ({ db, args, now }) => {
  const a = parse("editar_feria", args);
  const prev = await snapshot(db, "fairs", a.feria_id);
  if (!prev) throw new ActionError(copyAcciones.noEncontre);
  const c = a.cambios;
  const set: Row = {};
  if (c.nombre !== undefined) set.name = c.nombre;
  if (c.lugar !== undefined) set.place = c.lugar;
  if (c.direccion !== undefined) set.address = c.direccion;
  if (c.inicio !== undefined) set.starts_at = arToMs(c.inicio);
  if (c.fin !== undefined) set.ends_at = arToMs(c.fin, true);
  if (Object.keys(set).length === 0) throw new ActionError(copyAcciones.faltaCambio);
  if (((set.ends_at ?? prev.ends_at) as number) < ((set.starts_at ?? prev.starts_at) as number)) throw new ActionError(copyAcciones.fechasMal);
  set.updated_at = now;
  return {
    statements: [updateStmt(db, "fairs", a.feria_id, set)],
    inverse: [{ op: "upsert", table: "fairs", row: prev }],
    message: copyAcciones.feriaEditada(String(set.name ?? prev.name)),
    public: true,
    entity: "fair",
    entityId: a.feria_id,
  };
};

const cancelarFeria: Executor = async ({ db, args, now }) => {
  const a = parse("cancelar_feria", args);
  const prev = await snapshot(db, "fairs", a.feria_id);
  if (!prev) throw new ActionError(copyAcciones.noEncontre);
  return {
    statements: [updateStmt(db, "fairs", a.feria_id, { status: "cancelled", updated_at: now })],
    inverse: [{ op: "upsert", table: "fairs", row: prev }],
    message: copyAcciones.feriaCancelada(String(prev.name)),
    public: true,
    entity: "fair",
    entityId: a.feria_id,
  };
};

/** `deshacer` (tras confirmar): aplica el `inverse` de la acción indicada o, por defecto, la última de las 24 h. */
const deshacer: Executor = async ({ db, args, now, action, actor }) => {
  const a = parse("deshacer", args);
  const target = a.accion_id ?? (await lastUndoableId(db, action.chat_id, now));
  if (!target) throw new ActionError(copyAcciones.nadaParaDeshacer);
  const r = await undoAction(db, target, { chatId: action.chat_id, actor, now });
  if (r.kind !== "undone") {
    throw new ActionError(
      r.kind === "already"
        ? copyAcciones.yaDeshecho
        : r.kind === "expired"
          ? copyAcciones.nadaParaDeshacer
          : r.kind === "not_found"
            ? copyAcciones.noEncontre
            : copyAcciones.noSePuedeDeshacer,
    );
  }
  return { statements: [], inverse: [], message: copyAcciones.deshecho, public: false, entity: "pending_action", entityId: target, selfLogged: true };
};

/**
 * Ejecutores disponibles. `crear_producto`, `editar_variantes` y `agregar_fotos` (reglas de catálogo: slug,
 * variante por defecto, fotos) los agrega T19 con `registerExecutor`; `pedir_contenido` y `posponer_aviso`, sus tareas.
 */
export const executors: ExecutorMap = {
  editar_producto: editarProducto,
  cambiar_stock: cambiarStock,
  crear_feria: crearFeria,
  editar_feria: editarFeria,
  cancelar_feria: cancelarFeria,
  deshacer,
};

export function registerExecutor(name: ToolName, fn: Executor): void {
  executors[name] = fn;
}
