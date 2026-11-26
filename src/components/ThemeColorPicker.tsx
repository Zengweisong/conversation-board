import { useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { defaultThemeColor, hexToRgb, rgbToHex } from "../services/themeColor";

const presets = [
  { name: "松针绿", color: "#527762" },
  { name: "石板蓝", color: "#506B86" },
  { name: "灰紫", color: "#755D82" },
  { name: "陶土红", color: "#A56D58" },
  { name: "黄铜", color: "#A78552" },
  { name: "石墨灰", color: "#666975" }
];
const channels = [
  { symbol: "R", name: "红色", index: 0 },
  { symbol: "G", name: "绿色", index: 1 },
  { symbol: "B", name: "蓝色", index: 2 }
] as const;

interface Props {
  color: string | null;
  savedColor: string | null;
  savedThemeColors: readonly string[];
  busy: boolean;
  onPreview: (color: string | null) => void;
  onSave: () => void;
  onUseSaved: (color: string) => void;
}

function ThemeSwatches({ label, colors, selected, busy, onSelect }: {
  label: string;
  colors: readonly { name: string; color: string }[];
  selected: string | null;
  busy: boolean;
  onSelect: (color: string) => void;
}) {
  return <div className="ci-theme-color-swatches" role="group" aria-label={label}>
    {colors.map(({ name, color }) => <button key={color} type="button" aria-label={name} title={name}
      aria-pressed={selected === color} style={{ backgroundColor: color }}
      disabled={busy} onClick={() => onSelect(color)}>
      {selected === color && <Check size={15} aria-hidden="true" />}
    </button>)}
  </div>;
}

export function ThemeColorPicker({ color, savedColor, savedThemeColors, busy, onPreview, onSave, onUseSaved }: Props) {
  const [editing, setEditing] = useState<{ channel: number; value: string } | null>(null);
  const rgb = hexToRgb(color ?? defaultThemeColor);
  const canSave = color !== savedColor || (color !== null && !savedThemeColors.includes(color));
  const changeChannel = (channel: number, value: number) => {
    const next = [...rgb] as typeof rgb;
    next[channel] = value;
    onPreview(rgbToHex(next));
  };

  return <details className="ci-theme-color">
    <summary>
      <span className="ci-theme-color-dot" style={color ? { backgroundColor: color } : undefined} aria-hidden="true" />
      <span>主题色</span>
      <span className="ci-theme-color-current">{color ?? "默认"}</span>
      <ChevronDown size={15} aria-hidden="true" />
    </summary>
    <div className="ci-theme-color-panel">
      <ThemeSwatches label="预设颜色" colors={presets} selected={color} busy={busy} onSelect={onPreview} />
      {savedThemeColors.length > 0 && <div className="ci-theme-color-saved">
        <span aria-hidden="true">已保存的主题</span>
        <ThemeSwatches label="已保存的主题" colors={savedThemeColors.map((color) => ({ color, name: `应用主题 ${color}` }))}
          selected={savedColor} busy={busy} onSelect={onUseSaved} />
      </div>}
      <div className="ci-rgb-channels" role="group" aria-label="RGB 色盘">
        {channels.map(({ symbol, name, index }) => {
          const trackColor = (value: number) => {
            const channels = rgb.map((current, channel) => channel === index ? value : current).join(", ");
            return `color-mix(in oklab, rgb(${channels}) 76%, rgb(var(--input-rgb)))`;
          };
          return <div className="ci-rgb-channel" key={symbol}>
            <span aria-hidden="true">{symbol}</span>
            <input type="range" min={0} max={255} value={rgb[index]} aria-label={`${name}滑块`}
              style={{ backgroundImage: `linear-gradient(90deg, ${trackColor(0)}, ${trackColor(255)})` }}
              disabled={busy} onChange={(event) => changeChannel(index, event.target.valueAsNumber)} />
            <input type="text" inputMode="numeric" maxLength={3} aria-label={`${name} ${symbol}`}
              value={editing?.channel === index ? editing.value : rgb[index]} disabled={busy}
              onChange={(event) => {
                const value = event.target.value;
                if (!/^\d{0,3}$/.test(value)) return;
                const next = Math.min(255, Number(value));
                setEditing({ channel: index, value: value && String(next) });
                if (value) changeChannel(index, next);
              }}
              onBlur={() => setEditing(null)} />
          </div>;
        })}
      </div>
      <div className="ci-theme-color-actions">
        <button type="button" onClick={() => onPreview(null)} disabled={busy || color === null}>恢复默认</button>
        <button type="button" onClick={onSave} disabled={busy || !canSave}>保存主题</button>
      </div>
    </div>
  </details>;
}
