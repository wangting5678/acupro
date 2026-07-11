# AcuPro Clinic — 新官网 & 预约系统

诊所官网重构项目:抛弃旧的 WordPress,改为轻量自建站 + 自建预约系统,全部托管在 **Cloudflare**(无服务器、无 CMS、几乎零成本)。

---

## 1. 整体架构

```
Portal(入口站,单独项目)
   ├─→ UK 站   ← 本仓库,已上线
   ├─→ UAE 站  ← 待做(先留空)
   └─→ Global 站 ← 待做(先留空)

UK 站
   ├─ 公开站(顾客预约)      → Cloudflare Worker + 静态页
   ├─ 后台(员工管预约)      → 独立 Cloudflare Worker(单独域名)
   └─ 数据库(预约数据)      → Cloudflare D1(SQLite)
```

- **公开站**和**后台**是两个独立部署(不同域名),但共用**同一个 D1 数据库**。
- 后台单独域名,方便以后单独加访问策略(Cloudflare Access)。

---

## 2. 线上地址

| 用途 | 地址 |
| --- | --- |
| 公开站(顾客预约) | https://acupro-uk.jinzhiqi19860716.workers.dev |
| 后台(员工管预约) | https://acupro-admin.jinzhiqi19860716.workers.dev |
| 代码仓库 | https://github.com/wangting5678/acupro (private) |

**后台登录密码:`acupro2026`**(明文存于 `admin/wrangler.jsonc`,可改;上正式域名后会换成 Cloudflare Access 身份门禁)

Cloudflare 账号:`Jinzhiqi0716@gmail.com`(workers.dev 子域 `jinzhiqi19860716`)

---

## 3. 代码结构

```
acupro/
├── src/                    前端(Vite + React + TS)
│   ├── pages/
│   │   ├── Home.tsx        首页(hero/服务/团队/诊所/CTA)
│   │   └── Booking.tsx     预约流程(4 步)
│   ├── components/
│   │   └── Layout.tsx      页头 + 页脚
│   ├── lib/
│   │   └── availability.ts 可预约时段计算(按员工排班)
│   ├── data.ts             加载 data/*.json
│   ├── styles.css          设计系统(暖色调)
│   └── main.tsx            入口 + 路由
│
├── worker/
│   └── index.ts            公开站后端:POST /api/book 写入 D1;其余走静态资源
│
├── admin/                  【独立部署】员工后台
│   ├── index.ts            登录 + 预约列表 + 改状态(自包含 HTML+API)
│   └── wrangler.jsonc      后台部署配置(含 ADMIN_PASSWORD)
│
├── db/
│   ├── schema.sql          D1 表结构(对齐旧站 Bookly)
│   └── seed.sql            种子数据(从旧站提取)
│
├── data/                   从旧站 acuproclinic.co.uk 提取的真实数据
│   ├── services.json       15 个服务项
│   ├── service_categories.json
│   ├── staff.json / staff_services.json / schedules.json
│   ├── locations.json      3 个地点
│   ├── team.json           11 位团队成员
│   └── clinics.json        3 家诊所信息
│
├── wrangler.jsonc          公开站部署配置(绑定 D1 + 静态资源)
└── package.json
```

---

## 4. 数据库(Cloudflare D1)

- **数据库名**:`acupro-booking`
- **Database ID**:`0e9d5182-ea69-471a-9743-42c750a5a839`
- **类型**:SQLite(Cloudflare D1),免费额度内
- 表结构对齐旧站 Bookly 核心表,方便将来一次性迁移旧数据。

### 表说明

| 表 | 作用 | 数据来源 |
| --- | --- | --- |
| `locations` | 诊所地点(Victoria / City / 线上) | 种子 |
| `services` | 服务项(初诊/TCM问诊/推拿…)+ 价格/时长 | 种子 |
| `staff` | 理疗师 | 种子 |
| `staff_services` | 谁能做哪个服务、在哪个地点 | 种子 |
| `staff_schedule_items` | 每周排班(算可约时段用) | 种子 |
| `customers` | 顾客(预约时写入) | 运行时 |
| `appointments` | 预约(时间/服务/地点/员工) | 运行时 |
| `customer_appointments` | 顾客↔预约 关联 + 状态(pending/approved/cancelled/done) | 运行时 |

### 常用命令

```bash
# 查询线上数据库
npx wrangler d1 execute acupro-booking --remote \
  --command="SELECT * FROM customer_appointments ORDER BY id DESC LIMIT 10;"

# 重建表结构 / 重新灌种子(会清空重来)
npx wrangler d1 execute acupro-booking --remote --file=db/schema.sql
npx wrangler d1 execute acupro-booking --remote --file=db/seed.sql
```

---

## 5. 本地开发 & 部署

```bash
# 本地预览(前端,不含 Worker/D1)
npm install
npm run dev                 # http://localhost:5199

# 部署公开站(构建 + 推 Cloudflare)
npm run deploy

# 部署后台(独立 worker)
cd admin && npx wrangler deploy
```

> Git 推送:本仓库用专用 SSH key `~/.ssh/acupro_wangting`(个人账号 wangting5678,与公司账号隔离)。直接 `git push` 即可。

---

## 6. 相关本地资料(不在本仓库)

| 路径 | 内容 |
| --- | --- |
| `~/Documents/acupro-wp-uk/` | 旧 WordPress 站的代码 + 数据库副本(299MB),用于提取内容 |
| `~/Documents/acupro-clinic/` | Portal 入口站(Codex 生成,单独项目) |
| Docker 容器 `acupro-mysql` | 旧站数据库(MariaDB,端口 33061,root/root,库 `acupro`),平时停着,提取内容时 `docker start acupro-mysql` |

---

## 7. 待办(TODO)

- [ ] 全量内容提取(旧站 ~150 页:病症/治疗/博客,存于 ACF/Elementor)
- [ ] 服务端时段防冲突(对已有预约查重)
- [ ] 预约确认/提醒邮件
- [ ] 上正式域名 + Cloudflare Access(后台身份门禁)+ 把明文密码换成 secret
- [ ] UAE 站 / Global 站
- [ ] Portal 接入(入口跳转到各区域站)
- [ ] 设计 / 文案打磨
