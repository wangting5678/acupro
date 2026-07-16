# AcuPro Clinic — 运维文档

诊所官网 + 预约系统。抛弃旧 WordPress,全部跑在 **Cloudflare**(Serverless,无 CMS,几乎零成本)。这份是运维速查,给老板看的使用手册见 `USER_GUIDE.md`。

---

## 1. 线上地址

| 用途 | 地址 |
| --- | --- |
| UK 公开站(顾客,£) | https://acupro-uk.jinzhiqi19860716.workers.dev |
| UAE 公开站(顾客,AED,EN/AR) | https://acupro-uae.jinzhiqi19860716.workers.dev |
| 后台(员工管预约) | https://acupro-admin.jinzhiqi19860716.workers.dev |
| Portal / Global 入口站 | https://acuproclinic-redesign.jinzhiqi19860716.workers.dev |
| 代码仓库(UK/UAE/后台) | https://github.com/wangting5678/acupro (private) |
| Portal 代码 | 本地 `~/Documents/acupro-clinic`(本地 git,无远程) |

---

## 2. 地址密码 / 账号

| 项 | 值 |
| --- | --- |
| **后台登录密码** | `acupro2026`(明文在 `admin/wrangler.jsonc`;上正式域名后换 Cloudflare Access) |

### Cloudflare 登录(所有站都托管在这)

| 项 | 值 |
| --- | --- |
| 登录地址 | https://dash.cloudflare.com/login |
| 账号(邮箱) | `Jinzhiqi0716@gmail.com` |
| 密码 | **【待填 —— 在你的密码管理器】** |
| Account ID | `301b0710e94c86b605b42ed250e26018` |
| workers.dev 子域 | `jinzhiqi19860716` |

> 登录后:Workers & Pages 看所有 Worker(acupro-uk / acupro-uae / acupro-admin / acuproclinic-redesign);Storage & Databases → D1 看 `acupro-booking`。

### 其他账号

| 项 | 值 |
| --- | --- |
| 邮件服务 Resend 账号 | `jinzhiqi0716@gmail.com`(密码在你的密码管理器) |
| 发件人 | `bookings@acuproclinic.uk`(Resend 已验证域名) |
| Resend API Key | 只以 `wrangler secret` 存在,不进代码/文档 |
| Git 推送 SSH key | `~/.ssh/acupro_wangting`(个人号 wangting5678,与公司号隔离);直接 `git push` |
| D1 数据库 | 名 `acupro-booking`,ID `0e9d5182-ea69-471a-9743-42c750a5a839` |

---

## 3. 框架(简单说)

- **Cloudflare Workers**:每个站是一个 Worker(serverless,无需服务器/nginx/证书)。
- **Cloudflare D1**:一个 SQLite 数据库 `acupro-booking`,**UK / UAE / 后台三个 Worker 共用它**。
- **公开站**(UK/UAE):Astro 静态页 + 一个 Worker 处理预约 API(`worker/index.ts`);同一套代码,靠**环境变量**区分地区/币种/语言。
- **后台**:单个 Worker(`admin/index.ts`,HTML+API 全在一个文件),独立域名方便加门禁。
- **Portal**:独立项目(vinext),纯展示 + 跳转 UK/UAE/Global,无预约。
- **邮件**:Resend(HTTP API,从 Worker 直接发)。
- 一句话:**代码一套,数据库一个,靠每个 Worker 的环境变量分出 UK/UAE。**

### 各站靠环境变量区分(在各自 wrangler 配置的 `vars` 里)

| 变量 | UK | UAE |
| --- | --- | --- |
| `SITE_CURRENCY` | GBP | AED |
| `SITE_LANGS` | (无) | en,ar |
| `PUBLIC_URL` | UK 站地址 | UAE 站地址 |

> 服务/医生/地点都带 `region` 字段(UK/UAE),接口按站点地区过滤;币种、时区(UK=London,UAE=Dubai)、可预约时段都自动跟着走。

---

## 4. 部署命令

```bash
cd ~/Documents/acupro-uk

npm run deploy                              # UK 公开站(自动 build)
npx wrangler deploy -c wrangler.uae.jsonc   # UAE 公开站(共用同一 build)
cd admin && npx wrangler deploy             # 后台

# Portal:
cd ~/Documents/acupro-clinic && npm run build && npx wrangler deploy -c dist/server/wrangler.json

# 改完推 GitHub:
git push
```

> 部署后浏览器可能有缓存,自己看时 **Cmd+Shift+R** 强刷一次。

---

## 5. 数据库常用操作

```bash
# 查询
npx wrangler d1 execute acupro-booking --remote --command="SELECT * FROM appointments ORDER BY id DESC LIMIT 10;"

# 执行 SQL 文件(改结构 / 灌数据)
npx wrangler d1 execute acupro-booking --remote --file db/schema.sql
```

**主要表**:`locations` 地点 · `services` 服务(含 region/币种价/可见性/描述)· `practitioners` 医生(含 clinics/hours 关联/bio/photo)· `working_hours` 每周排班 · `customers` 顾客 · `appointments` 预约(含 `cancel_token` 自助取消令牌)· `customer_appointments` 顾客↔预约 · `staff_notes` 同事留言板 · `settings` 杂项。

---

## 6. 关键文件

```
acupro-uk/
├─ src/                前端(Astro + React 岛)
│  ├─ pages/           book.astro / cancel.astro / index.astro / pricing / our-team / conditions
│  ├─ components/      Booking.tsx(预约流程,含 EN/AR i18n)· Cancel.tsx(自助取消)
│  └─ layouts/Base.astro  页头页脚(含语言切换按钮)
├─ worker/index.ts     公开站后端:/api/book /availability /services /locations /site /booking /cancel
├─ admin/index.ts      【独立】后台:日/周/月视图、拖拽、医生、服务、留言板、邮件
├─ public/enhance.js   公开站增强:实时价格、info 悬浮提示、Team 派生、EN/AR 切换
├─ wrangler.jsonc      UK 配置    ·  wrangler.uae.jsonc  UAE 配置
└─ db/schema.sql
```

---

## 7. 待办 / 上线前

- [ ] 上正式域名:`acuproclinic.co.uk` DNS(在 **AWS Route 53**,不是 IONOS)→ 指向 Cloudflare;把各站 `PUBLIC_URL` 改成正式域名。
- [ ] 后台加 **Cloudflare Access** 门禁 + 把明文密码换掉。
- [ ] 数据迁移:旧站 `customers`/`appointments` 直译导入(结构已对齐 Bookly);切换时拉最新数据。
- [ ] UAE 数据现为占位(Abu Dhabi 诊所、AED 价格、3 位示例医生),在后台改成真实的。
- [ ] 阿拉伯语目前只有界面框架;数据库内容(服务名等)如需阿拉伯语要加双语字段。
- [ ] 邮件:UAE Worker 已配 Resend secret;旧域名 `.co.uk` 若要当发件人需在 Resend 验证。
