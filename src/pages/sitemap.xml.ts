import type { APIRoute } from "astro";
import conditionsRaw from "../../data/conditions.json";

const SITE = "https://acuproclinic.co.uk";
type C = { slug: string };

export const GET: APIRoute = () => {
  const paths = [
    "/", "/book", "/conditions", "/our-team", "/pricing",
    ...(conditionsRaw as C[]).filter((c) => c.slug).map((c) => `/conditions/${c.slug}`),
  ];
  const urls = paths
    .map((p) => `  <url><loc>${SITE}${p === "/" ? "/" : p + "/"}</loc></url>`)
    .join("\n");
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>`;
  return new Response(xml, { headers: { "content-type": "application/xml" } });
};
