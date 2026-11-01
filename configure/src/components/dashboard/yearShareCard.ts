import { tmdbSized } from "./art";
import { byWatchTime, displayName, finishedShows, formatDay, formatHour, genreShares, hoursOf, topShowOf, yearTime, type YearModel } from "./yearModel";

export const CARD_WIDTH = 1080;
export const CARD_HEIGHT = 1350;

const PAD = 64;
const GAP = 22;
const FONT = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
const INK = "#f4f5f7";
const SOFT = "#c4c8ce";
const MUTED = "#a3a8b0";
const QUIET = "#9ca1a9";
const GROUND = "#0c0d0f";
const GOLD = "#fbbf24";
const TILE = "rgba(255,255,255,0.055)";
const TILE_EDGE = "rgba(255,255,255,0.08)";
const POSTERS = 8;
const NETWORKS = 5;

type Ctx = CanvasRenderingContext2D;
export type ArtLoader = (url: string) => Promise<Blob | null>;

interface TextStyle {
  size: number;
  weight: number;
  color: string;
  track?: number;
  align?: CanvasTextAlign;
  maxWidth?: number;
}

const font = (size: number, weight: number): string => `${weight} ${size}px ${FONT}`;

function setTrack(ctx: Ctx, px: number): boolean {
  if (!("letterSpacing" in ctx)) return false;
  (ctx as Ctx & { letterSpacing: string }).letterSpacing = `${px}px`;
  return true;
}

function fitted(ctx: Ctx, text: string, maxWidth: number | undefined): string {
  if (!maxWidth || ctx.measureText(text).width <= maxWidth) return text;
  let cut = text;
  while (cut.length > 1 && ctx.measureText(`${cut}…`).width > maxWidth) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}…`;
}

function text(ctx: Ctx, value: string, x: number, y: number, style: TextStyle): number {
  ctx.save();
  ctx.font = font(style.size, style.weight);
  ctx.fillStyle = style.color;
  ctx.textAlign = style.align ?? "left";
  ctx.textBaseline = "alphabetic";
  const track = style.track ?? 0;
  const native = setTrack(ctx, track);
  const shown = fitted(ctx, value, style.maxWidth);
  if (native || !track) {
    ctx.fillText(shown, x, y);
  } else {
    const width = [...shown].reduce((sum, char) => sum + ctx.measureText(char).width + track, -track);
    let at = ctx.textAlign === "right" ? x - width : ctx.textAlign === "center" ? x - width / 2 : x;
    ctx.textAlign = "left";
    for (const char of shown) {
      ctx.fillText(char, at, y);
      at += ctx.measureText(char).width + track;
    }
  }
  const width = ctx.measureText(shown).width;
  ctx.restore();
  return width;
}

function rounded(ctx: Ctx, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  if (typeof ctx.roundRect === "function") {
    ctx.roundRect(x, y, w, h, r);
    return;
  }
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function tile(ctx: Ctx, x: number, y: number, w: number, h: number, r: number): void {
  rounded(ctx, x, y, w, h, r);
  ctx.fillStyle = TILE;
  ctx.fill();
  rounded(ctx, x + 0.5, y + 0.5, w - 1, h - 1, r);
  ctx.strokeStyle = TILE_EDGE;
  ctx.lineWidth = 1;
  ctx.stroke();
}

function cover(ctx: Ctx, image: CanvasImageSource & { width: number; height: number }, x: number, y: number, w: number, h: number, fx = 0.5, fy = 0.5): void {
  const scale = Math.max(w / image.width, h / image.height);
  const sw = w / scale;
  const sh = h / scale;
  ctx.drawImage(image, (image.width - sw) * fx, (image.height - sh) * fy, sw, sh, x, y, w, h);
}

function filtersWork(ctx: Ctx): boolean {
  if (!("filter" in ctx)) return false;
  ctx.filter = "blur(2px)";
  const works = ctx.filter === "blur(2px)";
  ctx.filter = "none";
  return works;
}

function whitened(image: HTMLImageElement): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(image, 0, 0);
  ctx.globalCompositeOperation = "source-in";
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  return canvas;
}

function paintedYear(year: string, art: HTMLImageElement | null): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = 660;
  canvas.height = 190;
  const ctx = canvas.getContext("2d")!;
  ctx.font = font(200, 900);
  ctx.textBaseline = "alphabetic";
  const native = setTrack(ctx, -14);
  ctx.fillStyle = "#ffffff";
  if (native) {
    ctx.fillText(year, 0, 164);
  } else {
    let at = 0;
    for (const char of year) {
      ctx.fillText(char, at, 164);
      at += ctx.measureText(char).width - 14;
    }
  }
  ctx.globalCompositeOperation = "source-in";
  if (art) cover(ctx, art, 0, 0, canvas.width, canvas.height, 0.5, 0.3);
  else {
    ctx.fillStyle = "#e5e7eb";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  ctx.globalCompositeOperation = "source-atop";
  const sheen = ctx.createLinearGradient(0, 0, 0, canvas.height * 0.75);
  sheen.addColorStop(0, "rgba(255,255,255,0.35)");
  sheen.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = sheen;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  return canvas;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n === 1 ? one : many}`;

/** Draws the year as a 1080 × 1350 card and hands it back as a PNG. */
export async function drawShareCard(model: YearModel, owner: string, load: ArtLoader): Promise<Blob> {
  const data = model.data;
  const titles = data.titles;
  const topShow = topShowOf(model);
  const lead = topShow ?? byWatchTime(model)[0] ?? null;
  const face = data.people?.cast[0] ?? null;
  const posters = [...titles].filter((title) => title !== lead && title.facts?.poster).sort((a, b) => b.watchMs - a.watchMs).slice(0, POSTERS);
  const networks = (data.people?.networks ?? []).filter((network) => network.logo).slice(0, NETWORKS);
  const time = yearTime(model);
  const scores = titles.map((title) => model.ratings[title.key]).filter((score): score is number => typeof score === "number");

  const urls: string[] = [];
  const image = async (url: string | null | undefined, size: string): Promise<HTMLImageElement | null> => {
    if (!url) return null;
    const blob = await load(tmdbSized(url, size)).catch(() => null);
    if (!blob) return null;
    const src = URL.createObjectURL(blob);
    urls.push(src);
    const element = new Image();
    element.src = src;
    return element.decode().then(() => element, () => null);
  };
  const [backdrop, logo, photo, posterArt, networkArt] = await Promise.all([
    image(lead?.facts?.background ?? lead?.facts?.poster, "w1280"),
    image(lead?.facts?.logo, "w500"),
    image(face?.photo, "w185"),
    Promise.all(posters.map((title) => image(title.facts?.poster, "w342"))),
    Promise.all(networks.map((network) => image(network.logo, "w300"))),
  ]);

  try {
    const canvas = document.createElement("canvas");
    canvas.width = CARD_WIDTH;
    canvas.height = CARD_HEIGHT;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = GROUND;
    ctx.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT);

    if (backdrop) {
      ctx.save();
      if (filtersWork(ctx)) {
        ctx.filter = "blur(60px) saturate(1.5)";
        ctx.globalAlpha = 0.4;
      } else {
        ctx.globalAlpha = 0.16;
      }
      cover(ctx, backdrop, -108, -135, CARD_WIDTH * 1.2, CARD_HEIGHT * 0.55);
      ctx.restore();
    }

    const inner = CARD_WIDTH - PAD * 2;
    let y = PAD;
    text(ctx, `${owner} · year in review`.toUpperCase(), PAD, y + 16, { size: 16, weight: 500, color: SOFT, track: 3.2, maxWidth: 620 });
    ctx.drawImage(paintedYear(String(model.year), backdrop), PAD - 8, y + 22);
    text(ctx, hoursOf(data.totals.watchMs).toLocaleString(), CARD_WIDTH - PAD, y + 150, { size: 64, weight: 900, color: INK, track: -2.5, align: "right" });
    text(ctx, "HOURS WATCHED", CARD_WIDTH - PAD, y + 178, { size: 15, weight: 500, color: MUTED, track: 1.8, align: "right" });
    y += 206 + GAP;

    const finished = finishedShows(model);
    const stats: Array<[number, string]> = [
      [data.totals.plays, plural(data.totals.plays, "play")],
      [data.totals.films.titles, plural(data.totals.films.titles, "film")],
      [data.totals.shows.plays, plural(data.totals.shows.plays, "episode")],
      [finished, finished === 1 ? "show finished" : "shows finished"],
    ];
    const statW = (inner - 14 * 3) / 4;
    stats.forEach(([value, label], i) => {
      const x = PAD + i * (statW + 14);
      tile(ctx, x, y, statW, 104, 22);
      text(ctx, value.toLocaleString(), x + 20, y + 58, { size: 40, weight: 800, color: INK, track: -1.2, maxWidth: statW - 40 });
      text(ctx, label, x + 20, y + 84, { size: 14, weight: 400, color: MUTED });
    });
    y += 104 + GAP;

    const footerH = 44;
    const posterW = (inner - 12 * (POSTERS - 1)) / POSTERS;
    const postersH = 24 + posterW * 1.5;
    const mainH = CARD_HEIGHT - PAD - footerH - GAP - postersH - GAP - y;
    const leftW = (inner - 14) * (1.25 / 2.25);
    const rightX = PAD + leftW + 14;
    const rightW = inner - leftW - 14;

    ctx.save();
    rounded(ctx, PAD, y, leftW, mainH, 26);
    ctx.clip();
    ctx.fillStyle = "#16181c";
    ctx.fillRect(PAD, y, leftW, mainH);
    if (backdrop) cover(ctx, backdrop, PAD, y, leftW, mainH, 0.65, 0.5);
    const shade = ctx.createLinearGradient(0, y + mainH, 0, y);
    shade.addColorStop(0.25, "rgba(12,13,15,0.96)");
    shade.addColorStop(0.8, "rgba(12,13,15,0.1)");
    ctx.fillStyle = shade;
    ctx.fillRect(PAD, y, leftW, mainH);
    ctx.restore();

    const leadX = PAD + 28;
    const leadW = leftW - 56;
    const leadValue = topShow ? topShow.plays.length.toLocaleString() : `${hoursOf(lead?.watchMs ?? 0)}h`;
    const leadUnit = topShow ? plural(topShow.plays.length, "episode") : "watched";
    const numberY = y + mainH - 34;
    const numberW = text(ctx, leadValue, leadX, numberY, { size: 64, weight: 900, color: INK, track: -3.2 });
    text(ctx, leadUnit, leadX + numberW + 10, numberY, { size: 20, weight: 600, color: SOFT });
    let top = numberY - 64 - 18;
    if (logo) {
      const logoW = Math.min(leadW * 0.78, logo.width * (140 / logo.height));
      const logoH = logo.height * (logoW / logo.width);
      ctx.drawImage(logo, leadX, top - logoH, logoW, logoH);
      top -= logoH + 12;
    } else if (lead) {
      text(ctx, displayName(lead), leadX, top - 8, { size: 40, weight: 800, color: INK, track: -1, maxWidth: leadW });
      top -= 52;
    }
    text(ctx, topShow ? "NUMBER ONE SHOW" : "MOST WATCHED", leadX, top - 4, { size: 13, weight: 700, color: GOLD, track: 2.3 });

    let ry = y;
    const faceH = 136;
    const bottomH = 104;
    tile(ctx, rightX, ry, rightW, faceH, 26);
    if (face) {
      const cx = rightX + 22 + 46;
      const cy = ry + faceH / 2;
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, 50, 0, Math.PI * 2);
      ctx.fillStyle = GOLD;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(cx, cy, 46, 0, Math.PI * 2);
      ctx.clip();
      ctx.fillStyle = "#26282d";
      ctx.fillRect(cx - 46, cy - 46, 92, 92);
      if (photo) cover(ctx, photo, cx - 46, cy - 46, 92, 92, 0.5, 0.25);
      ctx.restore();
      const tx = rightX + 22 + 92 + 18;
      const tw = rightW - (tx - rightX) - 18;
      text(ctx, "FACE OF THE YEAR", tx, ry + 46, { size: 12, weight: 500, color: QUIET, track: 1.9 });
      text(ctx, face.name, tx, ry + 80, { size: 26, weight: 800, color: INK, track: -0.5, maxWidth: tw });
      text(ctx, face.voiced ? `voiced ${face.titles} of your shows` : `in ${face.titles} of your titles`, tx, ry + 102, { size: 14, weight: 400, color: MUTED, maxWidth: tw });
    }
    ry += faceH + 14;

    const genresH = mainH - faceH - bottomH - 28;
    tile(ctx, rightX, ry, rightW, genresH, 26);
    text(ctx, "TOP GENRES", rightX + 22, ry + 34, { size: 12, weight: 500, color: QUIET, track: 1.9 });
    const genres = genreShares(model, 3);
    const rowH = (genresH - 60) / 3;
    genres.forEach(([name, pct], i) => {
      const gy = ry + 52 + i * rowH + rowH / 2;
      text(ctx, name, rightX + 22, gy, { size: 18, weight: 600, color: INK, maxWidth: rightW - 110 });
      text(ctx, `${pct}%`, rightX + rightW - 22, gy, { size: 18, weight: 500, color: MUTED, align: "right" });
      rounded(ctx, rightX + 22, gy + 12, rightW - 44, 8, 4);
      ctx.fillStyle = "rgba(255,255,255,0.08)";
      ctx.fill();
      const fill = Math.max(8, ((rightW - 44) * pct) / 100);
      rounded(ctx, rightX + 22, gy + 12, fill, 8, 4);
      if (i === 0) {
        const bar = ctx.createLinearGradient(rightX + 22, 0, rightX + 22 + fill, 0);
        bar.addColorStop(0, "#2563eb");
        bar.addColorStop(1, "#60a5fa");
        ctx.fillStyle = bar;
      } else {
        ctx.fillStyle = "rgba(147,197,253,0.6)";
      }
      ctx.fill();
    });
    ry += genresH + 14;

    tile(ctx, rightX, ry, rightW, bottomH, 26);
    const facts: Array<[string, string, string]> = [
      ["PEAK HOUR", time.rhythm > 0 ? formatHour(time.peakHour) : "–", INK],
      ["STREAK", `${time.streak.length} ${plural(time.streak.length, "day")}`, INK],
      scores.length ? ["RATED", (scores.reduce((sum, score) => sum + score, 0) / scores.length).toFixed(1), "#fcd34d"] : ["DAYS", time.activeDays.toLocaleString(), INK],
    ];
    const room = rightW - 44;
    const measure = (size: number) => facts.map(([label, value]) => {
      ctx.font = font(size, 800);
      const valueW = ctx.measureText(value).width;
      ctx.font = font(12, 500);
      return Math.max(valueW, ctx.measureText(label).width + label.length * 1.9);
    });
    let factSize = 30;
    let widths = measure(factSize);
    while (factSize > 20 && widths.reduce((sum, w) => sum + w, 0) + 16 * (facts.length - 1) > room) widths = measure((factSize -= 2));
    const spacing = (room - widths.reduce((sum, w) => sum + w, 0)) / (facts.length - 1);
    let fx = rightX + 22;
    facts.forEach(([label, value, color], i) => {
      text(ctx, label, fx, ry + 38, { size: 12, weight: 500, color: QUIET, track: 1.9 });
      text(ctx, value, fx, ry + 76, { size: factSize, weight: 800, color, maxWidth: widths[i] + 4 });
      fx += widths[i] + spacing;
    });
    y += mainH + GAP;

    text(ctx, "ALSO ON REPEAT", PAD, y + 12, { size: 12, weight: 500, color: QUIET, track: 1.9 });
    const py = y + 24;
    for (let i = 0; i < POSTERS; i += 1) {
      const px = PAD + i * (posterW + 12);
      ctx.save();
      rounded(ctx, px, py, posterW, posterW * 1.5, 12);
      ctx.clip();
      ctx.fillStyle = "#1a1c20";
      ctx.fillRect(px, py, posterW, posterW * 1.5);
      const art = posterArt[i];
      if (art) cover(ctx, art, px, py, posterW, posterW * 1.5);
      ctx.restore();
      rounded(ctx, px + 0.5, py + 0.5, posterW - 1, posterW * 1.5 - 1, 12);
      ctx.strokeStyle = "rgba(255,255,255,0.1)";
      ctx.stroke();
    }
    y += postersH + GAP;

    ctx.fillStyle = "rgba(255,255,255,0.08)";
    ctx.fillRect(PAD, y, inner, 1);
    let lx = PAD;
    for (const art of networkArt) {
      if (!art) continue;
      const lh = 22;
      const lw = Math.min(100, art.width * (lh / art.height));
      const drawnH = art.height * (lw / art.width);
      ctx.save();
      ctx.globalAlpha = 0.8;
      ctx.drawImage(whitened(art), lx, y + 20 + (lh - drawnH) / 2, lw, drawnH);
      ctx.restore();
      lx += lw + 26;
    }
    const through = model.partial ? formatDay(model.year, model.through) : formatDay(model.year, model.days - 1);
    text(ctx, `${formatDay(model.year, 0)} to ${through}, ${model.year}`, CARD_WIDTH - PAD, y + 36, { size: 14, weight: 400, color: "#8f949c", align: "right" });

    return await new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("The card could not be drawn"))), "image/png"));
  } finally {
    for (const src of urls) URL.revokeObjectURL(src);
  }
}
