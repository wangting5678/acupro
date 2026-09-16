# 旧站 → 新站 URL 映射（301 跳转计划）

来源：旧站 Yoast sitemap（acuproclinic.co.uk，still old WordPress），2026-09 抓取。
用途：DNS 切到新站前，把这些 301 写进 Worker，保住 SEO 排名 + 广告落地页不 404。
新站页面：`/` `/pricing/` `/our-team/` `/conditions/` `/conditions/<slug>`(31) `/book/` `/cancel/`。

---

## A. 完全不用跳转（URL 新旧一模一样，直接继承排名）✅
- `/`
- `/pricing`
- `/our-team`
- `/conditions`
- `/conditions/<slug>` —— 旧站 27 个条件页 slug（headache-migraines, arthritis, plantar-fasciitis, sciatica, achilles-tendinitis, back-pain, neck-shoulder-pain, gout, infertility, menstruation-cycle, menopausal-syndromes, wrinkles, eczema, acne, ivf-support, pms, labour-assist, ibs-indigestive, sperm-quality, excessive-weight, thyroid-function, insomnia, immune-function, anxiety-stress, mesotherapy, thermage, mesotherapy-microneedling）**全部**在新站存在，路径相同 → **0 跳转**。

## B. 单页 301（旧 → 新）
| 旧 URL | 新目标 |
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
| `/thank-you` | `/`  ⚠️ 见下方旗标① |
| `/shop`, `/basket`, `/checkout`, `/my-account` | `/` |

## C. 前缀/批量 301（一整类 → 一个目标）
| 旧前缀 | 新目标 | 数量 |
|---|---|---|
| `/our-team/<slug>` （医生个人页） | `/our-team/` | 10 |
| `/acupuncture/<slug>` | `/pricing/` | 5 |
| `/herbal-medicine/<slug>`, `/herbal-medicines/<slug>` | `/pricing/` | — |
| `/massage/<slug>` | `/pricing/` | — |
| `/aesthetic/<slug>` | `/pricing/` | — |
| `/wellbeing/<slug>` | `/pricing/` | — |
| `/product/<slug>`, `/product-category/<slug>` （WooCommerce） | `/` | — |
| 博客文章（post-sitemap） | `/` | — |

## D. 本地 SEO 落地页（旧站 ~18 个）→ `/`（见旗标②）
`/the-best-acupuncture-clinic-near-{victoria-london, city-of-london, westminster, belgravia, chelsea, kensington, mayfair, soho, blackfriars, spitalfields, lambeth, battersea, pimlico, marylebone, hyde-park, holborn, barbican}` 等 → 暂时全部 `/`。

## E. 让它 404（测试/垃圾页，不用跳）
`/sitemap`, `/7914-2`, `/test`, `/test-booking`, `/another-test-page`, `/gallary-sli`, `/qa`, `/patients-story`, `/a-review-of-the-evidence-base-acupuncture-for-ivf-or-icsi`, `/old-fertility-landing-page-gads`

---

## ⚠️ 给代运营的三个旗标
1. **`/thank-you` = 旧站的 Google Ads 转化触发页**。新站没有这个页，预约成功改用 `booking_confirmed` 这个 dataLayer 事件 → 代运营必须把 Ads 转化触发从"/thank-you 页面浏览"改成"booking_confirmed 事件"。
2. **18 个 `the-best-acupuncture-clinic-near-*` 是本地 SEO 落地页**，排"某地附近针灸"。全部 301 到 `/` 会丢这部分本地流量；代运营可能想挑几个在新站重建成独立页。
3. **`acuproclinic.submitenquiry.uk`** 跨域询盘（代运营的第三方落地页）—— 切换时单独跟他们确认怎么处理。

## 待办
- [ ] 上面 B/C/D 待你 or 代运营确认目标无误后，写进 Worker（`worker/index.ts`，请求进来先匹配 301 表再走正常路由）。
- [ ] 剩余未逐条抓取的 sitemap（product / post / massage / aesthetic / wellbeing / herbal-medicine 的完整 URL 列表）用上面的**前缀规则**覆盖即可，无需逐个列。
