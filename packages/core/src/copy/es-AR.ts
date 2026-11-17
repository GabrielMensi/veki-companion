/** Textos fijos de Veki (español rioplatense, "vos"). No los inventa el LLM. Máx. un emoji por mensaje. */

export type Boton = { etiqueta: string; valor: string };

/** `callback_data` de los botones de una acción pendiente: `pa:<id>:yes|edit|no` (docs/02 §3.1). */
export const paData = (id: string, accion: "yes" | "edit" | "no") => `pa:${id}:${accion}`;

export const copy = {
  noEntendi: "Perdón, no te entendí. ¿Me lo decís de otra forma?",
  algoSalioMal: "Ups, algo salió mal de mi lado. ¿Probás de nuevo? 🙏",
  vencido: "Eso ya venció, ¿lo armamos de nuevo?",
  lenta: "Estoy un poquito lenta, te respondo en un ratito 🙏",
  noPudeEscuchar: "No pude escuchar el audio, ¿me lo mandás de nuevo o me lo escribís?",
  tipoNoSoportado: "Por ahora entiendo fotos, audios, videos cortitos y texto 🙂",
  cambiarPregunta: "¿Qué le cambio?",
  /** Atajos tras 2 malentendidos seguidos (docs/02 §3.4). */
  atajosTexto: "Probemos por acá, ¿qué querés hacer?",
  atajos: [
    { etiqueta: "Cargar producto", valor: "atajo:producto" },
    { etiqueta: "Vendí algo", valor: "atajo:venta" },
    { etiqueta: "Nueva feria", valor: "atajo:feria" },
    { etiqueta: "Pedir flyer", valor: "atajo:flyer" },
  ] satisfies Boton[],
  botonesAccion: (id: string): Boton[] => [
    { etiqueta: "Sí", valor: paData(id, "yes") },
    { etiqueta: "Cambiar", valor: paData(id, "edit") },
    { etiqueta: "Cancelar", valor: paData(id, "no") },
  ],
  /** Qué pedirle al LLM según el campo que falta del borrador (lo decide el código, docs/02 §3.1.3). */
  campoFaltante: {
    name: "cómo se llama",
    price_ars: "cuánto sale (o si es 'consultar')",
    category: "en qué categoría va",
    media_ids: "que mande al menos una foto",
    place: "dónde es",
    starts_at: "cuándo empieza (día y hora)",
    ends_at: "cuándo termina (día y hora)",
  } as Record<string, string>,
};

export function formatPrecio(p: number | "consultar" | null | undefined): string {
  if (p === "consultar" || p == null) return "precio a consultar";
  return `$${Math.round(p).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".")}`;
}

// ---- T18: acciones pendientes (confirmar, cambiar, cancelar, deshacer) ----

/** `callback_data` del botón Deshacer del mensaje de éxito: `pa:<id>:undo` (válido 24 h). */
export const paUndoData = (id: string) => `pa:${id}:undo`;

export const copyAcciones = {
  cancelado: "Listo, lo dejé sin hacer.",
  deshecho: "Listo, lo deshice 👌",
  nadaParaDeshacer: "No encuentro nada reciente para deshacer.",
  yaDeshecho: "Eso ya lo había deshecho.",
  noSePuedeDeshacer: "Eso no se puede deshacer.",
  noEncontre: "No encuentro eso. ¿Me decís de nuevo cuál es?",
  todaviaNo: "Eso todavía no lo sé hacer, perdoname 🙏",
  stockNegativo: "Eso dejaría el stock en negativo. ¿Cuántas hay?",
  stockDesconocido: "No tengo cargado cuántas hay. Decime el número y lo fijo.",
  faltaCambio: "No me quedó claro qué cambiar. ¿Me lo decís de nuevo?",
  fechasMal: "La feria no puede terminar antes de empezar. ¿Revisamos las fechas?",
  botonDeshacer: "Deshacer",
  productoCreado: (nombre: string) => `¡Listo! Ya cargué ${nombre} 🎉`,
  productoEditado: (nombre: string) => `Listo, actualicé ${nombre}.`,
  stockActualizado: (nombre: string, stock: number) => `Listo, ${nombre} queda con stock ${stock}.`,
  feriaCreada: (nombre: string) => `¡Feria agendada! ${nombre} ya está en tu agenda 📅`,
  feriaEditada: (nombre: string) => `Listo, cambié la feria ${nombre}.`,
  feriaCancelada: (nombre: string) => `Listo, cancelé la feria ${nombre}.`,
};

// ── T17: ingreso de fotos y videos ──────────────────────────────────────────
/** Límite de descarga de la Bot API (getFile): 20 MB. */
export const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;

const mbTexto = (n: number) => (n / 1024 / 1024).toFixed(1).replace(".", ",");

export const copyMedia = {
  /** Video que supera el límite de 20 MB (texto del spike de Telegram). `bytes` omitido = tamaño desconocido. */
  videoPesado: (bytes?: number) =>
    `Uh, ese video pesa ${bytes === undefined ? "más de 20 MB" : `${mbTexto(bytes)} MB`} y no lo puedo bajar (mi límite es 20 MB). ¿Me mandás uno más cortito, de unos 10 segundos? 🙏`,
};

// ── R3: presupuesto de tokens del chat ─────────────────────────────────────
export const copyPresupuesto = {
  /** A la usuaria cuando todos los modelos están ocupados: nunca ve un error, solo esto; el update se reintenta solo. */
  teAvisoEnUnRatito: "Estoy un poquito lenta ahora, te aviso en un ratito 🙏",
  /** Aviso a Gabriel (admin) al 80 % del tope diario de un modelo. Una vez por día por modelo. */
  presupuestoAlto: (modelo: string, usados: number, tope: number) =>
    `Aviso: el modelo ${modelo} ya usó ${usados.toLocaleString("es-AR")} de ${tope.toLocaleString("es-AR")} tokens de hoy (80 %). Si se agota, el chat pasa al siguiente modelo.`,
};

// ── T19: catálogo y ejecutores de respaldo ──────────────────────────────────
export const copyCatalogo = {
  borradorIncompleto: "Todavía me falta algún dato para cargarlo. ¿Seguimos armándolo?",
  fotoNoDisponible: "Alguna de las fotos ya no está disponible o ya la usé en otro producto. ¿Me las mandás de nuevo?",
  variantesMal: "No me quedó claro qué variantes tocar. ¿Me lo decís de nuevo?",
  fotosAgregadas: (nombre: string, n: number) => `Listo, sumé ${n === 1 ? "1 foto" : `${n} fotos`} a ${nombre}.`,
  variantesActualizadas: (nombre: string) => `Listo, actualicé las variantes de ${nombre}.`,
  /** `pedir_contenido` (Stage 3): todavía no existe; nunca se promete una fecha. */
  contenidoTodavia: "Todavía no puedo armarte flyers ni reels, pero pronto vas a poder pedírmelos 🙂 Por ahora seguimos con los productos y las ferias.",
  /** `posponer_aviso`: confirma sin prometer avisos que todavía no existen. */
  avisoAnotado: "Listo, anotado.",
};
