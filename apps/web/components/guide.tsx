"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { blockText, Inline, parseMarkdown, type Block } from "@/lib/markdown";

interface Section {
  id: string;
  title: string;
  blocks: Block[];
}

function group(blocks: Block[]): { intro: Block[]; title: string | null; sections: Section[] } {
  let title: string | null = null;
  const intro: Block[] = [];
  const sections: Section[] = [];
  for (const block of blocks) {
    if (block.kind === "heading" && block.level === 1) {
      title = block.text;
      continue;
    }
    if (block.kind === "heading" && block.level === 2) {
      sections.push({ id: block.id, title: block.text, blocks: [] });
      continue;
    }
    if (sections.length === 0) intro.push(block);
    else sections[sections.length - 1]!.blocks.push(block);
  }
  return { intro, title, sections };
}

function Blocks({ blocks }: { blocks: Block[] }) {
  return (
    <>
      {blocks.map((block, i) => {
        switch (block.kind) {
          case "heading":
            return (
              <h3 key={i} id={block.id}>
                {block.text}
              </h3>
            );
          case "paragraph":
            return (
              <p key={i}>
                <Inline text={block.text} />
              </p>
            );
          case "code":
            return (
              <pre key={i} className="guide-code">
                <code>{block.code}</code>
              </pre>
            );
          case "table":
            return (
              <div key={i} className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      {block.head.map((h, k) => (
                        <th key={k}>
                          <Inline text={h} />
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {block.rows.map((row, r) => (
                      <tr key={r}>
                        {row.map((cell, c) => (
                          <td key={c}>
                            <Inline text={cell} />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case "list": {
            const items = block.items.map((item, k) => (
              <li key={k}>
                <Inline text={item.text} />
                {item.children.length > 0 ? (
                  <ul>
                    {item.children.map((child, c) => (
                      <li key={c}>
                        <Inline text={child} />
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ));
            return block.ordered ? <ol key={i}>{items}</ol> : <ul key={i}>{items}</ul>;
          }
        }
      })}
    </>
  );
}

/**
 * Renders one of the markdown guides with a sticky contents rail and a filter. The markdown is
 * read from the repository at build time and passed in, so this page works offline and never
 * calls the API.
 */
export function Guide({ markdown, intro }: { markdown: string; intro?: string }) {
  const parsed = useMemo(() => group(parseMarkdown(markdown)), [markdown]);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  const needle = query.trim().toLowerCase();
  const sections = useMemo(() => {
    if (!needle) return parsed.sections;
    return parsed.sections.filter((s) => `${s.title} ${s.blocks.map(blockText).join(" ")}`.toLowerCase().includes(needle));
  }, [parsed.sections, needle]);

  // Highlight the section the reader is in. Cheap: only h2 anchors are observed.
  useEffect(() => {
    const root = bodyRef.current;
    if (!root || typeof IntersectionObserver === "undefined") return;
    const headings = Array.from(root.querySelectorAll<HTMLElement>("h2[id]"));
    if (!headings.length) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActive(visible[0].target.id);
      },
      { rootMargin: "-80px 0px -70% 0px", threshold: 0 },
    );
    for (const h of headings) observer.observe(h);
    return () => observer.disconnect();
  }, [sections]);

  return (
    <div className="guide">
      <aside className="guide-toc" aria-label="Contents">
        <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search the guide" aria-label="Search the guide" />
        <nav>
          {parsed.sections.map((s, i) => {
            const hidden = needle !== "" && !sections.some((v) => v.id === s.id);
            return (
              <a key={s.id} href={`#${s.id}`} className={`${active === s.id ? "active" : ""} ${hidden ? "dim" : ""}`} onClick={() => setActive(s.id)}>
                <span className="n">{i + 1}</span>
                {s.title.replace(/^\d+\.\s*/, "")}
              </a>
            );
          })}
        </nav>
      </aside>
      <div className="guide-body" ref={bodyRef}>
        {intro ? <p className="guide-lede">{intro}</p> : null}
        {!needle && parsed.intro.length > 0 ? <Blocks blocks={parsed.intro} /> : null}
        {needle && sections.length === 0 ? <div className="empty">Nothing in this guide matches “{query}”.</div> : null}
        {sections.map((s) => (
          <section key={s.id}>
            <h2 id={s.id}>{s.title}</h2>
            <Blocks blocks={s.blocks} />
          </section>
        ))}
      </div>
    </div>
  );
}
