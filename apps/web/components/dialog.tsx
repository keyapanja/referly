"use client";

import { useEffect, useRef, useState } from "react";

/**
 * The app's own dialog, in place of the browser's prompt() and confirm(): it says what is about
 * to happen, asks for what is needed (a reason, a reference), refuses an empty answer where one
 * is required, and looks like the rest of the product. Any component calls `ask`, `askReason` or
 * `confirmAction` and awaits the answer; the one `DialogHost` in the app shell shows them, one at
 * a time. Built on the native <dialog>, so focus stays inside it and Escape cancels.
 */
export interface DialogField {
  name: string;
  label: string;
  placeholder?: string;
  help?: string;
  required?: boolean;
  multiline?: boolean;
  initial?: string;
}
export interface DialogRequest {
  title: string;
  /** What will happen, in a sentence or two. */
  body?: string;
  fields?: DialogField[];
  confirmLabel?: string;
  cancelLabel?: string;
  /** The action destroys or reverses something: the button says so, and Cancel gets the focus. */
  danger?: boolean;
}
type Answer = Record<string, string> | null;
interface Pending {
  request: DialogRequest;
  resolve: (answer: Answer) => void;
}

const EVENT = "referly:dialog";
let hosts = 0;

/** Resolves to the field values (an empty object when there are no fields), or null when the person cancels. */
export function ask(request: DialogRequest): Promise<Answer> {
  if (typeof window === "undefined") return Promise.resolve(null);
  if (hosts === 0) return Promise.resolve(browserFallback(request));
  return new Promise((resolve) => window.dispatchEvent(new CustomEvent<Pending>(EVENT, { detail: { request, resolve } })));
}

export function confirmAction(request: Omit<DialogRequest, "fields">): Promise<boolean> {
  return ask(request).then((a) => a !== null);
}

/** One text answer, required unless said otherwise. Resolves to the trimmed text ("" when optional and left empty), or null on cancel. */
export function askReason(request: Omit<DialogRequest, "fields"> & { label: string; placeholder?: string; help?: string; required?: boolean; multiline?: boolean }): Promise<string | null> {
  const { label, placeholder, help, required, multiline, ...rest } = request;
  return ask({ ...rest, fields: [{ name: "value", label, placeholder, help, required: required ?? true, multiline: multiline ?? true }] }).then((a) => (a ? (a.value ?? "").trim() : null));
}

/** Pages outside the app shell have no host; they get the browser's own dialogs rather than nothing. */
function browserFallback(request: DialogRequest): Answer {
  const text = [request.title, request.body].filter(Boolean).join("\n\n");
  if (!request.fields?.length) return window.confirm(text) ? {} : null;
  const out: Record<string, string> = {};
  for (const f of request.fields) {
    const v = window.prompt(`${text}\n\n${f.label}`, f.initial ?? "");
    if (v === null || (f.required && !v.trim())) return null;
    out[f.name] = v;
  }
  return out;
}

export function DialogHost() {
  const [queue, setQueue] = useState<Pending[]>([]);
  const current = queue[0] ?? null;
  const dialog = useRef<HTMLDialogElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    hosts++;
    const on = (e: Event) => {
      const detail = (e as CustomEvent<Pending>).detail;
      if (detail?.request?.title) setQueue((q) => [...q, detail]);
    };
    window.addEventListener(EVENT, on);
    return () => {
      hosts--;
      window.removeEventListener(EVENT, on);
    };
  }, []);

  useEffect(() => {
    const el = dialog.current;
    if (!el || !current) return;
    if (!el.open) el.showModal();
    // A destructive question starts on Cancel, so a stray Enter does no harm; otherwise the first field, or the confirm button.
    if (current.request.danger && !current.request.fields?.length) cancelButton.current?.focus();
  }, [current]);

  if (!current) return null;
  const { request } = current;
  const finish = (answer: Answer) => {
    dialog.current?.close();
    current.resolve(answer);
    setQueue((q) => q.slice(1));
  };

  return (
    <dialog
      ref={dialog}
      className="modal"
      aria-labelledby="dialog-title"
      onCancel={(e) => {
        e.preventDefault();
        finish(null);
      }}
      onClick={(e) => {
        if (e.target === dialog.current) finish(null);
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const data = new FormData(e.currentTarget);
          const values: Record<string, string> = {};
          for (const f of request.fields ?? []) values[f.name] = String(data.get(f.name) ?? "");
          if ((request.fields ?? []).some((f) => f.required && !values[f.name]!.trim())) return;
          finish(values);
        }}
      >
        <h2 id="dialog-title">{request.title}</h2>
        {request.body ? <p className="muted">{request.body}</p> : null}
        {(request.fields ?? []).map((f, i) => (
          <div className="field" key={f.name}>
            <label htmlFor={`dialog-${f.name}`}>{f.label}</label>
            {f.multiline ? (
              <textarea id={`dialog-${f.name}`} name={f.name} rows={3} defaultValue={f.initial ?? ""} placeholder={f.placeholder} required={f.required} autoFocus={i === 0} />
            ) : (
              <input id={`dialog-${f.name}`} name={f.name} defaultValue={f.initial ?? ""} placeholder={f.placeholder} required={f.required} autoFocus={i === 0} />
            )}
            {f.help ? <div className="help">{f.help}</div> : null}
          </div>
        ))}
        <div className="actions modal-actions">
          <button type="button" ref={cancelButton} onClick={() => finish(null)}>
            {request.cancelLabel ?? "Cancel"}
          </button>
          <button type="submit" className={request.danger ? "danger" : "primary"} autoFocus={!request.fields?.length && !request.danger}>
            {request.confirmLabel ?? "Confirm"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
