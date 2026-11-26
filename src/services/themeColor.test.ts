import { expect, it } from "vitest";
import { normalizeSettings } from "./settingsService";
import { defaultThemeColor, hexToRgb, normalizeThemeColor, rgbToHex, themeColorStyle } from "./themeColor";

function luminance(cssColor: string) {
  const values = cssColor.startsWith("#") ? hexToRgb(cssColor) : cssColor.match(/\d+/g)!.map(Number);
  const [r, g, b] = values.map((value) => {
    const channel = value / 255;
    return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
  });
  return .2126 * r + .7152 * g + .0722 * b;
}

function contrast(first: string, second: string) {
  const values = [luminance(first), luminance(second)];
  return (Math.max(...values) + .05) / (Math.min(...values) + .05);
}

it("migrates legacy themes and keeps color independent of the saved mode", () => {
  expect(normalizeSettings({ theme: "green" })).toMatchObject({ darkMode: true, themeColor: "#97D4AB" });
  expect(normalizeSettings({ theme: "light" })).toMatchObject({ darkMode: false, themeColor: "#3478C9" });
  expect(normalizeSettings({ theme: "dark", themeColor: "#0a12ff" })).toMatchObject({ darkMode: true, themeColor: "#0A12FF" });
  expect(normalizeSettings({ theme: "green", darkMode: false })).toMatchObject({ darkMode: false, themeColor: null });
  expect(normalizeSettings({ darkMode: false, themeColor: "#755D82" })).toMatchObject({ darkMode: false, themeColor: "#755D82" });
  expect(normalizeThemeColor("rgb(0, 0, 0)")).toBeNull();
  expect(rgbToHex(hexToRgb("#0A12FF"))).toBe("#0A12FF");
  expect(themeColorStyle(null, true)).toEqual(themeColorStyle(defaultThemeColor, true));
  expect(themeColorStyle(null, false)).toEqual(themeColorStyle(defaultThemeColor, false));
});

it.each([false, true])("keeps control colors readable with dark mode %s", (darkMode) => {
  for (const color of ["#000000", "#FFFFFF", "#FF0000", "#00FF00", "#0000FF", "#FFFF00",
    "#00FFFF", "#FF00FF", "#808080", "#527762", "#A78552"]) {
    const palette = themeColorStyle(color, darkMode);
    expect(contrast(palette["--accent"], palette["--accent-ink"]), color).toBeGreaterThan(4.5);
    expect(contrast(palette["--accent-strong"], palette["--accent-soft"]), color).toBeGreaterThan(4.5);
    expect(contrast(palette["--accent-strong"], palette["--panel-rgb"]), color).toBeGreaterThan(4.5);
  }
});

it("keeps distinctly saved themes when switching or resetting the active color", () => {
  expect(normalizeSettings({ darkMode: true, themeColor: "#755d82" }).savedThemeColors).toEqual(["#755D82"]);
  expect(normalizeSettings({ theme: "green" }).savedThemeColors).toEqual([]);
  const savedThemeColors = ["#755d82", "#506B86", "#755D82", "#invalid", null];
  expect(normalizeSettings({ darkMode: false, themeColor: "#506B86", savedThemeColors })).toMatchObject({
    themeColor: "#506B86", savedThemeColors: ["#755D82", "#506B86"]
  });
  expect(normalizeSettings({ darkMode: true, savedThemeColors })).toMatchObject({
    themeColor: null, savedThemeColors: ["#755D82", "#506B86"]
  });
});
