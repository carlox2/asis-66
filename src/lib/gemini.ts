import { GoogleGenAI, ThinkingLevel } from "@google/genai";

export const GEMINI_MODEL = "gemini-3.6-flash";

/**
 * Identifica a la materia y sirve como anclaje en la UI
 * (panel de Configuración muestra este string).
 */
export const ASSISTANT_LABEL = "asist. 66 — Salud Pública y Salud Mental (Cátedra II, Tajer)";

/**
 * Bibliografía obligatoria de la materia. El modelo NO debe responder
 * con nada que no esté en estos dos PDFs. Se suben a Gemini File API
 * una sola vez por sesión y se referencian por fileUri.
 */
const VITE_BASE_URL: string =
  ((import.meta as ImportMeta & { env: Record<string, string | undefined> }).env?.BASE_URL ?? "/");

const PDF_SOURCES = [
  { name: "01.S1_3_FULL.pdf", path: `${VITE_BASE_URL}01.S1_3_FULL.pdf` },
  { name: "02.S4_6_FULL.pdf", path: `${VITE_BASE_URL}02.S4_6_FULL.pdf` },
] as const;

/**
 * Cache en localStorage: para cada PDF guardamos { uri, expiry }.
 * TTL: 24h (la File API de Gemini expira a las 48h, dejamos margen).
 */
const KB_CACHE_PREFIX = "gem-pdf-uri:";
const KB_TTL_MS = 24 * 60 * 60 * 1000;

interface CachedUri {
  uri: string;
  expiry: number;
}

function readCachedUri(name: string): string | null {
  try {
    const raw = localStorage.getItem(KB_CACHE_PREFIX + name);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedUri;
    if (!parsed?.uri || !parsed?.expiry) return null;
    if (parsed.expiry < Date.now()) return null;
    return parsed.uri;
  } catch {
    return null;
  }
}

function writeCachedUri(name: string, uri: string): void {
  try {
    const payload: CachedUri = { uri, expiry: Date.now() + KB_TTL_MS };
    localStorage.setItem(KB_CACHE_PREFIX + name, JSON.stringify(payload));
  } catch {
    /* sin persistencia: se re-subirá cada vez */
  }
}

/**
 * Sube un PDF a Gemini File API y devuelve el fileUri.
 * Si ya hay uno cacheado en localStorage (no expirado), lo reusa.
 */
async function ensurePdfUploaded(
  ai: GoogleGenAI,
  name: string,
  path: string
): Promise<string> {
  const cached = readCachedUri(name);
  if (cached) return cached;

  const res = await fetch(path);
  if (!res.ok) {
    throw new Error(`No se pudo cargar ${name} desde el sitio (HTTP ${res.status}).`);
  }
  const blob = await res.blob();
  if (blob.size === 0) {
    throw new Error(`El archivo ${name} está vacío.`);
  }

  const uploaded = await ai.files.upload({
    file: new File([blob], name, { type: "application/pdf" }),
    config: { displayName: name },
  });
  const uri = uploaded?.uri;
  if (!uri) {
    throw new Error(`No se pudo subir ${name} a Gemini File API.`);
  }
  writeCachedUri(name, uri);
  return uri;
}

/**
 * Prepara la base de conocimiento: sube los dos PDFs a Gemini File API
 * (o reutiliza los URIs cacheados) y devuelve un array de fileData
 * listo para meter en `parts[]`.
 */
async function buildKnowledgeBaseParts(
  ai: GoogleGenAI,
  onProgress?: (msg: string) => void
): Promise<{ fileData: { fileUri: string; mimeType: string } }[]> {
  const parts: { fileData: { fileUri: string; mimeType: string } }[] = [];
  for (const src of PDF_SOURCES) {
    // Avisamos distinto según haya caché o no, para no mentirle al usuario
    // cuando el PDF ya está subido y solo se reusa el fileUri.
    const cached = readCachedUri(src.name) !== null;
    onProgress?.(
      cached
        ? `Reusando ${src.name} en caché (sin resubir)…`
        : `Subiendo ${src.name} a Gemini…`
    );
    const uri = await ensurePdfUploaded(ai, src.name, src.path);
    parts.push({ fileData: { fileUri: uri, mimeType: "application/pdf" } });
  }
  return parts;
}

/**
 * Prompt del sistema — Salud Pública y Salud Mental (Cód. 66, Cátedra II - Dra. Débora Tajer).
 * Reescrito por completo: marco de Medicina Social Latinoamericana, Derechos Humanos,
 * Epistemología de la Complejidad y Giro Decolonial. Prosa continua, 250-300 palabras.
 */
export const SYSTEM_PROMPT = `1. Identidad y Marco Epistemológico
Eres un Tutor de Inteligencia Artificial de Excelencia Académica, especializado de forma exclusiva en la materia Salud Pública y Salud Mental (Código 66, Cátedra II - Dra. Débora Tajer) de la Facultad de Psicología de la Universidad de Buenos Aires. Tu propósito es producir respuestas modelo de examen parcial y final, reproduciendo con máxima fidelidad el marco conceptual de la Medicina Social Latinoamericana / Salud Colectiva, el Paradigma de Derechos Humanos, la Epistemología de la Complejidad y el Giro Decolonial propios de la cátedra.

2. Base de Conocimiento y Distinción de Autores
Tus respuestas deben fundamentarse EXCLUSIVA Y OBLIGATORIAMENTE en los documentos cargados en tu base de conocimiento: "01.S1_3_FULL.pdf" y "02.S4_6_FULL.pdf". No inventes información ni utilices fuentes externas.
Es un requisito estricto que, al desarrollar los temas, mantengas una distinción clara y precisa de los autores de la cátedra (por ejemplo: Stolkiner, Tajer, Galende, Luciani Conde, Menéndez, etc.), evitando mezclar sus postulados o generalizarlos.

3. Reglas Estrictas de Formato y Estilo para Respuestas
- PROHIBIDO SALUDAR O USAR METATEXTO: No utilices introducciones ("Hola", "A continuación..."), despedidas ni frases de relleno. Inicia inmediatamente con la primera palabra de la respuesta académica.
- ESTRUCTURA EXCLUSIVA EN PROSA NARRATIVA CONTINUA: Toda respuesta debe componerse exactamente de 3 o 4 párrafos densos, fluidos y articulados:
  * Párrafo 1 (Tesis): Presentación del problema, contextualización sociohistórica y definición rigurosa del concepto nuclear.
  * Párrafo 2 (Desarrollo teórico): Despliegue analítico profundo, entrelazando autores, categorías y debates epistemológicos.
  * Párrafo 3 o 4 (Cierre): Implicancias ético-políticas, consecuencias en el modelo de atención, enfoque de derechos humanos, desmanicomialización/descolonialización y la práctica del psicólogo.
- PROHIBICIÓN TOTAL DE LISTAS Y VIÑETAS: Terminantemente prohibido el uso de viñetas, ítems numerados, tablas, cuadros o subtítulos. Todo el desarrollo debe estar integrado en prosa continua.
- EXTENSIÓN ESTRICTA: Cada respuesta debe tener una extensión de entre 250 y 300 palabras.
- RIGOR TERMINOLÓGICO: No emplear conceptos del sentido común ni reduccionismos biologicistas/psicopatológicos. Citar autores y categorías clave de forma precisa en el flujo de la redacción.
- CIERRE FORMAL: La respuesta finaliza con un punto final al término del último párrafo.`;

export const KNOWLEDGE_BASE_NOTE =
  "Base de conocimiento: 01.S1_3_FULL.pdf + 02.S4_6_FULL.pdf (subidos a Gemini File API).";

/**
 * Lee la API key desde la variable de entorno de Vite.
 * Se mantiene como fallback; la app prefiere siempre la key que el usuario
 * haya guardado en el panel de Configuración (localStorage).
 */
export const GEMINI_API_KEY: string = (
  (import.meta as ImportMeta & { env: Record<string, string | undefined> }).env?.VITE_GEMINI_API_KEY ?? ""
).trim();


export function pickMimeType(): string {
  if (typeof MediaRecorder === "undefined") return "audio/webm";
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/ogg;codecs=opus",
  ];
  return candidates.find((m) => MediaRecorder.isTypeSupported(m)) ?? "audio/webm";
}

/**
 * Convierte un Blob (audio grabado) a una cadena Base64 *sin* el prefijo
 * `data:<mime>;base64,` que agrega FileReader — es lo que espera Gemini
 * en `inlineData.data`.
 */
export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? "");
      resolve(result.split(",")[1] ?? "");
    };
    reader.onerror = () => reject(new Error("No se pudo codificar el audio a Base64."));
    reader.readAsDataURL(blob);
  });
}

/**
 * Limpia el texto que devuelve Gemini antes de mostrarlo o leerlo en voz
 * alta. Caza los artefactos típicos de cuando el modelo se "contagia" del
 * formato de transcripción de audio (timecodes SRT/VTT, etiquetas de
 * hablante, etc.) y de cualquier residuo de markdown que el TTS leería
 * literal (asteriscos, guiones bajos, etc.). Pensada como red de seguridad:
 * aunque el system prompt lo prohíba, el modelo a veces los emite igual.
 *
 * Patrones que elimina:
 *  - Sello MM:SS o HH:MM:SS pegado o suelto:           00:05 · 1:23 · 00:05.123
 *  - Pegado a una palabra (sin espacio):                "socio01:03estructural" → "socioestructural"
 *  - Con corchetes / ángulos / paréntesis:              [00:05] · <00:05> · (00:05)
 *  - Rangos SRT/VTT:                                    00:05 --> 00:08 · 00:05,000 --> 00:08,000
 *  - Etiquetas de hablante:                             Speaker 1: · Hablante 2:
 *  - Líneas que son solo un número (índices SRT)
 *  - Marcado Markdown simple: **negrita**, *itálica*, _itálica_, `código`
 */
export function sanitizeResponseText(text: string): string {
  if (!text) return text;
  let t = text;
  // 1) Índices de bloque SRT: una línea entera que es solo 1-4 dígitos
  t = t.replace(/^\s*\d{1,4}\s*$/gm, "");
  // 2) Rangos SRT/VTT: "00:05 --> 00:08" / "00:05,000 --> 00:08,000"
  t = t.replace(
    /\b\d{1,2}:\d{2}(?:[.,]\d{1,3})?\s*-->\s*\d{1,2}:\d{2}(?:[.,]\d{1,3})?\b/g,
    " "
  );
  // 3) Sellos de tiempo con corchetes/ángulos/paréntesis: [00:05], <1:23>
  t = t.replace(
    /[\[\<\(]\s*\b\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?\b\s*[\]\>\)]/g,
    " "
  );
  // 4) Sellos sueltos: 00:05, 1:23, 00:05.123 (incluye HH:MM:SS).
  //    Importante: NO usar \b al final, porque un sello pegado a una
  //    palabra ("socio01:03estructural") no tiene word boundary y el
  //    \b lo dejaría pasar. Usamos (?<!\d) al inicio (para no
  //    comernos el "12" de "12:00:30") y (?!\d) al final (para no
  //    comernos el "00" de "12:00:30.5"). El reemplazo es "" (sin
  //    espacio) para que el texto fluya al pegarse a la palabra.
  t = t.replace(/(?<!\d)\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?(?!\d)/g, "");
  // 5) Etiquetas de hablante: "Speaker 1:", "Hablante 2]", "Speaker1 -"
  t = t.replace(/\b(?:Speaker|Hablante|Unknown)\s*\d+\s*[:\-\]]\s*/gi, " ");
  // 6) Markdown residual: negrita (**), itálica (*) y código (`).
  //    El system prompt prohíbe markdown, pero a veces el modelo se
  //    "contagia" y lo emite igual — y speechSynthesis lo lee literal
  //    ("asterisco asterisco negrita asterisco asterisco").
  t = t.replace(/\*\*([^*]+)\*\*/g, "$1");
  t = t.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1$2");
  t = t.replace(/`([^`]+)`/g, "$1");
  // 7) Limpieza: colapsa espacios y saltos de línea sobrantes
  t = t.replace(/[ \t]{2,}/g, " ");
  t = t.replace(/[ \t]+\n/g, "\n");
  t = t.replace(/\n{3,}/g, "\n\n");
  return t.trim();
}

/**
 * Resultado de separar la respuesta de Gemini en transcripción + respuesta.
 * `question` queda vacío si el modelo no devolvió los marcadores.
 */
export interface ParsedAnswer {
  question: string;
  answer: string;
}

/**
 * Separa una respuesta de Gemini en {question, answer} según los marcadores
 * <PREGUNTA>...</PREGUNTA> y <RESPUESTA>...</RESPUESTA>. Si el modelo no los
 * devolvió (fallback), trata todo el texto como respuesta y deja `question`
 * vacío. La regex es case-insensitive y tolerante a saltos de línea.
 */
export function parseAnswer(text: string): ParsedAnswer {
  if (!text) return { question: "", answer: "" };
  const m = text.match(
    /<PREGUNTA>([\s\S]*?)<\/PREGUNTA>\s*<RESPUESTA>([\s\S]*?)<\/RESPUESTA>/i
  );
  if (m) {
    return {
      question: m[1].trim(),
      answer: m[2].trim(),
    };
  }
  // Fallback: puede que el modelo haya escrito solo "Pregunta: ... Respuesta: ..."
  // en prosa. Hacemos un split defensivo por la palabra "Respuesta:" si aparece.
  const loose = text.split(/^(?:\s*)?(?:Respuesta|R)\s*:\s*/im);
  if (loose.length >= 2) {
    return { question: loose[0].trim(), answer: loose.slice(1).join("\n").trim() };
  }
  return { question: "", answer: text.trim() };
}

/* ============================================================
 * AUTO-COMMIT A GITHUB (auto-guardado en el repo)
 * ------------------------------------------------------------
 * Sube un archivo .txt con el Q&A a una carpeta del repo del
 * usuario usando la Contents API de GitHub. Pensado para que las
 * preguntas y respuestas de la sesión queden persistidas online
 * (en el propio repo del usuario) sin necesidad de backend.
 *
 * No requiere SHA porque cada Q&A tiene timestamp único (con
 * segundos) → siempre es un CREATE, nunca un UPDATE.
 *
 * Permisos: el PAT necesita `contents: write` sobre el repo
 * destino (clásico: scope `repo`; fine-grained: Contents=R/W).
 * ============================================================ */

export interface GitHubCommitResult {
  ok: boolean;
  url?: string;   // HTML URL del archivo en github.com
  status?: number; // HTTP status code devuelto por GitHub
  message?: string; // mensaje de error legible si !ok
}

export interface GitHubCommitOptions {
  token: string;        // Personal Access Token del usuario
  repo: string;         // "owner/name" (ej. "carlox2/asis-66")
  branch?: string;      // default "main"
  folder?: string;      // default "qa-logs" (se crea si no existe)
  filename?: string;    // default: asis66-YYYY-MM-DD-HH-MM-SS.txt
  content: string;      // contenido del .txt (UTF-8)
  commitMessage?: string; // default: "qa: <filename>"
}

/**
 * Sube un archivo .txt al repo vía GitHub Contents API.
 * Devuelve { ok, url } o { ok: false, status, message } en caso de error.
 * No lanza excepciones — todos los errores quedan en el resultado.
 */
export async function commitQaToGitHub(
  opts: GitHubCommitOptions
): Promise<GitHubCommitResult> {
  const {
    token,
    repo,
    branch = "main",
    folder = "qa-logs",
    filename,
    content,
    commitMessage,
  } = opts;

  // Validación mínima
  const cleanToken = (token ?? "").trim();
  if (!cleanToken) {
    return { ok: false, message: "Falta el Personal Access Token." };
  }
  const cleanRepo = (repo ?? "").trim().replace(/^\/+|\/+$/g, "");
  if (!/^[\w.-]+\/[\w.-]+$/.test(cleanRepo)) {
    return { ok: false, message: "Repo inválido. Formato esperado: owner/name." };
  }
  const finalFilename = filename || `asis66-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.txt`;
  const path = `${folder.replace(/\/+$/g, "")}/${finalFilename}`;
  const message = commitMessage || `qa: ${finalFilename}`;

  // GitHub Contents API espera el contenido en base64
  const base64Content = btoa(unescape(encodeURIComponent(content)));

  const url = `https://api.github.com/repos/${cleanRepo}/contents/${path}`;

  try {
    const res = await fetch(url, {
      method: "PUT",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${cleanToken}`,
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({
        message,
        content: base64Content,
        branch,
      }),
    });

    if (res.ok) {
      const data = (await res.json()) as { content?: { html_url?: string } };
      return {
        ok: true,
        url: data?.content?.html_url,
        status: res.status,
      };
    }

    // GitHub devuelve 422 si el path ya existe (mismo segundo). En ese
    // caso devolvemos ok:false con un mensaje claro, sin propagar la
    // excepción — la app debe seguir funcionando aunque el commit falle.
    const errBody = await res.json().catch(() => null) as {
      message?: string;
      errors?: { message?: string }[];
    } | null;
    const detail = errBody?.message || res.statusText || `HTTP ${res.status}`;
    const errDetail = errBody?.errors?.[0]?.message;
    return {
      ok: false,
      status: res.status,
      message: errDetail ? `${detail} — ${errDetail}` : detail,
    };
  } catch (err) {
    return {
      ok: false,
      message: (err as Error)?.message || "Error de red al contactar GitHub.",
    };
  }
}

/** Extrae un mensaje legible de un error arbitrario (incluido el del SDK). */
function describeError(err: unknown): string {
  if (typeof err === "string") return err;
  if (err && typeof err === "object") {
    const e = err as {
      message?: string;
      status?: number | string;
      code?: number | string;
      error?: { message?: string; code?: number | string; status?: string };
    };
    if (e.error?.message) {
      const code = e.error.code ?? e.error.status ?? e.status ?? e.code;
      return code ? `[${code}] ${e.error.message}` : e.error.message;
    }
    if (e.message) return e.message;
  }
  return "Error desconocido al hablar con Gemini.";
}

/**
 * Detecta errores transitorios del servicio (503 UNAVAILABLE,
 * "high demand", "overloaded", etc.). En esos casos, reintentamos
 * una vez antes de mostrar el error al usuario.
 */
function isTransientError(err: unknown): boolean {
  const detail = describeError(err).toLowerCase();
  return (
    detail.includes("503") ||
    detail.includes("unavailable") ||
    detail.includes("high demand") ||
    detail.includes("overloaded") ||
    detail.includes("try again later")
  );
}

/**
 * Sube los PDFs de la bibliografía a Gemini File API (o reutiliza
 * los URIs cacheados en localStorage). Es idempotente: si el cache
 * expiró o nunca existió, sube; si todavía es válido, no hace nada.
 *
 * Útil para "calentar" la base de conocimiento al inicio de la sesión
 * y para que la UI pueda mostrar el estado ("Subiendo PDFs a Gemini…").
 */
export async function warmupKnowledgeBase(
  apiKey: string,
  onProgress?: (msg: string) => void
): Promise<void> {
  const cleanKey = apiKey.trim();
  if (!cleanKey || cleanKey === "TU_API_KEY_AQUI") {
    throw new Error("Configura tu API Key de Gemini en el panel de Configuración.");
  }
  const ai = new GoogleGenAI({ apiKey: cleanKey });
  await buildKnowledgeBaseParts(ai, onProgress);
}

/**
 * Indica si la base de conocimiento ya está cacheada y vigente.
 * Devuelve true si AMBOS PDFs tienen un fileUri no expirado.
 */
export function isKnowledgeBaseReady(): boolean {
  return PDF_SOURCES.every((s) => readCachedUri(s.name) !== null);
}

/**
 * Envía el audio + la base de conocimiento (PDFs vía File API) a Gemini
 * usando el SDK oficial `@google/genai`.
 *
 * Estructura del request:
 *   parts: [
 *     ...pdfFileData[],              // 01.S1_3_FULL.pdf + 02.S4_6_FULL.pdf
 *     { inlineData: <audio> },       // clip grabado
 *     { text: <instrucción> }        // "Escuchá el audio y respondé…"
 *   ]
 *
 * Manejo de errores:
 *  - Errores transitorios (503/UNAVAILABLE/"high demand"): reintenta una
 *    vez con 4 s de espera. Si el segundo intento también falla, muestra
 *    un mensaje claro en español.
 *  - API key inválida / 401/403: mensaje específico, sin reintento.
 *  - Cuota agotada / 429: mensaje específico, sin reintento.
 *  - Errores de red: mensaje específico, sin reintento.
 */
export async function askGemini(
  base64Audio: string,
  mimeType: string,
  apiKey: string,
  onProgress?: (msg: string) => void
): Promise<string> {
  const cleanKey = apiKey.trim();
  if (!cleanKey || cleanKey === "TU_API_KEY_AQUI") {
    throw new Error("Configura tu API Key de Gemini en el panel de Configuración.");
  }

  const ai = new GoogleGenAI({ apiKey: cleanKey });

  // 1) Base de conocimiento: sube los PDFs a File API (o reusa cache).
  onProgress?.("Preparando base de conocimiento…");
  const pdfParts = await buildKnowledgeBaseParts(ai, onProgress);

  const contents = [
    {
      parts: [
        ...pdfParts,
        { inlineData: { mimeType, data: base64Audio } },
        {
          text:
            "Escuchá el audio adjunto. " +
            "Antes de responder, transcribí textualmente lo que dije, encerrado entre los marcadores " +
            "<PREGUNTA> y </PREGUNTA> (en una sola línea, sin saltos). " +
            "Inmediatamente después, brindá tu respuesta académica según las instrucciones del sistema, " +
            "encerrada entre los marcadores <RESPUESTA> y </RESPUESTA>. " +
            "Fundamentá exclusivamente en los dos PDFs cargados " +
            "(01.S1_3_FULL.pdf y 02.S4_6_FULL.pdf).",
        },
      ],
    },
  ];
  const config = {
    systemInstruction: SYSTEM_PROMPT,
    // Las respuestas de parcial de 250-300 palabras (prosa densa) usan
    // ~500-900 tokens. 2400 deja margen sin truncar.
    maxOutputTokens: 2400,
    // Thinking LOW reduce la latencia drásticamente.
    thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
    // Temperatura baja = respuestas más deterministas y ligeramente
    // más rápidas (menos sampling).
    temperature: 0.3,
  };

  const MAX_ATTEMPTS = 2;
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await ai.models.generateContent({
        model: GEMINI_MODEL,
        contents,
        config,
      });
      const text = (response?.text ?? "").trim();
      if (!text) {
        throw new Error("Gemini no devolvió texto. Intenta grabar la pregunta con más claridad.");
      }
      return text;
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_ATTEMPTS && isTransientError(err)) {
        // Espera 4 s antes del reintento.
        await new Promise((resolve) => setTimeout(resolve, 4000));
        continue;
      }
      break;
    }
  }

  // Si llegamos acá, falló definitivamente. Mapeo a un mensaje en
  // español claro, sin JSON crudo en la UI.
  const detail = describeError(lastErr);
  const lower = detail.toLowerCase();
  if (
    lower.includes("api key") ||
    lower.includes("auth") ||
    lower.includes("credential") ||
    lower.includes("permission") ||
    lower.includes("401") ||
    lower.includes("403")
  ) {
    throw new Error(`API Key rechazada por Gemini: ${detail}`);
  }
  if (lower.includes("quota") || lower.includes("429") || lower.includes("rate")) {
    throw new Error(`Cuota o rate-limit de Gemini: ${detail}`);
  }
  if (isTransientError(lastErr)) {
    throw new Error(
      "El servicio de Gemini está saturado. Reintentá en unos minutos. " +
        `Detalle: ${detail}`
    );
  }
  if (lower.includes("network") || lower.includes("fetch") || lower.includes("econn") || lower.includes("timeout")) {
    throw new Error(`Sin conexión con Gemini: ${detail}`);
  }
  throw new Error(`Gemini rechazó la solicitud: ${detail}`);
}
