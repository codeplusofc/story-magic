import { strFromU8, unzipSync } from "fflate";
import pdfWorkerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";

/**
 * Lê um livro do próprio leitor (.txt, .epub ou .pdf) no navegador, sem enviar para lugar
 * nenhum e sem IA. Tudo vira o mesmo formato de texto do acervo: parágrafos separados por linha
 * em branco e títulos "Capítulo N" em linha própria, para o `splitIntoChapters` funcionar igual.
 */

export type ImportedBook = {
  text: string;
  title: string;
  author: string;
  language: "pt" | "en";
  /** Capa reduzida (JPEG em data URL, ~15 KB): imagem do EPUB ou 1ª página do PDF. */
  cover?: string;
};

type Parsed = { text: string; title?: string; author?: string; cover?: string };

/** Largura da capa guardada: basta para a estante e mantém o armazenamento pequeno. */
const COVER_WIDTH = 240;

/** Reduz uma imagem (ou canvas) para a capa guardada no navegador. */
async function shrinkCover(source: Blob | HTMLCanvasElement): Promise<string | undefined> {
  try {
    const img = source instanceof Blob ? await createImageBitmap(source) : source;
    const scale = Math.min(1, COVER_WIDTH / img.width);
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
    // Imagem muito "baixa" (faixa, logotipo) não serve de capa.
    if (canvas.height < canvas.width * 0.9) return undefined;
    return canvas.toDataURL("image/jpeg", 0.8);
  } catch {
    return undefined;
  }
}

export const ACCEPTED_EXTENSIONS = ".txt,.epub,.pdf";
/** Livros grandes em PDF passam fácil de 20 MB; acima disso o celular sofre para processar. */
const MAX_FILE_BYTES = 80 * 1024 * 1024;
/** Documento do EPUB com menos texto que isso (capa, créditos) não vira capítulo. */
const MIN_EPUB_CHAPTER_CHARS = 600;

export async function importBookFile(file: File): Promise<ImportedBook> {
  if (file.size > MAX_FILE_BYTES) throw new Error("Arquivo grande demais (máximo 80 MB).");
  const ext = file.name.toLowerCase().split(".").pop();
  const fallbackTitle = titleFromFileName(file.name);
  const buf = new Uint8Array(await file.arrayBuffer());

  let result: Parsed;
  if (ext === "txt") result = { text: parseTxt(buf) };
  else if (ext === "epub") result = await parseEpub(buf);
  else if (ext === "pdf") result = await parsePdf(buf);
  else throw new Error("Formato não suportado. Use um arquivo .txt, .epub ou .pdf.");

  const text = result.text.trim();
  if (text.length < 500) throw new Error("Não encontramos texto suficiente neste arquivo.");
  return {
    text,
    title: result.title?.trim() || fallbackTitle,
    author: result.author?.trim() || "",
    language: detectLanguage(text),
    cover: result.cover,
  };
}

function titleFromFileName(name: string): string {
  return name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim() || "Meu livro";
}

/** Conta palavras muito comuns de cada idioma no começo do texto. */
function detectLanguage(text: string): "pt" | "en" {
  const sample = ` ${text.slice(0, 60_000).toLowerCase().replace(/\s+/g, " ")} `;
  const count = (words: string[]) =>
    words.reduce((n, w) => n + (sample.split(` ${w} `).length - 1), 0);
  const pt = count(["de", "que", "não", "uma", "para", "com", "ele", "ela", "você", "mas", "os"]);
  const en = count(["the", "and", "of", "to", "was", "you", "that", "her", "his", "with", "but"]);
  return en > pt ? "en" : "pt";
}

/**
 * Parágrafos separados por linha em branco. Arquivos com um parágrafo por linha (sem linhas em
 * branco) ganham a linha em branco entre eles.
 */
function normalizeParagraphs(raw: string): string {
  const text = raw.replace(/\r\n?/g, "\n").replace(/ /g, " ");
  const lines = text.split("\n");
  const blank = lines.filter((l) => !l.trim()).length;
  const body = blank < lines.length * 0.05 ? lines.filter((l) => l.trim()).join("\n\n") : text;
  return body.replace(/\n{3,}/g, "\n\n").trim();
}

/* ------------------------------- TXT ------------------------------- */

function parseTxt(buf: Uint8Array): string {
  let text = new TextDecoder("utf-8").decode(buf);
  // Muitos .txt antigos em português estão em Windows-1252 (acentos viram "�" em UTF-8).
  const broken = (text.match(/�/g) ?? []).length;
  if (broken > 20) text = new TextDecoder("windows-1252").decode(buf);
  // Se for um .txt do próprio Gutenberg, tira a licença do começo e do fim.
  const start = text.search(/^\*\*\*\s*START OF (THE|THIS) PROJECT GUTENBERG.*$/im);
  if (start >= 0) text = text.slice(text.indexOf("\n", start) + 1);
  const end = text.search(/^\*\*\*\s*END OF (THE|THIS) PROJECT GUTENBERG.*$/im);
  if (end >= 0) text = text.slice(0, end);
  return normalizeParagraphs(text);
}

/* ------------------------------- EPUB ------------------------------ */

const BLOCK_SELECTOR = "h1,h2,h3,h4,h5,h6,p,li,blockquote,pre,dt,dd";
const CHAPTER_WORD = /^(cap[ií]tulo|chapter)\b/i;

function parseXml(source: string, type: DOMParserSupportedType): Document {
  const doc = new DOMParser().parseFromString(source, type);
  // XHTML malformado: o navegador ainda consegue ler como HTML.
  if (doc.getElementsByTagName("parsererror").length > 0 && type !== "text/html") {
    return new DOMParser().parseFromString(source, "text/html");
  }
  return doc;
}

function resolvePath(base: string, href: string): string {
  const parts = (base ? `${base}/${href}` : href).split("/");
  const out: string[] = [];
  for (const p of parts) {
    if (p === "..") out.pop();
    else if (p && p !== ".") out.push(p);
  }
  return out.join("/");
}

/** Texto de cada bloco do capítulo; itálico vira _assim_, como nos .txt do Gutenberg. */
function epubBlocks(doc: Document): { title: string; paragraphs: string[] } {
  const body = doc.body ?? doc.documentElement;
  for (const br of Array.from(body.querySelectorAll("br"))) br.replaceWith("\n");
  for (const el of Array.from(body.querySelectorAll("i,em"))) {
    const t = el.textContent ?? "";
    if (t.trim()) el.replaceWith(`_${t}_`);
  }

  // Só blocos "folha" (um <li> com <p> dentro contaria o texto duas vezes).
  const blocks = Array.from(body.querySelectorAll(BLOCK_SELECTOR)).filter(
    (el) => !el.querySelector(BLOCK_SELECTOR),
  );
  const clean = (s: string | null) => (s ?? "").replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, " ").trim();

  const items = blocks
    .map((el) => ({ heading: /^h[1-3]$/i.test(el.tagName), text: clean(el.textContent) }))
    .filter((it) => it.text);
  // Nome do capítulo: de preferência um título "Chapter X"/"Capítulo X" (antes dele pode vir o
  // nome do livro); senão, o título que abre o documento. Ele sai do corpo do texto.
  let titleAt = items.findIndex((it) => it.heading && CHAPTER_WORD.test(it.text));
  if (titleAt < 0 && items[0]?.heading) titleAt = 0;
  const title = titleAt >= 0 ? items[titleAt].text.replace(/_/g, "") : "";
  const paragraphs = items.filter((_, i) => i !== titleAt).map((it) => it.text);
  // Livros que usam só <div>: cai para o texto corrido, um parágrafo por linha.
  if (paragraphs.length === 0) {
    for (const line of (body.textContent ?? "").split("\n")) {
      const t = clean(line);
      if (t) paragraphs.push(t);
    }
  }
  return { title, paragraphs };
}

/** "Chapter 1: First Sight", "1. PRIMEIRA VISTA" → "First Sight" / "PRIMEIRA VISTA". */
function chapterSubtitle(title: string): string {
  const t = title
    .replace(/^(cap[ií]tulo|chapter)\s+[\wÀ-ú]+\s*[.:—–-]?\s*/i, "")
    .replace(/^[\dIVXLC]+\s*[.:—–-]?\s*/, "")
    .trim();
  return t.length > 70 ? `${t.slice(0, 67)}…` : t;
}

async function parseEpub(buf: Uint8Array): Promise<Parsed> {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(buf);
  } catch {
    throw new Error("Não foi possível abrir este EPUB. O arquivo pode estar corrompido.");
  }
  const read = (path: string) => (files[path] ? strFromU8(files[path]) : null);

  if (files["META-INF/encryption.xml"] && /EncryptedData/.test(read("META-INF/encryption.xml") ?? "")) {
    throw new Error(
      "Este EPUB tem proteção contra cópia (DRM) e não pode ser aberto. Use um arquivo sem proteção.",
    );
  }

  const container = read("META-INF/container.xml");
  const opfPath = container?.match(/full-path="([^"]+)"/)?.[1];
  const opfXml = opfPath ? read(opfPath) : null;
  if (!opfPath || !opfXml) throw new Error("Este arquivo não parece ser um EPUB válido.");
  const opf = parseXml(opfXml, "application/xml");
  const base = opfPath.includes("/") ? opfPath.slice(0, opfPath.lastIndexOf("/")) : "";

  const meta = (tag: string) => opf.getElementsByTagNameNS("*", tag)[0]?.textContent?.trim() ?? "";
  const manifest = new Map<string, { href: string; props: string; type: string }>();
  for (const item of Array.from(opf.getElementsByTagNameNS("*", "item"))) {
    manifest.set(item.getAttribute("id") ?? "", {
      href: item.getAttribute("href") ?? "",
      props: item.getAttribute("properties") ?? "",
      type: item.getAttribute("media-type") ?? "",
    });
  }

  // Capa: EPUB 3 marca com properties="cover-image"; EPUB 2 com <meta name="cover" content="id">.
  const coverMetaId = Array.from(opf.getElementsByTagNameNS("*", "meta"))
    .find((m) => m.getAttribute("name") === "cover")
    ?.getAttribute("content");
  const images = [...manifest.entries()].filter(([, it]) => it.type.startsWith("image/"));
  const coverItem =
    images.find(([, it]) => it.props.includes("cover-image"))?.[1] ??
    (coverMetaId ? manifest.get(coverMetaId) : undefined) ??
    images.find(([id, it]) => /cover|capa/i.test(id) || /cover|capa/i.test(it.href))?.[1];
  const coverBytes = coverItem ? files[resolvePath(base, decodeURIComponent(coverItem.href))] : undefined;
  const cover = coverBytes ? await shrinkCover(new Blob([coverBytes], { type: coverItem!.type })) : undefined;

  const out: string[] = [];
  let chapter = 0;
  for (const ref of Array.from(opf.getElementsByTagNameNS("*", "itemref"))) {
    const item = manifest.get(ref.getAttribute("idref") ?? "");
    if (!item || item.props.includes("nav")) continue;
    // Capa, créditos e sumário não são capítulos.
    if (/(^|[/_-])(cover|capa|toc|nav|copyright|creditos|sumario)[^/]*$/i.test(item.href)) continue;
    const path = resolvePath(base, decodeURIComponent(item.href.split("#")[0]));
    const source = read(path);
    if (!source) continue;

    const { title, paragraphs } = epubBlocks(parseXml(source, "application/xhtml+xml"));
    // Licença no fim dos EPUBs do Gutenberg.
    if (/project gutenberg/i.test(title)) continue;
    const chars = paragraphs.reduce((n, p) => n + p.length, 0);
    const avg = paragraphs.length ? chars / paragraphs.length : 0;
    const isChapter = chars >= MIN_EPUB_CHAPTER_CHARS && avg >= 60;

    if (isChapter) {
      chapter++;
      const sub = chapterSubtitle(title);
      out.push(`Capítulo ${chapter}${sub ? `: ${sub}` : ""}`);
      out.push(...paragraphs);
    } else if (chapter > 0 && chars > 0) {
      // Trecho curto no meio do livro (ex.: "Parte Dois"): entra no fim do capítulo anterior.
      out.push(...(title ? [title, ...paragraphs] : paragraphs));
    }
  }

  return { text: out.join("\n\n"), title: meta("title"), author: meta("creator"), cover };
}

/* ------------------------------- PDF ------------------------------- */

type PdfLine = { text: string; x: number; y: number; h: number; w: number };

async function parsePdf(buf: Uint8Array): Promise<Parsed> {
  // pdf.js tem ~1 MB: só é baixado quando alguém importa um PDF. O build "legacy" funciona em
  // celulares com navegador mais antigo.
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

  let doc;
  try {
    doc = await pdfjs.getDocument({ data: buf }).promise;
  } catch (e) {
    if (e instanceof Error && e.name === "PasswordException") {
      throw new Error("Este PDF é protegido por senha e não pode ser aberto.");
    }
    throw new Error("Não foi possível abrir este PDF. O arquivo pode estar corrompido.");
  }

  const pages: PdfLine[][] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    const lines: PdfLine[] = [];
    let cur: PdfLine | null = null;
    for (const item of content.items) {
      if (!("str" in item)) continue;
      const x = item.transform[4] as number;
      const y = item.transform[5] as number;
      const h = Math.abs(item.transform[3] as number) || item.height || 10;
      if (cur && Math.abs(cur.y - y) > h * 0.5) {
        lines.push(cur);
        cur = null;
      }
      if (!cur) cur = { text: "", x, y, h, w: 0 };
      cur.text += item.str;
      cur.w += item.width;
      cur.h = Math.max(cur.h, h);
      if (item.hasEOL) {
        lines.push(cur);
        cur = null;
      }
    }
    if (cur) lines.push(cur);
    pages.push(lines.map((l) => ({ ...l, text: l.text.replace(/\s+/g, " ").trim() })).filter((l) => l.text));
    page.cleanup();
  }

  const totalChars = pages.reduce((n, p) => n + p.reduce((m, l) => m + l.text.length, 0), 0);
  if (totalChars < doc.numPages * 80) {
    throw new Error(
      "Este PDF parece ser uma imagem escaneada, sem texto selecionável. Tente um arquivo .epub ou .txt.",
    );
  }

  // Capa: a primeira página, desenhada pequena.
  let cover: string | undefined;
  try {
    const first = await doc.getPage(1);
    const base = first.getViewport({ scale: 1 });
    const viewport = first.getViewport({ scale: (COVER_WIDTH * 2) / base.width });
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    await first.render({ canvas, canvasContext: canvas.getContext("2d")!, viewport }).promise;
    cover = await shrinkCover(canvas);
  } catch {
    // Sem capa: a estante desenha uma capa tipográfica.
  }

  const meta = await doc.getMetadata().catch(() => null);
  const info = (meta?.info ?? {}) as { Title?: string; Author?: string };
  await doc.destroy();

  return { text: pdfLinesToText(pages), title: info.Title, author: info.Author, cover };
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/** Junta as linhas do PDF em parágrafos, sem cabeçalho, rodapé e número de página. */
function pdfLinesToText(pages: PdfLine[][]): string {
  // Cabeçalho/rodapé: linhas do topo ou do fim que se repetem em muitas páginas.
  const key = (t: string) => t.toLowerCase().replace(/\d+/g, "#");
  const edgeCount = new Map<string, number>();
  for (const lines of pages) {
    for (const l of [...lines.slice(0, 2), ...lines.slice(-2)]) {
      edgeCount.set(key(l.text), (edgeCount.get(key(l.text)) ?? 0) + 1);
    }
  }
  const repeated = (t: string) => pages.length >= 6 && (edgeCount.get(key(t)) ?? 0) >= pages.length * 0.3;
  const isPageNumber = (t: string) => /^(p[aá]g(ina)?\.?\s*)?[\divxlc]{1,5}$/i.test(t);

  const all = pages.flat();
  const bodyH = median(all.map((l) => l.h));
  const typicalW = median(all.map((l) => l.w));
  // Margem esquerda = onde a maioria das linhas do corpo começa (cabeçalho e rodapé costumam
  // ficar mais à esquerda e não podem servir de referência para o recuo de parágrafo).
  const xCount = new Map<number, number>();
  for (const l of all) {
    if (Math.abs(l.h - bodyH) <= 1) xCount.set(Math.round(l.x), (xCount.get(Math.round(l.x)) ?? 0) + 1);
  }
  const minX = [...xCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;
  const gaps: number[] = [];
  for (const lines of pages) {
    for (let i = 1; i < lines.length; i++) {
      const g = lines[i - 1].y - lines[i].y;
      if (g > 0) gaps.push(g);
    }
  }
  const lineGap = median(gaps) || bodyH * 1.2;

  const paragraphs: string[] = [];
  let para = "";
  const flush = () => {
    if (para.trim()) paragraphs.push(para.trim());
    para = "";
  };
  const append = (t: string) => {
    if (!para) para = t;
    // Palavra hifenizada no fim da linha: "vam-" + "piro" = "vampiro".
    else if (/[A-Za-zÀ-ú]-$/.test(para) && /^[a-zà-ú]/.test(t)) para = para.slice(0, -1) + t;
    else para += ` ${t}`;
  };
  let chapter = 0;

  for (const lines of pages) {
    let prev: PdfLine | null = null;
    lines.forEach((l, i) => {
      const atEdge = i < 2 || i >= lines.length - 2;
      if (atEdge && (repeated(l.text) || (isPageNumber(l.text) && l.h <= bodyH * 1.2))) return;

      // Fonte bem maior que o corpo: título. Número sozinho em fonte grande = começo de capítulo.
      if (l.h > bodyH * 1.35 && l.text.length <= 80) {
        flush();
        if (/^\d{1,3}$/.test(l.text) || /^(cap[ií]tulo|chapter)\b/i.test(l.text)) {
          chapter++;
          paragraphs.push(`Capítulo ${chapter}`);
        } else if (/^capítulo \d+$/i.test(paragraphs[paragraphs.length - 1] ?? "")) {
          paragraphs[paragraphs.length - 1] += `: ${chapterSubtitle(l.text)}`;
        } else {
          paragraphs.push(l.text);
        }
        prev = null;
        return;
      }

      if (prev) {
        const gap = prev.y - l.y;
        const indented = l.x > minX + bodyH * 0.8;
        const prevEnds = /[.!?…:"”»]$/.test(prev.text) && prev.w < typicalW * 0.85;
        if (gap > lineGap * 1.45 || indented || prevEnds) flush();
      } else if (/[.!?…"”»]$/.test(para)) {
        // Página nova: o parágrafo só continua se a frase anterior ficou pela metade.
        flush();
      }
      append(l.text);
      prev = l;
    });
  }
  flush();
  return paragraphs.join("\n\n");
}
