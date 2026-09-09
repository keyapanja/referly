import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Guide content is read from `apps/web/content` at build time, so the markdown file in the
 * repository is the single source for what users read and the pages stay static (no API call,
 * no runtime file access). Server components only.
 *
 * Each branch spells out its own literal filename rather than interpolating the name, so the
 * bundler can see exactly which files are needed instead of tracing the whole project.
 */
export type GuideName = "merchant-guide" | "affiliate-guide" | "admin-guide";

export function readGuide(name: GuideName): string {
  switch (name) {
    case "merchant-guide":
      return readFileSync(path.join(process.cwd(), "content", "merchant-guide.md"), "utf8");
    case "affiliate-guide":
      return readFileSync(path.join(process.cwd(), "content", "affiliate-guide.md"), "utf8");
    case "admin-guide":
      return readFileSync(path.join(process.cwd(), "content", "admin-guide.md"), "utf8");
  }
}
