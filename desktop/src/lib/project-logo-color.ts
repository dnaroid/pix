/**
 * Pick a representative identity color from logo pixels (RGBA, row-major).
 *
 * Prefers the most *vivid prominent* hue: near-transparent, near-black,
 * near-white and gray pixels are ignored, and each remaining pixel is weighted
 * by its saturation, so a dark background does not win over the symbol.
 * A nearly colorless image falls back to its most frequent quantized color.
 */
export function vividLogoColor(pixels: ArrayLike<number>): string | undefined {
  const HUE_BINS = 36;
  const bins = Array.from({ length: HUE_BINS }, () => ({ weight: 0, r: 0, g: 0, b: 0 }));
  const frequent = new Map<number, { count: number; r: number; g: number; b: number }>();

  for (let index = 0; index + 3 < pixels.length; index += 4) {
    const r = pixels[index]!;
    const g = pixels[index + 1]!;
    const b = pixels[index + 2]!;
    const a = pixels[index + 3]!;
    if (a < 128) continue;

    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const bucket = frequent.get(key) ?? { count: 0, r: 0, g: 0, b: 0 };
    bucket.count += 1; bucket.r += r; bucket.g += g; bucket.b += b;
    frequent.set(key, bucket);

    const { h, s, l } = rgbToHsl(r, g, b);
    if (l < 0.18 || l > 0.9 || s < 0.25) continue;
    const bin = bins[Math.min(HUE_BINS - 1, Math.floor((h / 360) * HUE_BINS))]!;
    const weight = s * s;
    bin.weight += weight; bin.r += r * weight; bin.g += g * weight; bin.b += b * weight;
  }

  let best = bins[0]!;
  for (const bin of bins) if (bin.weight > best.weight) best = bin;
  if (best.weight > 0) return toHex(best.r / best.weight, best.g / best.weight, best.b / best.weight);

  let top: { count: number; r: number; g: number; b: number } | undefined;
  for (const bucket of frequent.values()) if (!top || bucket.count > top.count) top = bucket;
  return top ? toHex(top.r / top.count, top.g / top.count, top.b / top.count) : undefined;
}

/** Decode a logo data URL off-screen at 32×32 and return its vivid color. */
export async function vividColorFromImageUrl(url: string): Promise<string | undefined> {
  const image = new Image();
  image.decoding = "async";
  image.src = url;
  await image.decode();
  const size = 32;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return undefined;
  context.drawImage(image, 0, 0, size, size);
  return vividLogoColor(context.getImageData(0, 0, size, size).data);
}

function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const delta = max - min;
  if (delta === 0) return { h: 0, s: 0, l };
  const s = delta / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === rn) h = ((gn - bn) / delta) % 6;
  else if (max === gn) h = (bn - rn) / delta + 2;
  else h = (rn - gn) / delta + 4;
  h *= 60;
  if (h < 0) h += 360;
  return { h, s, l };
}

function toHex(r: number, g: number, b: number): string {
  const part = (value: number) => Math.round(Math.max(0, Math.min(255, value))).toString(16).padStart(2, "0");
  return `#${part(r)}${part(g)}${part(b)}`;
}
