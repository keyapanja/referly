"use client";

import { Field } from "./ui";

export interface RuleDraft {
  name: string;
  trigger: string;
  conditions: { field: string; op: string; value: string }[];
  actions: Record<string, any>[];
  stop: { oncePerEntity: boolean; oncePerAffiliate: boolean; skipIfAffiliateStatusIn: string[]; activeFrom: string | null; activeUntil: string | null };
  enabled: boolean;
}

export function emptyRule(): RuleDraft {
  return { name: "", trigger: "conversion.created", conditions: [], actions: [{ type: "create_task", title: "" }], stop: { oncePerEntity: true, oncePerAffiliate: false, skipIfAffiliateStatusIn: ["suspended", "rejected"], activeFrom: null, activeUntil: null }, enabled: true };
}

/** Converts an API rule into the draft shape (conditions with array values become comma lists). */
export function toDraft(rule: any): RuleDraft {
  return {
    name: rule.name,
    trigger: rule.trigger,
    conditions: rule.conditions.map((c: any) => ({ field: c.field, op: c.op, value: Array.isArray(c.value) ? c.value.join(", ") : String(c.value) })),
    actions: rule.actions,
    stop: {
      oncePerEntity: rule.stop?.oncePerEntity ?? true,
      oncePerAffiliate: rule.stop?.oncePerAffiliate ?? false,
      skipIfAffiliateStatusIn: rule.stop?.skipIfAffiliateStatusIn ?? ["suspended", "rejected"],
      activeFrom: rule.stop?.activeFrom ? String(rule.stop.activeFrom).slice(0, 16) : null,
      activeUntil: rule.stop?.activeUntil ? String(rule.stop.activeUntil).slice(0, 16) : null,
    },
    enabled: rule.enabled,
  };
}

/** Converts the draft to the API payload (comma lists become arrays for in/not_in, numbers for numeric fields). */
export function toPayload(d: RuleDraft, catalog: any) {
  const numeric = new Set(catalog.fields.filter((f: any) => f.kind === "number").map((f: any) => f.key));
  return {
    name: d.name,
    trigger: d.trigger,
    conditions: d.conditions.map((c) => {
      const parts = c.value.split(",").map((s) => s.trim()).filter(Boolean);
      const cast = (s: string) => (numeric.has(c.field) ? Number(s) : s);
      return { field: c.field, op: c.op, value: c.op === "in" || c.op === "not_in" ? parts.map(cast) : cast(c.value.trim()) };
    }),
    actions: d.actions.map((a) => (a.type === "adjust_balance" ? { ...a, amountMinor: Number(a.amountMinor) } : a)),
    stop: { ...d.stop, activeFrom: d.stop.activeFrom ? new Date(d.stop.activeFrom).toISOString() : null, activeUntil: d.stop.activeUntil ? new Date(d.stop.activeUntil).toISOString() : null },
    enabled: d.enabled,
  };
}

export function RuleBuilder({ catalog, value, onChange }: { catalog: any; value: RuleDraft; onChange: (v: RuleDraft) => void }) {
  const set = (patch: Partial<RuleDraft>) => onChange({ ...value, ...patch });
  const setCondition = (i: number, patch: Partial<RuleDraft["conditions"][number]>) => set({ conditions: value.conditions.map((c, j) => (j === i ? { ...c, ...patch } : c)) });
  const setAction = (i: number, patch: Record<string, any>) => set({ actions: value.actions.map((a, j) => (j === i ? { ...a, ...patch } : a)) });
  const actionDef = (type: string) => catalog.actions.find((a: any) => a.type === type);

  return (
    <>
      <div className="row">
        <Field label="Name">
          <input value={value.name} onChange={(e) => set({ name: e.target.value })} placeholder="Thank big sales" required />
        </Field>
        <Field label="When">
          <select value={value.trigger} onChange={(e) => set({ trigger: e.target.value })}>
            {catalog.triggers.map((t: any) => (
              <option key={t.type} value={t.type}>
                {t.label}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <h3>Only if</h3>
      {value.conditions.length === 0 ? <p className="help" style={{ marginBottom: 8 }}>No conditions: the rule runs for every matching event.</p> : null}
      {value.conditions.map((c, i) => (
        <div key={i} className="actions" style={{ marginBottom: 8 }}>
          <select value={c.field} onChange={(e) => setCondition(i, { field: e.target.value })} style={{ width: 200 }}>
            {catalog.fields.map((f: any) => (
              <option key={f.key} value={f.key}>
                {f.label}
              </option>
            ))}
          </select>
          <select value={c.op} onChange={(e) => setCondition(i, { op: e.target.value })} style={{ width: 130 }}>
            {catalog.ops.map((o: string) => (
              <option key={o} value={o}>
                {{ eq: "is", neq: "is not", in: "is one of", not_in: "is none of", gte: "is at least", lte: "is at most" }[o] ?? o}
              </option>
            ))}
          </select>
          <input value={c.value} onChange={(e) => setCondition(i, { value: e.target.value })} placeholder={c.op === "in" || c.op === "not_in" ? "a, b, c" : "value"} style={{ width: 260 }} />
          <button type="button" className="sm" onClick={() => set({ conditions: value.conditions.filter((_, j) => j !== i) })}>
            Remove
          </button>
        </div>
      ))}
      <button type="button" className="sm" onClick={() => set({ conditions: [...value.conditions, { field: "amountMinor", op: "gte", value: "" }] })}>
        Add condition
      </button>

      <h3 style={{ marginTop: 18 }}>Then</h3>
      {value.actions.map((a, i) => {
        const def = actionDef(a.type);
        return (
          <div key={i} className="card" style={{ padding: 14, marginBottom: 8, background: "var(--surface-2)", boxShadow: "none" }}>
            <div className="actions" style={{ marginBottom: def?.params?.length ? 10 : 0 }}>
              <select value={a.type} onChange={(e) => setAction(i, Object.assign({ type: e.target.value }, ...Object.keys(a).map((k) => ({ [k]: undefined }))))} style={{ width: 320 }}>
                {catalog.actions.map((d: any) => (
                  <option key={d.type} value={d.type}>
                    {d.label}
                  </option>
                ))}
              </select>
              <button type="button" className="sm" disabled={value.actions.length === 1} onClick={() => set({ actions: value.actions.filter((_, j) => j !== i) })}>
                Remove
              </button>
            </div>
            {def?.params?.map((p: any) => (
              <Field key={p.key} label={p.label}>
                {p.kind === "template" ? (
                  <select value={a[p.key] ?? ""} onChange={(e) => setAction(i, { [p.key]: e.target.value })}>
                    <option value="">Choose a template…</option>
                    {catalog.templates.map((k: string) => (
                      <option key={k} value={k}>
                        {k.replace(/_/g, " ")}
                      </option>
                    ))}
                  </select>
                ) : p.kind === "text" ? (
                  <textarea value={a[p.key] ?? ""} onChange={(e) => setAction(i, { [p.key]: e.target.value })} style={{ minHeight: 70 }} placeholder="You can use {{affiliate_name}}, {{amount}}, {{program_name}}…" />
                ) : (
                  <input type={p.kind === "number" ? "number" : "text"} value={a[p.key] ?? ""} onChange={(e) => setAction(i, { [p.key]: e.target.value })} />
                )}
              </Field>
            ))}
          </div>
        );
      })}
      <button type="button" className="sm" onClick={() => set({ actions: [...value.actions, { type: "add_tag", tag: "" }] })}>
        Add action
      </button>

      <h3 style={{ marginTop: 18 }}>Stop conditions</h3>
      <label className="checkbox" style={{ marginBottom: 6 }}>
        <input type="checkbox" checked={value.stop.oncePerEntity} onChange={(e) => set({ stop: { ...value.stop, oncePerEntity: e.target.checked } })} /> Run at most once per entity (conversion, commission, affiliate…)
      </label>
      <label className="checkbox" style={{ marginBottom: 6 }}>
        <input type="checkbox" checked={value.stop.oncePerAffiliate} onChange={(e) => set({ stop: { ...value.stop, oncePerAffiliate: e.target.checked } })} /> Run at most once per affiliate, ever
      </label>
      <Field label="Skip when the affiliate's status is one of" help="Comma separated. Default: suspended, rejected.">
        <input value={value.stop.skipIfAffiliateStatusIn.join(", ")} onChange={(e) => set({ stop: { ...value.stop, skipIfAffiliateStatusIn: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) } })} />
      </Field>
      <div className="row">
        <Field label="Active from (optional)">
          <input type="datetime-local" value={value.stop.activeFrom ?? ""} onChange={(e) => set({ stop: { ...value.stop, activeFrom: e.target.value || null } })} />
        </Field>
        <Field label="Active until (optional)">
          <input type="datetime-local" value={value.stop.activeUntil ?? ""} onChange={(e) => set({ stop: { ...value.stop, activeUntil: e.target.value || null } })} />
        </Field>
      </div>
      <label className="checkbox">
        <input type="checkbox" checked={value.enabled} onChange={(e) => set({ enabled: e.target.checked })} /> Enabled
      </label>
    </>
  );
}
