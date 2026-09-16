# AcuPro 上线操作手册 — 把 acuproclinic.co.uk 切到新站(Cloudflare)

目标:域名不变,把 `acuproclinic.co.uk` 从旧 WordPress 切到新站(Cloudflare Worker),
做到**网站换新、邮件不断、SEO/广告不掉**。

关键角色：
- **注册商 = IONOS**（`login.ionos.com`，账号 `530639474`，有 2FA）—— 改 NS 在这里，**你有权限**。
- **当前 DNS = AWS Route 53**（旧代理商 GenUp 管，你无权限）—— 切走后就不用它了。
- **新站 Cloudflare 账号**：`Jinzhiqi0716@gmail.com`。

---

## 阶段 0 —— 切之前的准备（不影响线上，慢慢做）

**0.1 先把 301 跳转做好并验证**
- 代理商确认 `REDIRECTS.en.md` 的目标后，我把 301 写进 Worker，在测试地址 `acupro-uk.jinzhiqi19860716.workers.dev` 上逐条验证 OK。

**0.2 在你的 Cloudflare 账号里添加站点**
- Cloudflare 后台 → Add a site → 输入 `acuproclinic.co.uk` → 选 **Free** 方案。
- Cloudflare 会尝试扫描现有记录，但它读不全 Route 53 的内容，**必须手动核对下面 0.3 的记录，缺的补齐**。
- ⚠️ 如果提示"该域名已在另一个 Cloudflare 账号"（因为 apex 现在指向 Cloudflare IP `162.159.x`，可能已接在别人账号上）→ 先找出是谁的账号、让其释放，或联系 Cloudflare 支持。**这一步先确认，别到切的时候才发现。**

**0.3 在 Cloudflare DNS 里，先把这些记录建好（切 NS 前必须齐，否则邮件/验证会断）**

| 类型 | 名称 | 值 | 代理(橙云) | 用途 |
|---|---|---|---|---|
| A | `mail` | `77.95.113.65` | **关**(灰云 DNS only) | 邮件服务器 |
| MX | `@` | `mail.acuproclinic.co.uk`（优先级 0） | — | 收邮件 |
| TXT | `@` | `v=spf1 a mx include:spf.mysecurecloudhost.com ~all` | — | 发信 SPF |
| TXT | `@` | `MS=ms35951445` | — | Microsoft 365 验证 |
| TXT | `@` | `google-site-verification=utQNg4J5E5wnU4oncqdiSNgLzboHm8Bl-Mn3SW31zhI` | — | Google 验证 |

- ⚠️ **DKIM**：旧站可能有 DKIM（我用常见 selector 没探到，可能是自定义 selector）。**上线前找邮箱服务商（mysecurecloudhost）或代理商要 DKIM 记录**，一并加上，否则发信可能被判垃圾。
- ⚠️ 若还有其他子域（代理商可能建过别的），最好也向代理商要一份 Route 53 的完整导出核对。

**0.4 把新站 Worker 挂成自定义域名**
- Cloudflare → Workers & Pages → 选中 `acupro-uk` Worker → Settings → Domains & Routes → Add Custom Domain → 加 `acuproclinic.co.uk` 和 `www.acuproclinic.co.uk`。
- Cloudflare 会**自动建好代理记录 + 免费 TLS 证书**（根域名靠 CNAME flattening，正常）。
- 这一步在 NS 还没切的时候就能配好，属于"预备好、等生效"。

**0.5 记下 Cloudflare 给的两个 nameserver**（形如 `xxx.ns.cloudflare.com`）。

---

## 阶段 1 —— 正式切（在 IONOS 改 NS）

**1.1** 登录 IONOS（`530639474` + 邮箱验证码）→ 找到 `acuproclinic.co.uk` → Nameserver 设置。
**1.2** 把 NS 从 AWS 的（`ns-*.awsdns-*`）**改成 Cloudflare 给的那两个**，保存。
**1.3** 开始传播：`.co.uk` 的 NS 传播**最长可能 24–48 小时**（通常几小时）。这个 TTL 在顶级域那边，改不了，所以**挑低峰时段做，别指望秒切**。

> 旧站(Kinsta WP)这期间**保持开着**，做后路。

---

## 阶段 D —— 数据库迁移（旧 Bookly MySQL → 新 D1）

**数据来源 / 目标**
- 旧库：Kinsta 上的 WordPress/**Bookly** MySQL（表 `wp_bookly_customers` / `wp_bookly_appointments` / `wp_bookly_customer_appointments` / `wp_bookly_staff` / `wp_bookly_services`）。
  - Kinsta SSH/SFTP：`acuproclinic@130.162.161.233:59931`（密码见 `CREDENTIALS.local.md`）。
  - 本地已有一份副本：Docker 容器 `acupro-mysql`，端口 `33061`，`root`/`root`，库 `acupro`。
- 新库：Cloudflare **D1 `acupro-booking`**（表 `customers` / `appointments` / `customer_appointments`）。

**为什么能直接搬**：新 D1 的表是**照着 Bookly 结构建的**，`location_id`(3/11/4) 和 `service_id` 直接复用 → 姓名/电话/邮箱/日期/服务/诊所是**字段直映射**。规模约 **5,516 客户 + 25,373 预约**。唯一模糊的是 Bookly 的 `staff_id` → 新 `practitioner id`，对不上的先落"未分配"，事后在后台拖。

**⚠️ 库大小澄清**：整个 WordPress 库 dump 有 **299MB**，但那含帖子/WooCommerce/日志，**不迁**。真正要迁的 3 张表（customers + appointments + customer_appointments）**加起来只 ~10MB** → 走一下 Mac 也就几秒，**不需要特殊"直迁"管道**；真要洁癖，切换当天只单独导这 3 张表即可，不碰整库。

**现成脚本**：`scripts/migrate-bookly-to-d1.mjs`（已写好）。它只读 TSV 导出、只输出 D1 SQL，**不连线上库**。用法见脚本头部注释：导出 3 张表 → `node ... --dir ./export --wipe > d1-import.sql` → `wrangler d1 execute acupro-booking --remote --file d1-import.sql`。内置按邮箱去重、staff_id 映射（`STAFF_MAP` 切换当天填）、自动补 `cancel_token`。**先用 7 周前的本地副本 `acupro-wp-uk/acupro_db.sql` 跑一遍验证再上真数据。**

**D.1（提前做，不影响线上）先在本地副本上写好并测通转换脚本**
- 用 Docker 里的 `acupro-mysql` 当练习场，写导出+转换脚本：Bookly 表 → D1 的三张表的 SQL/JSON。
- 建一张 `staff_id → practitioner_id` 映射表；映射不到的 `staff_id` 一律写 `NULL`(未分配)。
- 客户按**邮箱去重**（D1 里已有的逻辑：同邮箱=同一人）。
- 在本地/preview D1 上跑通、核对条数无误，再上真库。

**D.2（切换当天执行）导入正式 D1**
1. **拉最新的**旧数据（不要用旧快照——切换那天现导出，避免漏掉最近的预约）。
2. **清掉 D1 里的测试/假数据**（`customers` / `appointments` / `customer_appointments` 三表），然后导入真实数据。
3. 用 `wrangler d1 execute acupro-booking --remote --file=...` 批量导入（大表分批）。
4. 核对：D1 里客户数/预约数 ≈ 5,516 / 25,373，抽查几条姓名+日期对得上。

**⚠️ D.3 传播期的"预约缺口"（重点）**
`.co.uk` 换 NS 传播最长 48h，这期间**部分用户还会打到旧站、可能在旧 Bookly 下新单**，这些不在 D1 里。处理办法二选一：
- **（推荐）切换窗口内把旧站预约先"关掉/改成打电话"**：传播完再恢复，缺口最小。
- **或**允许缺口，切完后做一次**增量导出**：把切换期间旧站新增的预约再导一遍进 D1（靠邮箱+时间去重，不会重复）。

> 迁移顺序建议：**D.1 提前测好** →（低峰）**先导历史数据 D.2** → **切 NS(阶段 1)** → 传播完 → **补增量 D.3** → 全部核对 OK → 关旧站。

---

## 阶段 2 —— 切完验证（传播生效后）

- [ ] `dig NS acuproclinic.co.uk` → 显示 Cloudflare 的 NS
- [ ] 打开 `https://acuproclinic.co.uk` → 是新站，TLS 证书正常（小锁头）
- [ ] 抽查几条旧链接（`/about`、`/clinics`、`/thank-you`、某个 `/conditions/xxx`）→ 正确 301 跳到新页
- [ ] **发/收一封 `@acuproclinic.co.uk` 的邮件** → 正常（证明 MX 没断）
- [ ] **数据库**：后台 Customers/Appointments 里能看到导入的真实客户和历史预约，条数对得上；切换期间的新单已补齐（阶段 D.3）
- [ ] 代理商确认 GTM/GA/Ads 在正式域名上触发、`booking_confirmed` 转化能记录
- [ ] Search Console：用 DNS TXT（已在 Cloudflare）或页面 meta 验证 → **重新提交新 sitemap**
- [ ] 代理商把 Google Ads 的 **Final URL** 改成新路径

---

## 阶段 3 —— 回滚方案（万一出问题）

- 回 IONOS 把 NS **改回 AWS 那四个**（`ns-1318.awsdns-36.org` / `ns-1755.awsdns-27.co.uk` / `ns-366.awsdns-45.com` / `ns-626.awsdns-14.net`）→ 传播后又回到旧站。
- 因为旧 WP 一直没关，回滚是安全的。

---

## 最容易踩的 4 个坑
1. **邮件**：MX + `mail` 的 A + SPF + DKIM 必须先在 Cloudflare 建好再切 NS，否则一切 NS 邮件就挂。
2. **域名可能已在别的 Cloudflare 账号**（apex 现指向 Cloudflare IP）→ 阶段 0.2 先确认，别拖到最后。
3. **`.co.uk` NS 传播慢**（最长 48h），不是即时；低峰做、留足时间、旧站别提前关。
4. **数据库缺口**：传播期旧站还能下单，这些单不在 D1 → 用阶段 D.3（关旧站预约 或 补增量导入）兜住，别让这几天的预约丢了。

## 当前各方权限速查
- IONOS（改 NS）：你有 ✅
- Route 53（看旧记录）：代理商 GenUp，你无 —— 所以旧记录我尽量 dig 公开的，DKIM 等要找代理商/邮箱商要
- Cloudflare（新站）：你有 ✅
