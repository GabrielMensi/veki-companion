// Guiones reutilizables (script del modelo + acciones de la usuaria) para los escenarios de T23.
import { FakeChatProvider, FakeSttProvider } from "@veki/core";
import { lastToolJson, mediaIdsOf, responder, seedCatalog, startWorld, tool, type World } from "./harness";
import { RINONERA, SAY } from "./spec";

export const NOMBRE = "Neceser de lona floreado";

/** Alta de producto: fotos + audio + una pregunta de categoria + vista previa. Devuelve el mundo con la vista previa a la vista. */
export async function altaHastaVistaPrevia(nPhotos: number): Promise<World> {
  const chat = new FakeChatProvider([
    // Turno 1 (fotos): guarda las fotos en el borrador y pregunta que producto es.
    (req) => tool("actualizar_borrador", { tipo: "producto", media_ids: mediaIdsOf(req) }),
    () => responder("¡Qué lindas fotos! ¿Me contás qué producto es?"),
    // Turno 2 (audio): nombre y precio salen de la transcripcion; falta la categoria.
    () => tool("actualizar_borrador", { tipo: "producto", campos: { name: NOMBRE, price_ars: 12500 } }),
    () => responder("Divino. ¿En qué categoría lo cargo?"),
    // Turno 3 (texto): categoria y pide confirmar.
    () => tool("actualizar_borrador", { tipo: "producto", campos: { category: "neceseres" } }),
    () => tool("crear_producto"),
  ]);
  const w = startWorld({ chat, stt: new FakeSttProvider([{ text: SAY.voiceProducto, lowConfidence: false }]) });
  await w.photos(nPhotos);
  await w.voice();
  await w.text(SAY.categoria);
  return w;
}

/** "cambiale el precio a quince mil" sobre la rinonera sembrada: deja la vista previa a la vista. */
export async function ediccionHastaVistaPrevia(extra: ConstructorParameters<typeof FakeChatProvider>[0] = []): Promise<World> {
  await seedCatalog([RINONERA]);
  const chat = new FakeChatProvider([
    // Turno 1: consulta el precio.
    () => tool("buscar_productos", { consulta: "riñonera girasol" }),
    (req) => responder(`La ${lastToolJson(req)[0].nombre} sale ${lastToolJson(req)[0].precio}.`),
    // Turno 2: cambia el precio (vuelve a buscar el id y propone el cambio).
    () => tool("buscar_productos", { consulta: "riñonera" }),
    (req) => tool("editar_producto", { producto_id: lastToolJson(req)[0].id, cambios: { price_ars: 15000 } }),
    ...extra,
  ]);
  const w = startWorld({ chat });
  await w.text(SAY.preguntaPrecio);
  await w.text(SAY.cambiarPrecio);
  return w;
}
