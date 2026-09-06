# AGENTS.md

Instrucciones para que un agente de IA (o un humano) pueda tomar esta receta
y aplicarla a **otro repositorio** sin tener que reinventarla. Está escrita
para ser drop-in: copiá las funciones, conectalas a tu UI, y listo.

---

## 1. Funcionalidad: auto-guardar Q&A de un asistente IA en el propio repo de GitHub

**Problema que resuelve:** una app frontend (estática, desplegada en GitHub
Pages o similar) necesita persistir datos del usuario en línea sin tener
un backend. La opción estándar sería un servicio externo (Supabase,
Firebase, etc.), pero acá lo resolvemos commiteando archivos `.txt`
directamente al repo del usuario usando la **GitHub Contents API**.

**Caso de uso original:** una app de asistente académico que responde
preguntas en formato "pregunta + respuesta". El usuario quiere conservar
cada Q&A como un archivo de texto en una carpeta del repo (`qa-logs/`)
para poder bajarlos, revisarlos o borrarlos desde la web de GitHub.

---

## 2. Arquitectura

```
┌─────────────────┐     fetch (Bearer PAT)     ┌──────────────────┐
│  App (browser)  │ ─────────────────────────► │  api.github.com  │
│                 │     PUT /repos/.../contents │  (Contents API)  │
│  commitQaToGH() │                            └────────┬─────────┘
└─────────────────┘                                     │
                                                        ▼
                                              ┌──────────────────┐
                                              │  Repo del usuario │
                                              │  qa-logs/         │
                                              │    *.txt          │
                                              └──────────────────┘
```

- **Cliente:** cualquier frontend (React, Vue, Svelte, HTML+JS pelado).
  No requiere Node, ni server, ni build serverless.
- **Auth:** Personal Access Token (PAT) con `contents: write` sobre el
  repo destino. Clásico: scope `repo`. Fine-grained: permiso
  *Contents: Read and write* sobre el repo específico.
- **Persistencia del PAT:** `localStorage` del browser. Aceptable para
  herramientas personales donde el dueño de la compu es el dueño del
  repo. NO aceptable para apps públicas multiusuario.
- **Costo:** cero. La Contents API es gratuita hasta el rate limit
  (5000 requests/hora con PAT autenticado).

---

## 3. La función núcleo

Pegar en `src/lib/githubCommit.ts` (o el equivalente en tu proyecto):

```ts
export interface GitHubCommitResult {
  ok: boolean;
  url?: string;        // HTML URL del archivo en github.com
  status?: number;     // HTTP status
  message?: string;    // mensaje de error legible si !ok
}

export interface GitHubCommitOptions {
  token: string;        // PAT
  repo: string;         // "owner/name"
  branch?: string;      // default "main"
  folder?: string;      // default "qa-logs"
  filename?: string;    // default: asis66-YYYY-MM-DD-HH-MM-SS.txt
  content: string;      // contenido UTF-8
  commitMessage?: string;
}

export async function commitQaToGitHub(
  opts: GitHubCommitOptions
): Promise<GitHubCommitResult> {
  const {
    token, repo,
    branch = "main",
    folder = "qa-logs",
    filename,
    content,
    commitMessage,
  } = opts;

  const cleanToken = (token ?? "").trim();
  if (!cleanToken) return { ok: false, message: "Falta el Personal Access Token." };

  const cleanRepo = (repo ?? "").trim().replace(/^\/+|\/+$/g, "");
  if (!/^[\w.-]+\/[\w.-]+$/.test(cleanRepo)) {
    return { ok: false, message: "Repo inválido. Formato esperado: owner/name." };
  }

  const finalFilename = filename
    || `asis66-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.txt`;
  const path = `${folder.replace(/\/+$/g, "")}/${finalFilename}`;
  const message = commitMessage || `qa: ${finalFilename}`;

  // GitHub espera el contenido en base64
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
      body: JSON.stringify({ message, content: base64Content, branch }),
    });

    if (res.ok) {
      const data = (await res.json()) as { content?: { html_url?: string } };
      return { ok: true, url: data?.content?.html_url, status: res.status };
    }

    // 422: path ya existe (mismo timestamp al segundo). Devolvemos
    // ok:false con mensaje legible en vez de tirar excepción.
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
```

**Por qué funciona sin SHA:** el filename lleva timestamp con segundos
(`asis66-2026-09-06-19-30-45.txt`). Cada Q&A es un path nuevo → cada PUT
es un CREATE, nunca un UPDATE → no necesitamos mandar el SHA del archivo
existente.

**Costo en el repo:** un commit por Q&A. Si te molesta el ruido en el
historial de git, considerá un `Squash and merge` o ignorar el folder en
`git log` con `git log -- . ':!qa-logs/'`.

---

## 4. Integración en la UI

Mínimo necesario en cualquier frontend:

1. **Tres inputs en el panel de configuración:**
   - PAT (tipo `password`, no se loguea ni se muestra)
   - Repo (`owner/name`)
   - Carpeta destino (default: `qa-logs`)

2. **Un toggle** "Auto-commit a GitHub" que enciende/apaga el comportamiento.

3. **Persistencia:** los 4 valores anteriores van a `localStorage` con
   claves únicas por proyecto (ej. `gem-gh-token`, `gem-gh-repo`,
   `gem-gh-auto-commit`).

4. **Trigger en el handler de respuesta:** después de procesar la
   respuesta, si el toggle está activo y hay PAT, llamar a
   `commitQaToGitHub()` fire-and-forget. No bloquear la UI: el commit
   corre en background y un pequeño indicador muestra el estado
   ("Subiendo…" → "Commiteado ✓" o el mensaje de error).

5. **Refs espejo** (`useRef`) del estado para que el callback del handler
   vea siempre el valor actual sin re-crearse en cada render.

### Ejemplo mínimo en React

```tsx
import { commitQaToGitHub } from "./lib/githubCommit";

// refs espejo
const ghTokenRef = useRef(ghToken);
const ghRepoRef = useRef(ghRepo);
const ghFolderRef = useRef(ghFolder);
const ghAutoCommitRef = useRef(ghAutoCommit);
ghTokenRef.current = ghToken;
ghRepoRef.current = ghRepo;
ghFolderRef.current = ghFolder;
ghAutoCommitRef.current = ghAutoCommit;

// en el handler, después de procesar la respuesta
if (ghAutoCommitRef.current && ghTokenRef.current) {
  void commitQaToGitHub({
    token: ghTokenRef.current,
    repo: ghRepoRef.current,
    folder: ghFolderRef.current,
    content: formatAsTxt(qa),
  }).then((r) => console.log(r.ok ? "ok" : r.message));
}
```

---

## 5. Setup one-time del lado del usuario

1. **Generar el PAT:**
   - Clásico: <https://github.com/settings/tokens/new> → scope `repo`
   - Fine-grained (recomendado): <https://github.com/settings/personal-access-tokens/new>
     → Resource owner: el repo del usuario → Repository access: solo
     este repo → Permissions → Contents: Read and write
2. **Pegar el PAT en el campo de Configuración** la primera vez. Queda
   guardado en localStorage de ese browser.
3. **Configurar repo y carpeta destino** (defaults razonables si
   matchean el proyecto).

Después de eso: cero clicks. Cada Q&A se commitea solo.

---

## 6. Trade-offs y límites

| Tema | Detalle |
|---|---|
| **Rate limit** | 5000 req/hora con PAT. A 1 Q&A cada 30 s, son ~120/hora. Margen enorme. |
| **Repo público** | Los archivos van a quedar en un repo público si el repo lo es. Si el contenido es sensible, usá repo privado. |
| **PAT en localStorage** | Riesgo si comparten la compu. Para uso personal es OK. Para producción, mover a OAuth flow. |
| **Costo de almacenamiento** | Cada Q&A ≈ 1-2 KB. 100 Q&A ≈ 100-200 KB. Despreciable. |
| **Historial de git** | Un commit por Q&A. Si te molesta, ignorar la carpeta en `git log` o configurar squash. |
| **Concurrencia** | Si dos tabs hacen PUT al mismo path en el mismo segundo, el segundo falla con 422. La UI debe mostrar el error y seguir. |
| **Offline** | Si no hay red, el commit falla silenciosamente. La app sigue funcionando, el Q&A queda solo en local. |

---

## 7. Variantes comunes

### 7.1. Un solo archivo acumulativo (en vez de uno por Q&A)

Si preferís un solo `qa-log.md` que se actualice con cada Q&A, cambiá la
estrategia:

```ts
// 1. GET para obtener el SHA actual
const getRes = await fetch(`https://api.github.com/repos/${repo}/contents/${path}`, {
  headers: { Authorization: `Bearer ${token}` },
});
const existing = getRes.ok ? await getRes.json() : null;
const sha = existing?.sha;

// 2. Combinar contenido nuevo con el viejo
const oldContent = existing
  ? atob(existing.content.replace(/\n/g, ""))
  : "";
const newContent = oldContent + "\n\n---\n\n" + freshQaAsMarkdown(qa);

// 3. PUT con SHA si es update
await fetch(`https://api.github.com/repos/${repo}/contents/${path}`, {
  method: "PUT",
  headers: {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    message: "qa: append",
    content: btoa(unescape(encodeURIComponent(newContent))),
    sha, // undefined en el primer commit
  }),
});
```

### 7.2. Usar gist en vez de repo

Si no querés ensuciar el repo, cada Q&A puede ser un **gist**:

```ts
await fetch("https://api.github.com/gists", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    description: `qa: ${new Date().toISOString()}`,
    public: false, // secret gist
    files: { "qa.txt": { content: formatAsTxt(qa) } },
  }),
});
```

Gists secretos no aparecen en búsquedas pero sí son accesibles por URL.

### 7.3. Commit solo manual (botón, no auto)

Quitar el trigger del handler y exponer un botón "Commit Q&A actual a
GitHub" en la UI. Útil si el usuario no quiere commits por cada pregunta
sino solo confirmar manualmente.

---

## 8. Anti-patrones a evitar

- ❌ **Guardar el PAT en código fuente** o en variables de entorno del
  build. Tiene que ir a localStorage del usuario.
- ❌ **Hacer PUT sin codificar a base64.** GitHub rechaza el PUT si el
  `content` no está en base64.
- ❌ **Manejar el 422 como crash.** Es esperable (colisión de path).
  Devolver `ok: false` con un mensaje claro y seguir.
- ❌ **Usar `Authorization: token <PAT>`.** Funciona pero está
  deprecado. Usar `Authorization: Bearer <PAT>` con
  `X-GitHub-Api-Version: 2022-11-28`.
- ❌ **Bloquear la UI hasta que el commit termine.** Es fire-and-forget.
  El commit puede tardar 1-3 s en redes lentas.
- ❌ **Asumir que `getCurrentQuestion` viene siempre.** Si el modelo no
  devuelve los marcadores, la transcripción viene vacía. Mostrar
  "(sin transcripción)" en el .txt, no romper.

---

## 9. Checklist de adopción

Para integrar esta receta en otro repo:

- [ ] Copiar `commitQaToGitHub` y los tipos a `src/lib/`
- [ ] Agregar 4 claves a `localStorage` (PAT, repo, branch, folder,
      auto-commit)
- [ ] Agregar 4 inputs + 1 toggle al panel de Configuración
- [ ] Agregar 4 refs espejo en el componente principal
- [ ] Llamar `commitQaToGitHub` fire-and-forget en el handler de
      respuesta, solo si el toggle está activo y hay PAT
- [ ] Mostrar un indicador de estado (committing / ok / error) en la UI
- [ ] Persistir el toggle en `localStorage`
- [ ] Agregar un link a la carpeta del repo en la UI para que el
      usuario pueda ir a buscar los archivos
- [ ] Documentar el setup en el README del proyecto
