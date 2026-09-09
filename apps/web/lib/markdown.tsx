import { Fragment, type ReactNode } from "react";

/**
 * A deliberately small Markdown subset for the in-app guides, so the help pages need no
 * dependency and nothing from the content can inject markup: the parser only ever produces
 * React elements, never HTML strings, so there is no innerHTML anywhere in this path.
 *
 * Supported: headings, paragraphs, unordered and ordered lists (one level of nesting),
 * fenced code blocks, and pipe tables. Inline: `code`, **bold** and [links](url).
 */
export type Block =
  | { kind: "heading"; level: 1 | 2 | 3; text: string; id: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; ordered: boolean; items: ListItem[] }
  | { kind: "code"; lang: string; code: string }
  | { kind: "table"; head: string[]; rows: string[][] };

export interface ListItem {
  text: string;
  children: string[];
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[`*_[\]()]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

const splitRow = (line: string): string[] =>
  line
    .replace(/^\s*\|/, "")
    .replace(/\|\s*$/, "")
    .split("|")
    .map((c) => c.trim());

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;

  /** A table needs a header row with the |---|---| separator directly under it. */
  const isTableStart = (idx: number): boolean =>
    (lines[idx] ?? "").trim().startsWith("|") && idx + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[idx + 1]!);

  while (i < lines.length) {
    const line = lines[i]!;

    if (!line.trim()) {
      i++;
      continue;
    }

    // Fenced code. Everything up to the closing fence is taken verbatim.
    const fence = /^```(\w*)\s*$/.exec(line);
    if (fence) {
      const lang = fence[1] ?? "";
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i]!)) body.push(lines[i++]!);
      const closed = i < lines.length;
      i++; // closing fence
      // An unclosed fence ran to the end of the file and swept up its trailing blank lines.
      if (!closed) while (body.length && !body[body.length - 1]!.trim()) body.pop();
      blocks.push({ kind: "code", lang, code: body.join("\n") });
      continue;
    }

    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1]!.length as 1 | 2 | 3;
      const text = heading[2]!.trim();
      blocks.push({ kind: "heading", level, text, id: slugify(text) });
      i++;
      continue;
    }

    // Table: a header row followed by the |---|---| separator.
    if (isTableStart(i)) {
      const head = splitRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.trim().startsWith("|")) rows.push(splitRow(lines[i++]!));
      blocks.push({ kind: "table", head, rows });
      continue;
    }

    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+\.\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      const ordered = !bullet;
      const items: ListItem[] = [];
      while (i < lines.length) {
        const current = lines[i]!;
        if (!current.trim()) {
          // A blank line ends the list unless the next line continues it.
          const next = lines[i + 1] ?? "";
          const continues = ordered ? /^\s*\d+\.\s+/.test(next) : /^\s{0,3}[-*]\s+/.test(next);
          if (!continues) break;
          i++;
          continue;
        }
        const top = ordered ? /^\d+\.\s+(.*)$/.exec(current) : /^[-*]\s+(.*)$/.exec(current);
        if (top) {
          items.push({ text: top[1]!.trim(), children: [] });
          i++;
          continue;
        }
        // Indented bullet: a child of the item above.
        const child = /^\s+[-*]\s+(.*)$/.exec(current);
        if (child && items.length) {
          items[items.length - 1]!.children.push(child[1]!.trim());
          i++;
          continue;
        }
        break;
      }
      blocks.push({ kind: "list", ordered, items });
      continue;
    }

    // Paragraph: consecutive non-blank lines that start no other block.
    const para: string[] = [];
    while (i < lines.length) {
      const current = lines[i]!;
      if (!current.trim()) break;
      // A pipe line ends the paragraph only when it actually opens a table; otherwise it is prose.
      if (/^(#{1,3})\s/.test(current) || /^```/.test(current) || /^\s*[-*]\s+/.test(current) || /^\s*\d+\.\s+/.test(current) || isTableStart(i)) break;
      para.push(current.trim());
      i++;
    }
    if (para.length) blocks.push({ kind: "paragraph", text: para.join(" ") });
    else i++;
  }

  return blocks;
}

/** Inline formatting. Code spans are taken out first so nothing inside them is re-parsed. */
export function Inline({ text }: { text: string }): ReactNode {
  const out: ReactNode[] = [];
  const pattern = /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = pattern.exec(text))) {
    if (match.index > last) out.push(<Fragment key={key++}>{text.slice(last, match.index)}</Fragment>);
    if (match[1] !== undefined) out.push(<code key={key++}>{match[1]}</code>);
    else if (match[2] !== undefined) out.push(<strong key={key++}>{match[2]}</strong>);
    else if (match[3] !== undefined && match[4] !== undefined) {
      const href = match[4];
      const external = /^https?:\/\//i.test(href);
      // Only http(s) and in-app paths are ever turned into links.
      if (external || href.startsWith("/") || href.startsWith("#")) {
        out.push(
          <a key={key++} href={href} {...(external ? { target: "_blank", rel: "noreferrer noopener" } : {})}>
            {match[3]}
          </a>,
        );
      } else out.push(<Fragment key={key++}>{match[3]}</Fragment>);
    }
    last = match.index + match[0].length;
  }
  if (last < text.length) out.push(<Fragment key={key++}>{text.slice(last)}</Fragment>);
  return <>{out}</>;
}

/** Plain text of a block, for the search filter. */
export function blockText(block: Block): string {
  switch (block.kind) {
    case "heading":
      return block.text;
    case "paragraph":
      return block.text;
    case "list":
      return block.items.map((it) => `${it.text} ${it.children.join(" ")}`).join(" ");
    case "code":
      return block.code;
    case "table":
      return [block.head, ...block.rows].flat().join(" ");
  }
}
