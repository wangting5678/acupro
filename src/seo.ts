import pagesRaw from "../data/seo/pages.json";

type SeoRow = {
  url: string;
  type: string | null;
  title: string | null;
  description: string | null;
  canonical: string | null;
  noindex: number | null;
};

const SITE = "AcuPro Clinic";

// Old SEO permalinks were captured from the staging host — normalise to a path.
function toPath(url: string): string {
  try {
    const u = new URL(url);
    let p = u.pathname;
    if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
    return p || "/";
  } catch {
    return url;
  }
}

// Resolve Yoast template variables into plain text.
function resolve(s: string | null, fallbackTitle: string): string {
  if (!s) return "";
  return s
    .replace(/%%sep%%/g, "|")
    .replace(/%%sitename%%/g, SITE)
    .replace(/%%title%%/g, fallbackTitle)
    .replace(/%%(page|primary_category|category|pt_single|archive_title|term_title)%%/g, "")
    .replace(/\s*\|\s*\|\s*/g, " | ")
    .replace(/\s+/g, " ")
    .replace(/^\s*\|\s*|\s*\|\s*$/g, "")
    .trim();
}

const rows = pagesRaw as SeoRow[];
const byPath = new Map<string, SeoRow>();
for (const r of rows) byPath.set(toPath(r.url), r);

export type Seo = { title: string; description: string; canonicalPath: string };

/** Look up inherited SEO for a path; fall back to a sensible title/description. */
export function getSeo(path: string, fallbackTitle: string, fallbackDesc = ""): Seo {
  const clean = path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
  const row = byPath.get(clean);
  const title = resolve(row?.title ?? null, fallbackTitle) || `${fallbackTitle} | ${SITE}`;
  const description = resolve(row?.description ?? null, fallbackTitle) || fallbackDesc;
  return { title, description, canonicalPath: clean === "" ? "/" : clean };
}

export const hasInheritedSeo = (path: string) => byPath.has(path);
