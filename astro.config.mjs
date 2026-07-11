import { defineConfig } from "astro/config";
import react from "@astrojs/react";

// The SEO history lives on the real domain — canonicals & sitemap point here.
export default defineConfig({
  site: "https://acuproclinic.co.uk",
  build: { format: "directory" },
  integrations: [react()],
});
