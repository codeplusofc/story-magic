/**
 * Card para compartilhar (Stories, TikTok, WhatsApp): uma fala de personagem ou uma citação do
 * livro, desenhada no próprio navegador num canvas 1080×1350 (formato 4:5 do Instagram).
 */

export type ShareCardInput = {
  kind: "chat" | "quote";
  bookTitle: string;
  bookAuthor: string;
  coverUrl?: string;
  /** Fala (chat) ou trecho do livro (citação). */
  text: string;
  /** Só no chat: quem fala e a pergunta do leitor que veio antes. */
  characterName?: string;
  characterRole?: string;
  characterColor?: string;
  question?: string;
  /** Só na citação: capítulo de onde saiu. */
  chapterLabel?: string;
};

const W = 1080;
const H = 1350;
const PAD = 96;
const SERIF = '"Literata", Georgia, serif';
const SANS = '"Plus Jakarta Sans", system-ui, sans-serif';

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    // Capa de outro site sem CORS "suja" o canvas e impede exportar a imagem: aí fica sem capa.
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
    window.setTimeout(() => resolve(null), 5000);
  });
}

function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const para of text.split(/\n+/)) {
    let line = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const test = line ? `${line} ${word}` : word;
      if (ctx.measureText(test).width > maxWidth && line) {
        lines.push(line);
        line = word;
      } else {
        line = test;
      }
    }
    if (line) lines.push(line);
  }
  return lines;
}

/** Maior fonte (entre max e min) em que o texto cabe na altura; corta com "…" se nem assim couber. */
function fitText(
  ctx: CanvasRenderingContext2D,
  text: string,
  font: (size: number) => string,
  maxWidth: number,
  maxHeight: number,
  max: number,
  min: number,
): { lines: string[]; size: number; lineHeight: number } {
  for (let size = max; size >= min; size -= 2) {
    ctx.font = font(size);
    const lines = wrap(ctx, text, maxWidth);
    const lineHeight = size * 1.42;
    if (lines.length * lineHeight <= maxHeight) return { lines, size, lineHeight };
  }
  ctx.font = font(min);
  const lineHeight = min * 1.42;
  const all = wrap(ctx, text, maxWidth);
  const lines = all.slice(0, Math.max(1, Math.floor(maxHeight / lineHeight)));
  if (lines.length < all.length) lines[lines.length - 1] = `${lines[lines.length - 1].replace(/[\s,.;:]+$/, "")}…`;
  return { lines, size: min, lineHeight };
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

const clean = (t: string) => t.replace(/_/g, "").replace(/\s+/g, " ").trim();

export async function renderShareCard(input: ShareCardInput): Promise<Blob> {
  await document.fonts?.ready;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;

  // Fundo: o mesmo tom "biblioteca à meia-luz" do app.
  const bg = ctx.createLinearGradient(0, 0, W * 0.4, H);
  bg.addColorStop(0, "#241b14");
  bg.addColorStop(1, "#0c0a08");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);
  const glow = ctx.createRadialGradient(W * 0.85, 0, 0, W * 0.85, 0, W * 0.9);
  glow.addColorStop(0, "rgba(228, 184, 106, 0.22)");
  glow.addColorStop(1, "rgba(228, 184, 106, 0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  // Cabeçalho: capa + título e autor.
  const coverW = 150;
  const coverH = 225;
  const cover = input.coverUrl ? await loadImage(input.coverUrl) : null;
  ctx.save();
  roundRect(ctx, PAD, PAD, coverW, coverH, 14);
  ctx.clip();
  if (cover) {
    const scale = Math.max(coverW / cover.width, coverH / cover.height);
    const dw = cover.width * scale;
    const dh = cover.height * scale;
    ctx.drawImage(cover, PAD + (coverW - dw) / 2, PAD + (coverH - dh) / 2, dw, dh);
  } else {
    const cg = ctx.createLinearGradient(PAD, PAD, PAD + coverW, PAD + coverH);
    cg.addColorStop(0, "#3a2e26");
    cg.addColorStop(1, "#120d0a");
    ctx.fillStyle = cg;
    ctx.fillRect(PAD, PAD, coverW, coverH);
    ctx.fillStyle = "#e4b86a";
    ctx.font = `600 60px ${SERIF}`;
    ctx.textAlign = "center";
    ctx.fillText("✦", PAD + coverW / 2, PAD + coverH / 2 + 20);
    ctx.textAlign = "left";
  }
  ctx.restore();

  const headX = PAD + coverW + 44;
  const headW = W - headX - PAD;
  ctx.fillStyle = "#e4b86a";
  ctx.font = `700 26px ${SANS}`;
  ctx.fillText((input.kind === "chat" ? "CONVERSEI COM" : "UM TRECHO DE").split("").join(" "), headX, PAD + 44);
  const titleFit = fitText(ctx, clean(input.kind === "chat" ? input.characterName ?? input.bookTitle : input.bookTitle), (s) => `600 ${s}px ${SERIF}`, headW, 130, 62, 40);
  ctx.fillStyle = "#f5f0e8";
  titleFit.lines.forEach((l, i) => ctx.fillText(l, headX, PAD + 108 + i * titleFit.lineHeight));
  ctx.fillStyle = "#9c948a";
  ctx.font = `500 28px ${SANS}`;
  const sub =
    input.kind === "chat"
      ? `${clean(input.bookTitle)} · ${clean(input.bookAuthor)}`
      : `${clean(input.bookAuthor)}${input.chapterLabel ? ` · ${clean(input.chapterLabel)}` : ""}`;
  wrap(ctx, sub, headW)
    .slice(0, 2)
    .forEach((l, i) => ctx.fillText(l, headX, PAD + 116 + titleFit.lines.length * titleFit.lineHeight + i * 38));

  // Corpo.
  // Corpo: mede primeiro e centraliza na altura livre entre o cabeçalho e o rodapé.
  const top = PAD + coverH + 90;
  const bodyW = W - PAD * 2;
  const footerTop = H - PAD - 60;
  const room = footerTop - 70 - top;

  if (input.kind === "chat") {
    ctx.font = `500 32px ${SANS}`;
    const q = input.question ? wrap(ctx, clean(input.question), bodyW - 120).slice(0, 3) : [];
    const qh = q.length ? q.length * 44 + 48 : 0;
    const qw = q.length ? Math.min(bodyW, Math.max(...q.map((l) => ctx.measureText(l).width)) + 64) : 0;
    const qGap = q.length ? 48 : 0;
    const fit = fitText(ctx, clean(input.text), (sz) => `500 ${sz}px ${SANS}`, bodyW - 96, room - qh - qGap - 80 - 60, 46, 28);
    const bh = fit.lines.length * fit.lineHeight + 80;
    const total = qh + qGap + bh + 60;
    let y = top + Math.max(0, (room - total) / 2);

    if (q.length) {
      ctx.font = `500 32px ${SANS}`;
      ctx.fillStyle = "#e4b86a";
      roundRect(ctx, W - PAD - qw, y, qw, qh, 30);
      ctx.fill();
      ctx.fillStyle = "#1c140c";
      q.forEach((l, i) => ctx.fillText(l, W - PAD - qw + 32, y + 56 + i * 44));
      y += qh + qGap;
    }

    // Balão do personagem.
    const color = input.characterColor ?? "#c9a88c";
    ctx.fillStyle = "rgba(255, 248, 235, 0.07)";
    roundRect(ctx, PAD, y, bodyW, bh, 34);
    ctx.fill();
    ctx.fillStyle = color;
    ctx.fillRect(PAD, y + 30, 6, bh - 60);
    ctx.fillStyle = "#f5f0e8";
    ctx.font = `500 ${fit.size}px ${SANS}`;
    fit.lines.forEach((l, i) => ctx.fillText(l, PAD + 48, y + 40 + fit.size + i * fit.lineHeight));
    ctx.fillStyle = color;
    ctx.font = `700 28px ${SANS}`;
    ctx.fillText(`— ${clean(input.characterName ?? "")}`, PAD + 48, y + bh + 50);
  } else {
    // Citação com aspas grandes.
    const fit = fitText(ctx, clean(input.text), (sz) => `italic 400 ${sz}px ${SERIF}`, bodyW, room - 150, 60, 32);
    const total = 150 + fit.lines.length * fit.lineHeight;
    const y = top + Math.max(0, (room - total) / 2);
    ctx.fillStyle = "rgba(228, 184, 106, 0.5)";
    ctx.font = `600 220px ${SERIF}`;
    ctx.fillText("“", PAD - 12, y + 150);
    ctx.fillStyle = "#f5f0e8";
    ctx.font = `italic 400 ${fit.size}px ${SERIF}`;
    fit.lines.forEach((l, i) => ctx.fillText(l, PAD, y + 150 + i * fit.lineHeight));
  }

  // Rodapé: marca.
  ctx.fillStyle = "rgba(220, 190, 150, 0.16)";
  ctx.fillRect(PAD, footerTop, bodyW, 2);
  ctx.fillStyle = "#e4b86a";
  ctx.font = `600 40px ${SERIF}`;
  ctx.fillText("✦ Storyverse", PAD, footerTop + 60);
  ctx.fillStyle = "#9c948a";
  ctx.font = `500 26px ${SANS}`;
  ctx.textAlign = "right";
  ctx.fillText(input.kind === "chat" ? "Converse com quem vive no livro" : "Leia e converse com os personagens", W - PAD, footerTop + 56);
  ctx.textAlign = "left";

  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Não foi possível gerar a imagem."))), "image/png"),
  );
}

/** Compartilha pelo menu do celular (quando dá) ou baixa a imagem. */
export async function shareOrDownload(blob: Blob, fileName: string, text: string): Promise<"shared" | "downloaded"> {
  const file = new File([blob], fileName, { type: "image/png" });
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
  if (nav.canShare?.({ files: [file] })) {
    try {
      await nav.share({ files: [file], text });
      return "shared";
    } catch (e) {
      // Cancelou o menu: não baixa por cima.
      if (e instanceof DOMException && e.name === "AbortError") return "shared";
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
  return "downloaded";
}
