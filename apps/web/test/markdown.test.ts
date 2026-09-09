import { describe, expect, it } from "vitest";
import { blockText, parseMarkdown, slugify, type Block } from "../lib/markdown";

/**
 * The guide pages render repository markdown, so the parser is the only thing standing between
 * a documentation edit and a broken help page. These cover the constructs the guides actually
 * use, and the ones that would silently swallow content if mishandled.
 */
const kinds = (blocks: Block[]) => blocks.map((b) => b.kind);

describe("guide markdown parser", () => {
  it("reads headings with stable anchors", () => {
    const blocks = parseMarkdown("# Title\n\n## 6. Website tracking snippet\n\n### 6.1 Turn it on\n");
    expect(blocks).toEqual([
      { kind: "heading", level: 1, text: "Title", id: "title" },
      { kind: "heading", level: 2, text: "6. Website tracking snippet", id: "6-website-tracking-snippet" },
      { kind: "heading", level: 3, text: "6.1 Turn it on", id: "6-1-turn-it-on" },
    ]);
    expect(slugify("Commissions, holding periods and payouts")).toBe("commissions-holding-periods-and-payouts");
    expect(slugify("`code` and **bold**")).toBe("code-and-bold");
  });

  it("joins wrapped paragraph lines and keeps blocks apart", () => {
    const blocks = parseMarkdown("First line\nsecond line\n\nA new paragraph.\n");
    expect(blocks).toEqual([
      { kind: "paragraph", text: "First line second line" },
      { kind: "paragraph", text: "A new paragraph." },
    ]);
  });

  it("reads both list styles and one level of nesting", () => {
    const blocks = parseMarkdown("1. Go to Settings\n2. Copy the snippet:\n   - WordPress: header.php\n   - Shopify: theme.liquid\n3. Paste it\n");
    expect(blocks).toHaveLength(1);
    const list = blocks[0]!;
    expect(list.kind).toBe("list");
    if (list.kind !== "list") throw new Error("expected a list");
    expect(list.ordered).toBe(true);
    expect(list.items.map((i) => i.text)).toEqual(["Go to Settings", "Copy the snippet:", "Paste it"]);
    expect(list.items[1]!.children).toEqual(["WordPress: header.php", "Shopify: theme.liquid"]);

    const bullets = parseMarkdown("- one\n- two\n");
    expect(bullets[0]).toMatchObject({ kind: "list", ordered: false });
  });

  it("takes fenced code verbatim, including markdown-looking lines", () => {
    const blocks = parseMarkdown('Intro:\n\n```html\n<script src="x"></script>\n# not a heading\n- not a list\n```\n\nAfter.\n');
    expect(kinds(blocks)).toEqual(["paragraph", "code", "paragraph"]);
    expect(blocks[1]).toEqual({ kind: "code", lang: "html", code: '<script src="x"></script>\n# not a heading\n- not a list' });
  });

  it("reads pipe tables with their header row", () => {
    const blocks = parseMarkdown("| Object | What it is |\n|---|---|\n| **Offer** | A product |\n| Program | The rules |\n");
    expect(blocks[0]).toEqual({ kind: "table", head: ["Object", "What it is"], rows: [["**Offer**", "A product"], ["Program", "The rules"]] });
  });

  it("never loses content: every guide line lands in some block", () => {
    const source = "# T\n\nPara one.\n\n## 1. Section\n\n- a\n- b\n\n| h |\n|---|\n| v |\n\n```\ncode\n```\n\nEnd.\n";
    const text = parseMarkdown(source).map(blockText).join(" ");
    for (const needle of ["T", "Para one.", "1. Section", "a", "b", "h", "v", "code", "End."]) expect(text).toContain(needle);
  });

  it("survives the shapes that would otherwise hang or drop text", () => {
    expect(parseMarkdown("")).toEqual([]);
    expect(parseMarkdown("\n\n   \n")).toEqual([]);
    // an unclosed fence must still terminate
    expect(parseMarkdown("```\nnever closed\n")).toEqual([{ kind: "code", lang: "", code: "never closed" }]);
    // a pipe line that is not a table stays a paragraph
    expect(kinds(parseMarkdown("| not | a table\n"))).toEqual(["paragraph"]);
  });

  it("parses each shipped guide into a usable table of contents", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    for (const name of ["merchant-guide", "affiliate-guide", "admin-guide"]) {
      const file = fileURLToPath(new URL(`../content/${name}.md`, import.meta.url));
      const blocks = parseMarkdown(readFileSync(file, "utf8"));
      const h1 = blocks.filter((b) => b.kind === "heading" && b.level === 1);
      const h2 = blocks.filter((b) => b.kind === "heading" && b.level === 2);
      expect(h1, `${name} has exactly one title`).toHaveLength(1);
      expect(h2.length, `${name} has sections`).toBeGreaterThan(4);
      const ids = h2.map((b) => (b.kind === "heading" ? b.id : ""));
      expect(new Set(ids).size, `${name} anchors are unique`).toBe(ids.length);
      expect(ids.every(Boolean), `${name} anchors are non-empty`).toBe(true);
    }
  });
});
