export type RGB = [number, number, number];

export const defaultThemeColor = "#39745C";

export function normalizeThemeColor(value: unknown): string | null {
  return typeof value === "string" && /^#[\da-f]{6}$/i.test(value) ? value.toUpperCase() : null;
}

export function hexToRgb(color: string): RGB {
  const value = Number.parseInt(color.slice(1), 16);
  return [value >> 16, value >> 8 & 255, value & 255];
}

export function rgbToHex(rgb: RGB): string {
  return `#${rgb.map((channel) => channel.toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

export function themeColorStyle(color: string | null, dark: boolean): Record<string, string> {
  const rgb = hexToRgb(color ?? defaultThemeColor);
  const luma = .2126 * rgb[0] + .7152 * rgb[1] + .0722 * rgb[2];
  const brightness = luma / 255 - .5;
  const chroma = Math.max(...rgb) - Math.min(...rgb);
  const tintStrength = Math.min(2.8, 180 / Math.max(1, chroma));
  // Keep muted colors distinguishable and limit the tint on large surfaces.
  const tone = (gray: number, strength: number) => rgb.map((channel) =>
    Math.min(255, Math.max(0, Math.round(gray + (channel - luma) * tintStrength * strength)))
  ).join(", ");
  const accent = tone(dark ? 173 + 20 * brightness : 103 + 10 * brightness, .33);
  return {
    "--panel-rgb": tone((dark ? 31 : 247) + 6 * brightness, .055),
    "--card-rgb": tone(dark ? 48 : 253, .062),
    "--input-rgb": tone(dark ? 41 : 251, .037),
    "--glass-glow": tone(dark ? 151 : 252, dark ? .23 : .032),
    "--glass-tint": tone(dark ? 92 : 205, dark ? .35 : .26),
    "--glass-shade": tone(dark ? 43 : 185, dark ? .22 : .25),
    "--accent": `rgb(${accent})`,
    "--accent-strong": `rgb(${tone(dark ? 208 : 76, .23)})`,
    "--accent-soft": `rgb(${tone(dark ? 59 : 228, .13)})`,
    "--accent-ink": dark ? "#13171B" : "#FFFFFF"
  };
}
