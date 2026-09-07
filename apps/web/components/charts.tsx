"use client";

import { useId, useMemo, useState, type ReactNode } from "react";

/**
 * Small, dependency-free charts for the analytics page. One series per chart (small multiples
 * instead of dual axes), 2px lines, 24px-max columns with rounded data-ends, hairline grid,
 * hover crosshair + tooltip, text in text tokens, marks in the series colour.
 */

export interface Point {
  label: string;
  value: number;
  /** Optional comparison value (previous period), drawn de-emphasised. */
  prev?: number | null;
}

/** Axis ticks on a 1-2-5 step so counts stay whole numbers and money lands on round values. */
function ticks(max: number): number[] {
  if (max <= 0) return [0, 1];
  const rough = max / 4;
  const pow = 10 ** Math.floor(Math.log10(rough));
  const n = rough / pow;
  const step = (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * pow;
  const out: number[] = [];
  for (let v = 0; v < max + step - 1e-9 && out.length < 8; v += step) out.push(Number(v.toFixed(6)));
  return out;
}

function niceMax(max: number): number {
  const t = ticks(max);
  return t[t.length - 1] || 1;
}

export function compact(n: number, money?: { currency: string }): string {
  if (money) {
    const v = n / 100;
    const abs = Math.abs(v);
    const fmt = (x: number, suffix: string) => `${x.toLocaleString(undefined, { maximumFractionDigits: 1 })}${suffix}`;
    const s = abs >= 1_000_000 ? fmt(v / 1_000_000, "M") : abs >= 10_000 ? fmt(v / 1_000, "K") : v.toLocaleString(undefined, { maximumFractionDigits: 0 });
    return `${money.currency} ${s}`;
  }
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 10_000 ? `${(n / 1_000).toFixed(1)}K` : n.toLocaleString();
}

const W = 600;
const H = 180;
const PAD = { top: 12, right: 12, bottom: 26, left: 44 };

interface ChartProps {
  points: Point[];
  kind: "line" | "columns";
  format: (v: number) => string;
  prevLabel?: string;
  height?: number;
}

export function SeriesChart({ points, kind, format, prevLabel = "previous period" }: ChartProps) {
  const id = useId();
  const [hover, setHover] = useState<number | null>(null);
  const max = useMemo(() => Math.max(0, ...points.map((p) => Math.max(p.value, p.prev ?? 0))), [points]);
  const top = niceMax(max);
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const n = points.length;
  const x = (i: number) => (n <= 1 ? PAD.left + innerW / 2 : PAD.left + (innerW * i) / (n - 1));
  const y = (v: number) => PAD.top + innerH - (innerH * v) / top;
  const hasPrev = points.some((p) => p.prev != null);
  const yTicks = ticks(max);
  const labelEvery = Math.max(1, Math.ceil(n / 6));

  const linePath = (key: "value" | "prev") =>
    points
      .map((p, i) => {
        const v = key === "prev" ? p.prev : p.value;
        if (v == null) return null;
        return `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      })
      .filter(Boolean)
      .join(" ");
  const areaPath = `${linePath("value")} L${x(n - 1).toFixed(1)},${(PAD.top + innerH).toFixed(1)} L${x(0).toFixed(1)},${(PAD.top + innerH).toFixed(1)} Z`;

  const bandW = n ? innerW / n : innerW;
  const colW = Math.min(24, bandW * 0.6);
  const cx = (i: number) => PAD.left + bandW * i + bandW / 2;

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    let idx: number;
    if (kind === "columns") idx = Math.floor((px - PAD.left) / bandW);
    else idx = Math.round(((px - PAD.left) / innerW) * (n - 1));
    setHover(idx >= 0 && idx < n ? idx : null);
  };

  return (
    <div className="viz" style={{ position: "relative" }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-labelledby={`${id}-t`} onMouseMove={onMove} onMouseLeave={() => setHover(null)} style={{ display: "block", overflow: "visible" }}>
        <title id={`${id}-t`}>chart</title>
        {yTicks.map((t) => (
          <g key={t}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} className="viz-grid" />
            <text x={PAD.left - 6} y={y(t) + 3} textAnchor="end" className="viz-tick">
              {format(t)}
            </text>
          </g>
        ))}
        {points.map((p, i) => (i % labelEvery === 0 || i === n - 1 ? (
          <text key={p.label} x={kind === "columns" ? cx(i) : x(i)} y={H - 8} textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"} className="viz-tick">
            {p.label}
          </text>
        ) : null))}
        {kind === "line" ? (
          <>
            {n > 1 ? <path d={areaPath} className="viz-area" /> : null}
            {hasPrev && n > 1 ? <path d={linePath("prev")} className="viz-line-prev" /> : null}
            {n > 1 ? <path d={linePath("value")} className="viz-line" /> : null}
            {hover != null ? (
              <>
                <line x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={PAD.top + innerH} className="viz-crosshair" />
                <circle cx={x(hover)} cy={y(points[hover]!.value)} r={5} className="viz-dot" />
              </>
            ) : (
              n > 0 && <circle cx={x(n - 1)} cy={y(points[n - 1]!.value)} r={4} className="viz-dot" />
            )}
          </>
        ) : (
          points.map((p, i) => {
            const h = Math.max(0, (innerH * p.value) / top);
            const r = Math.min(4, colW / 2, h);
            const x0 = cx(i) - colW / 2;
            const y0 = PAD.top + innerH - h;
            const d = h <= 0 ? "" : `M${x0},${PAD.top + innerH} V${y0 + r} Q${x0},${y0} ${x0 + r},${y0} H${x0 + colW - r} Q${x0 + colW},${y0} ${x0 + colW},${y0 + r} V${PAD.top + innerH} Z`;
            return (
              <g key={p.label}>
                {p.prev != null ? <rect x={x0 - 3} y={y(p.prev)} width={colW + 6} height={1.5} className="viz-prev-mark" /> : null}
                <path d={d} className={`viz-col ${hover === i ? "hover" : ""}`} />
              </g>
            );
          })
        )}
      </svg>
      {hover != null && points[hover] ? (
        <div className="viz-tip" style={{ left: `${(((kind === "columns" ? cx(hover) : x(hover)) / W) * 100).toFixed(1)}%` }}>
          <div className="viz-tip-label">{points[hover]!.label}</div>
          <div>
            <span className="viz-swatch" /> {format(points[hover]!.value)}
          </div>
          {points[hover]!.prev != null ? (
            <div className="muted">
              <span className="viz-swatch prev" /> {format(points[hover]!.prev!)} {prevLabel}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function ChartCard({ title, subtitle, legend, children }: { title: string; subtitle?: ReactNode; legend?: ReactNode; children: ReactNode }) {
  return (
    <div className="card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8, marginBottom: 8 }}>
        <div>
          <h2 style={{ marginBottom: 0 }}>{title}</h2>
          {subtitle ? <div className="muted" style={{ fontSize: 12.5 }}>{subtitle}</div> : null}
        </div>
        {legend}
      </div>
      {children}
    </div>
  );
}

export function Legend({ items }: { items: { label: string; kind?: "current" | "prev" }[] }) {
  return (
    <div className="viz-legend">
      {items.map((it) => (
        <span key={it.label}>
          <span className={`viz-swatch ${it.kind === "prev" ? "prev" : ""}`} /> {it.label}
        </span>
      ))}
    </div>
  );
}

/** Stat tile with a signed delta against a named period. */
export function DeltaStat({ label, value, delta, upIsGood = true, hint }: { label: string; value: ReactNode; delta: { pct: number | null; abs: number } | null | undefined; upIsGood?: boolean; hint?: string }) {
  let deltaNode: ReactNode = null;
  if (delta && delta.pct != null) {
    const up = delta.pct > 0;
    const flat = Math.abs(delta.pct) < 0.005;
    const good = flat ? null : up === upIsGood;
    deltaNode = (
      <span className={`delta ${flat ? "" : good ? "good" : "bad"}`}>
        {flat ? "±0%" : `${up ? "▲" : "▼"} ${Math.abs(delta.pct * 100).toFixed(delta.pct * 100 < 10 ? 1 : 0)}%`}
      </span>
    );
  } else if (delta && delta.abs !== 0) {
    deltaNode = <span className={`delta ${delta.abs > 0 === upIsGood ? "good" : "bad"}`}>{delta.abs > 0 ? "▲ new" : "▼"}</span>;
  }
  return (
    <div className="stat">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      <div className="hint">
        {deltaNode} {hint ?? "vs previous period"}
      </div>
    </div>
  );
}
