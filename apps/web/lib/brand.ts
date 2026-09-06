import type { CSSProperties } from "react";

const DEFAULT = "#4f46e5";

function parseHex(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function toHex([r, g, b]: [number, number, number]): string {
  return `#${[r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("")}`;
}

function mix(rgb: [number, number, number], target: [number, number, number], amount: number): [number, number, number] {
  return [rgb[0] + (target[0] - rgb[0]) * amount, rgb[1] + (target[1] - rgb[1]) * amount, rgb[2] + (target[2] - rgb[2]) * amount];
}

/** Relative luminance, used to keep text readable on the brand colour. */
function luminance([r, g, b]: [number, number, number]): number {
  const f = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/**
 * CSS custom properties that re-theme the public pages to a merchant's brand colour.
 * Falls back to the platform accent when the colour is missing or malformed.
 */
export function brandStyle(primary?: string | null): CSSProperties {
  const rgb = (primary && parseHex(primary)) || parseHex(DEFAULT)!;
  const onBrand = luminance(rgb) > 0.45 ? "#111113" : "#ffffff";
  return {
    ["--accent" as string]: toHex(rgb),
    ["--accent-hover" as string]: toHex(mix(rgb, [0, 0, 0], 0.14)),
    ["--accent-soft" as string]: toHex(mix(rgb, [255, 255, 255], 0.9)),
    ["--accent-ring" as string]: `rgba(${rgb.map(Math.round).join(", ")}, 0.22)`,
    ["--on-accent" as string]: onBrand,
  };
}
