"use client";

import { useState, type ReactNode } from "react";
import { Icon } from "./icons";

export function Badge({ value }: { value: string | null | undefined }) {
  if (!value) return null;
  return <span className={`badge ${value}`}>{value.replace(/_/g, " ")}</span>;
}

export function Alert({ kind, children }: { kind: "error" | "success" | "info"; children: ReactNode }) {
  if (!children) return null;
  return <div className={`alert ${kind}`}>{children}</div>;
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="stat">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {hint ? <div className="hint">{hint}</div> : null}
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page-header">
      <div>
        <h1>{title}</h1>
        {subtitle ? <p>{subtitle}</p> : null}
      </div>
      {actions ? <div className="actions">{actions}</div> : null}
    </div>
  );
}

export function Field({ label, children, help }: { label: string; children: ReactNode; help?: ReactNode }) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
      {help ? <div className="help">{help}</div> : null}
    </div>
  );
}

export function CopyBox({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="copy">
      <code title={value}>{value}</code>
      <button
        type="button"
        className="sm"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          } catch {
            /* clipboard unavailable */
          }
        }}
      >
        <Icon name={copied ? "check" : "copy"} width={13} height={13} />
        {copied ? "Copied" : "Copy"}
      </button>
    </span>
  );
}

export function Table<T>({ rows, columns, empty = "Nothing here yet.", keyOf }: { rows: T[] | null | undefined; columns: { header: string; cell: (row: T) => ReactNode; num?: boolean }[]; empty?: string; keyOf: (row: T) => string }) {
  if (!rows) return <div className="empty">Loading…</div>;
  if (rows.length === 0) return <div className="empty">{empty}</div>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.header} className={c.num ? "num" : undefined}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={keyOf(r)}>
              {columns.map((c) => (
                <td key={c.header} className={c.num ? "num" : undefined}>
                  {c.cell(r)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Loading({ error }: { error?: string | null }) {
  if (error) return <Alert kind="error">{error}</Alert>;
  return <div className="empty">Loading…</div>;
}
