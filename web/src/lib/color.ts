/* Акцентный цвет из обложки: берём самый «живой» цвет, а не просто средний. */
const cache = new Map<string, string>();
const DEFAULT_ACCENT = "124 92 255";

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h * 60, s, l];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

export async function extractAccent(url: string | null): Promise<string> {
  if (!url) return DEFAULT_ACCENT;
  const hit = cache.get(url);
  if (hit) return hit;
  try {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.decoding = "async";
    img.src = url;
    await img.decode();
    const size = 24;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(img, 0, 0, size, size);
    const { data } = ctx.getImageData(0, 0, size, size);

    // Гистограмма по оттенкам, вес = насыщенность × «не слишком тёмный/светлый»
    const buckets = new Map<number, { w: number; r: number; g: number; b: number }>();
    for (let i = 0; i < data.length; i += 4) {
      const [h, s, l] = rgbToHsl(data[i], data[i + 1], data[i + 2]);
      const w = s * (1 - Math.abs(l - 0.5) * 1.6);
      if (w <= 0.05) continue;
      const key = Math.round(h / 20);
      const bucket = buckets.get(key) ?? { w: 0, r: 0, g: 0, b: 0 };
      bucket.w += w;
      bucket.r += data[i] * w;
      bucket.g += data[i + 1] * w;
      bucket.b += data[i + 2] * w;
      buckets.set(key, bucket);
    }
    let best: { w: number; r: number; g: number; b: number } | null = null;
    for (const b of buckets.values()) if (!best || b.w > best.w) best = b;

    let rgb: [number, number, number];
    if (!best || best.w < 2) {
      rgb = [124, 92, 255]; // монохромная обложка — фирменный фиолетовый
    } else {
      const [h, s] = rgbToHsl(best.r / best.w, best.g / best.w, best.b / best.w);
      // Нормализуем: достаточно яркий, чтобы читаться на тёмном фоне
      rgb = hslToRgb(h, Math.max(0.55, Math.min(s, 0.9)), 0.6);
    }
    const value = rgb.join(" ");
    cache.set(url, value);
    return value;
  } catch {
    return DEFAULT_ACCENT;
  }
}

export function applyAccent(rgb: string) {
  document.documentElement.style.setProperty("--accent-rgb", rgb);
}
