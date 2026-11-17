# Veki Companion — Visión y decisiones (borrador v0.1)

> Estado: brainstorming. Sin diseño ni implementación. Fecha: 2026-11-16.
> Este documento enumera decisiones, supuestos, riesgos y pendientes. Es la entrada para el plan de diseño y la implementación por etapas.

## 1. Contexto y problema

- La madre del autor es artesana (costura y productos en tela) y vende en ferias, en persona.
- Su único canal digital es WhatsApp, donde sube estados con fotos del puesto. Tiene un Instagram personal sin actividad.
- Pierde ventas y clientes por falta de exposición de marca y productos. No sabe hacer reels ni flyers, y administrar una web le resulta complejo.

**Problema central:** cómo una persona poco técnica administra su web y sus redes con ayuda de IA, sin curva de aprendizaje.

## 2. Objetivos y restricciones

**Objetivos**
1. Promover canales digitales: una web sencilla (catálogo) e Instagram.
2. Generar contenido (flyers, carruseles, textos, luego reels) a partir de fotos, videos cortos y mensajes de ella.
3. Administrar catálogo (alta/baja/stock) conversando con un bot.
4. Captar contactos sin pagos web: el cliente interesado contacta a ella por WhatsApp.
5. Extras simples: agenda de ferias, novedades, eventos.

**Restricciones**
- **Todo gratis** (hosting, límites de IA). Bajo costo solo si hay gran ventaja.
- Sin pagos en la web.
- Escala chica: 20–50 productos con variantes (diseño, tamaño, color), una sola usuaria.

## 3. Principios de diseño

1. **La interfaz es una conversación.** No hay panel de administración para ella.
2. **Audio primero.** Notas de voz, fotos y videos cortos como entrada natural.
3. **Nada se publica sin confirmación.** El bot muestra una vista previa con botones (Sí / Cambiar / Cancelar).
4. **Una pregunta por vez.** Sin menús ni comandos que recordar.
5. **El bot es proactivo.** Inicia conversaciones (recordatorios, avisos de feria) para que ella no dependa de acordarse.
6. **El autor es admin de respaldo.** Existe un panel o herramientas solo para él.
7. **Contenido con material real.** No se generan imágenes de producto con IA. Las plantillas de marca arman flyers y reels con sus fotos.
8. **Proveedores intercambiables.** Los límites gratis cambian, así que cada capa de IA tiene cadena de respaldo.

## 4. Decisiones tomadas

| # | Decisión | Motivo |
|---|---|---|
| D1 | Canal principal: **Telegram** (bot con webhook). Diseño abierto a sumar WhatsApp después. | Gratis, sin ventana de 24 h para mensajes proactivos, sin número dedicado ni verificación de Meta. Fricción baja si ya usa WhatsApp. |
| D2 | Lenguaje: **TypeScript** de punta a punta. | Tipos compartidos entre bot, web y workers. |
| D3 | Web: sitio estático (**Astro**) en **Cloudflare Pages**, reconstruido cuando cambia el catálogo. | Gratis, rápido, sin servidor que mantener. Dominio `*.pages.dev` al inicio. |
| D4 | Datos: **Cloudflare D1** (catálogo, estado de conversación, agenda). Archivos en **R2**. | Cubre ampliamente la escala, plan gratis. Se descarta Supabase gratis porque pausa proyectos inactivos. |
| D5 | Leads: botón **"Consultar por WhatsApp"** con mensaje prellenado (`wa.me`). | Contacto directo a ella, sin formulario ni spam. |
| D6 | Contenido: LLM con salida estructurada para copy, selección de fotos y guiones, más **plantillas determinísticas** para flyers y reels. | Gratis, consistente con la marca, no consume cuota de generación de imagen. |
| D7 | Instagram: **etapa posterior**. En el MVP el bot entrega el contenido listo y ella lo publica manualmente. | La publicación por API exige cuenta profesional; la conversión queda para más adelante. |
| D8 | Dominio propio: más adelante, si ella se siente cómoda. | Prioridad gratis. |
| D9 | Speech-to-text: Groq `whisper-large-v3`, sin pista de vocabulario. | Spike 1: 10 notas reales, 0 errores de API, ~450 ms de latencia, solo 3 diferencias menores de palabra frente a la lectura. Detalle en `spikes/whisper` (PR #2). |

## 5. Stack de IA (verificado el 2026-11-16, con las salvedades de la sección 8)

| Necesidad | Primario | Respaldo |
|---|---|---|
| Entender mensajes y llamar herramientas | Groq `gpt-oss-120b` | OpenRouter `:free`, Gemini Flash-Lite |
| Voz a texto (español) | Groq Whisper large-v3 | Whisper en Cloudflare Workers AI |
| Visión (elegir fotos, describir producto) | Gemini free | Modelo de visión gratis en OpenRouter |
| Textos en español | Groq `gpt-oss-120b` | Gemini Flash-Lite |

- Con 20–100 pedidos/día los límites gratis sobran.
- **Privacidad:** Gemini free usa los datos para mejorar productos de Google y pueden revisarlos personas. Se usa solo para visión de fotos de productos, no para el chat personal.
- Mistral ya no ofrece API gratis.

## 6. Infraestructura (límites verificados, planes gratis)

- **Workers:** 10 ms de CPU por ejecución, 100k pedidos/día. El webhook debe responder rápido y delegar el trabajo pesado.
- **D1:** 5 GB, 100k escrituras/día. **R2:** 10 GB, sin costo de descarga. **Cron Triggers:** 5 por cuenta (recordatorios y avisos). **Pages:** 500 builds/mes.
- **Containers:** requieren plan de pago, descartados. **Browser Run:** 10 min/día gratis, solo como respaldo para flyers.
- **Telegram:** el bot descarga hasta 20 MB y envía hasta 50 MB. Los mensajes son gratis. Los álbumes llegan como mensajes sueltos con un `media_group_id` en común, y hay que agruparlos.

### 6.1 Render de contenido: decisión abierta

GitHub Actions (repo privado) se descartó para el inicio porque el autor agotó la cuota gratis de este mes. Nota: en repos **públicos** Actions es gratis. Opciones, ordenadas por cómo las veo hoy:

| Opción | A favor | En contra |
|---|---|---|
| **A. Repo público solo con el workflow de render** (sin secretos, entradas y salidas por URLs firmadas de R2) | Gratis, sin infraestructura propia | Latencia de cola sin medir. Hay que cuidar que nada sensible quede expuesto. |
| **B. Worker local** (máquina del autor) que consulta una cola | Gratis, sin límites de tiempo | Depende de que esa máquina esté encendida. |
| **C. VM Always Free de Oracle** | Potente (2 CPU, 12 GB) | El registro suele fallar y la política de inactividad puede reclamar la VM. |
| **D. Render en el navegador** (ffmpeg.wasm en una Mini App) | Sin servidor | Pesado en un celular modesto. Complejidad alta. |
| **E. Diferir los reels** y renderizar solo imágenes en el MVP | Elimina el problema al inicio | Posterga lo más vistoso. |

**Recomendación de partida:** E para el MVP (flyers y carruseles, sin video) y probar A o B para los reels. Antes de elegir hace falta un spike (sección 9).

**Pendiente técnico del MVP:** confirmar que el render de flyers (por ejemplo Satori en Workers) cabe en 10 ms de CPU. Si no cabe, hay que renderizarlos también en el worker de la opción elegida.

## 7. Instagram (referencia para la etapa posterior)

- La API solo sirve a cuentas **profesionales** (Creator o Business). Una cuenta personal no tiene acceso.
- Con el login de Instagram no haría falta una Página de Facebook. Para publicar solo en su cuenta bastaría el acceso estándar de la app de Meta, sin App Review.
- Reels: MP4 (H.264 y AAC), 9:16, hasta 300 MB, desde una URL pública (R2 sirve).
- Los tokens duran 60 días y deben renovarse con un cron. Si pasan 60 días sin renovar se pierden.
- Fase 1 (actual): el bot le entrega el contenido y ella lo publica. Fase 2: publicación por API, previa conversión de la cuenta.

## 8. Riesgos y supuestos sin verificar

- **Límites gratis cambiantes:** los números de Gemini varían según la fuente, y Groq ya retiró modelos del plan gratis. Hay que revisarlos antes del lanzamiento.
- **Whisper con acento rioplatense:** sin probar.
- **Videos de feria > 20 MB:** el bot no puede descargarlos. Mitigación inicial: pedirle clips cortos (~10 s) y enviarlos como video. Plan B: Mini App de subida directa a R2.
- **Telegram:** el bot solo escribe a usuarios que lo iniciaron. Falta confirmar si ella ya lo usa.
- **Instagram sin verificar:** pasos de conversión, requisitos de Stories, términos de automatización y alternativas gratis de programación.
- **Datos de terceros:** parte del reporte de LLMs (límites de Gemini, retiro de modelos de Groq, fin de la API gratis de Mistral) viene de fuentes no oficiales.
- **Render:** latencia y tiempos reales sin medir en ninguna opción.
- **Adopción:** el éxito depende de que ella use el bot. Tono, brevedad y proactividad son parte del producto, no detalles.

## 9. Spikes propuestos (pruebas cortas, antes del diseño)

1. **Whisper:** probar Groq con ~10 notas de voz reales de ella.
2. **Render:** medir un flyer y un reel de prueba en las opciones A y B. Verificar el límite de CPU en Workers.
3. **Telegram:** mandar videos reales de feria y ver si pasan el límite de 20 MB.
4. **Visión:** probar la selección de las mejores fotos de un puesto con Gemini.

## 10. Ideas a priorizar (sin decidir)

- Agenda pública de ferias ("Esta semana estoy en…") y post automático de aviso antes de cada feria.
- Stock por voz ("vendí 2 neceseres").
- Registro de encargos personalizados.
- Resumen semanal por Telegram.
- "Producto de la semana".
- QR impreso en el puesto que lleve al catálogo.
- Lista de novedades protegida con Turnstile.

## 11. Pendientes del autor

- [x] Identidad de marca recibida (ver sección 13). Falta extraer los archivos del logo en versión vectorial o PNG.
- [ ] Confirmar si ella ya usa Telegram.
- [ ] Más adelante: decidir cuándo convertir el Instagram a cuenta profesional.

## 12. Próximo paso

Elegir qué spikes hacer primero y recién después armar el plan de diseño y las etapas de implementación. Las investigaciones se delegan en subagentes de nivel bajo (Haiku) y las decisiones las toma el autor.

## 13. Identidad de marca (del brandbook recibido el 2026-11-17)

- **Nombre de la marca: "Veky"** (con y griega). El repo y el bot usan "veki" por el nombre del proyecto; el contenido público debe decir **Veky**.
- **Producto:** accesorios textiles artesanales (carteras, riñoneras, neceseres, etc.) con diseño creativo y colorido.
- **Público:** personas de 20 a 40 años que buscan productos únicos que reflejen su personalidad. Es una marca emergente que creció por boca a boca; el objetivo es ganar visibilidad en redes.
- **Personalidad y tono:** alegre, cálida, cercana, creativa, espontánea. Rechaza el minimalismo y la falta de personalidad. Los textos que genere la IA deben sonar así.
- **Paleta:** lila `#AC9FD6` (principal), verde `#C3D787` (secundario), celeste `#A3D3DD` (secundario).
- **Tipografía:** Poppins (Regular para cuerpos de texto; el brandbook completo define las demás variantes).
- **Logo:** isologo principal con una tijera integrada y tipografía redondeada, en lila. Hay variante horizontal (para etiquetas), versiones positiva y negativa, y mockups de aplicaciones.
- **Estilo de anuncios:** escenas exageradas (hipérbole) y metáforas que muestran los accesorios como parte de la historia de quien los usa.
- **Fuente:** PDF privado en `samples/` (gitignored; contiene datos personales de la diseñadora). No se versiona.
