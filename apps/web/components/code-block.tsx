"use client";

import { useState } from "react";
import { Icon } from "@/components/icons";

/**
 * A read-only block of code with a copy button. Used wherever the merchant is meant to take
 * something away verbatim: the tracking snippet, the per-platform install code, capture URLs.
 */
export function CodeBlock({ code, language, label }: { code: string; language?: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="codeblock">
      <div className="codeblock-bar">
        <span className="codeblock-lang">{label ?? language ?? "code"}</span>
        <button
          type="button"
          className="sm"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(code);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            } catch {
              /* clipboard unavailable: the text is selectable */
            }
          }}
        >
          <Icon name={copied ? "check" : "copy"} width={13} height={13} />
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  );
}
