# AcuPro Clinic — Site Migration: URL Redirect Map (301) & Tracking Notes

**Context for the agency.** We are moving `acuproclinic.co.uk` from the old WordPress site to a new, rebuilt site. **The domain does not change** — only the site behind it. Before we switch DNS, we want to put 301 redirects in place so that old indexed URLs and paid-search landing pages continue to work and SEO equity is preserved.

**New site page structure:** `/` · `/pricing/` · `/our-team/` · `/conditions/` · `/conditions/<slug>` (31 condition pages) · `/book/` · `/cancel/`

Source of the old URL list: the old site's Yoast XML sitemaps, captured 2026-09.

---

## A. No redirect needed — identical URLs (SEO carries over automatically) ✅
- `/`
- `/pricing`
- `/our-team`
- `/conditions`
- `/conditions/<slug>` — all **27** old condition pages exist on the new site at the **same path**, so no redirect is required:
  `headache-migraines, arthritis, plantar-fasciitis, sciatica, achilles-tendinitis, back-pain, neck-shoulder-pain, gout, infertility, menstruation-cycle, menopausal-syndromes, wrinkles, eczema, acne, ivf-support, pms, labour-assist, ibs-indigestive, sperm-quality, excessive-weight, thyroid-function, insomnia, immune-function, anxiety-stress, mesotherapy, thermage, mesotherapy-microneedling`

## B. Single-page 301 redirects (old → new)
| Old URL | Redirect to |
|---|---|
| `/about`, `/about/research` | `/` |
| `/clinics` | `/#clinics` |
| `/clinics/london-clinic` | `/#clinics` |
| `/clinics/vct` | `/#clinics` |
| `/clinics/video-consultation` | `/book/` |
| `/contact` | `/#clinics` |
| `/online-booking`, `/online-service`, `/conditions/online-service` | `/book/` |
| `/free-15-min-enquiry` | `/book/` |
| `/initial-assessment` | `/book/` |
| `/follow-up-consultation` | `/book/` |
| `/womens-health` | `/conditions/` |
| `/general-wellbeing` | `/conditions/` |
| `/acupuncture-london`, `/acupuncture-in-westminster`, `/acupuncture-pain` | `/pricing/` |
| `/herbal-medicines` | `/pricing/` |
| `/thank-you` | `/`  ⚠️ see Flag 1 |
| `/shop`, `/basket`, `/checkout`, `/my-account` | `/` |

## C. Prefix / pattern 301 redirects (whole group → one target)
| Old path prefix | Redirect to | Count |
|---|---|---|
| `/our-team/<slug>` (individual practitioner pages) | `/our-team/` | 10 |
| `/acupuncture/<slug>` | `/pricing/` | 5 |
| `/herbal-medicine/<slug>`, `/herbal-medicines/<slug>` | `/pricing/` | — |
| `/massage/<slug>` | `/pricing/` | — |
| `/aesthetic/<slug>` | `/pricing/` | — |
| `/wellbeing/<slug>` | `/pricing/` | — |
| `/product/<slug>`, `/product-category/<slug>` (WooCommerce) | `/` | — |
| Blog posts (post sitemap) | `/` | — |

## D. Local-SEO landing pages (~18) → `/`  (see Flag 2)
`/the-best-acupuncture-clinic-near-{victoria-london, city-of-london, westminster, belgravia, chelsea, kensington, mayfair, soho, blackfriars, spitalfields, lambeth, battersea, pimlico, marylebone, hyde-park, holborn, barbican}`

## E. Let these 404 (old test / junk pages — no redirect)
`/sitemap`, `/7914-2`, `/test`, `/test-booking`, `/another-test-page`, `/gallary-sli`, `/qa`, `/patients-story`, `/a-review-of-the-evidence-base-acupuncture-for-ivf-or-icsi`, `/old-fertility-landing-page-gads`

---

## ⚠️ Three flags for the marketing agency

1. **`/thank-you` was the Google Ads conversion trigger page on the old site.** The new site does not have a `/thank-you` URL — a completed booking now fires a **`booking_confirmed` event to the dataLayer** (with service, location, value, currency). **Please re-point the Google Ads (and GA4) conversion trigger from "`/thank-you` pageview" to the `booking_confirmed` dataLayer event** in GTM, or conversions will stop recording after cutover.

2. **The ~18 `the-best-acupuncture-clinic-near-*` pages are local-SEO landing pages** that rank for "acupuncture near \<area\>". Redirecting them all to `/` will lose that local ranking — please advise if you want any of them rebuilt as dedicated pages on the new site instead.

3. **Cross-domain enquiry funnel:** the old site's GA has a cross-domain linker to **`acuproclinic.submitenquiry.uk`**. Please confirm how this third-party enquiry/landing setup should be handled after the migration (kept as-is, or re-pointed to the new site's `/book/`).

## Tracking that is already in place on the new site
- **Google Tag Manager** container **`GTM-WC78T4W`** is installed on every page (same container as the old site) — so GA4 (`G-2PNNJW5W38`, `G-R5TLFS21SY`), Google Ads (`AW-834082397`) and the Meta Pixel (`1289276539175875`) all continue to load through it.
- The **`booking_confirmed`** dataLayer event fires on a successful booking (see Flag 1).
- No cookie-consent banner (matching the old site's current behaviour).

## Open item on our side
- These redirects are drafted but **not yet live** — we will implement them at the edge (Cloudflare Worker) once you have reviewed the targets in sections B/C/D. They will be verified on a staging URL before the DNS switch.
