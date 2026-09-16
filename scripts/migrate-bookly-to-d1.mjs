#!/usr/bin/env node
// AcuPro 数据迁移：旧 Bookly (MySQL) → 新 D1
// ------------------------------------------------------------------
// 用法（切换当天）：
//   1) 从线上（或副本）只导出需要的 3 张表为 TSV（~10MB，不导整库）：
//        mysql --batch --raw -e "SELECT id,full_name,first_name,last_name,phone,email,notes,created_at FROM wp_bookly_customers"            <DB> > customers.tsv
//        mysql --batch --raw -e "SELECT id,location_id,staff_id,service_id,start_date,end_date,internal_note,created_at FROM wp_bookly_appointments" <DB> > appointments.tsv
//        mysql --batch --raw -e "SELECT id,customer_id,appointment_id,status,notes,created_at FROM wp_bookly_customer_appointments"          <DB> > customer_appointments.tsv
//   2) 生成 D1 导入 SQL：
//        node scripts/migrate-bookly-to-d1.mjs --dir ./export --wipe > d1-import.sql
//   3) 核对摘要（脚本会把统计打到 stderr），确认无误后导入 D1：
//        npx wrangler d1 execute acupro-booking --remote --file d1-import.sql
//
// 说明：脚本只读 TSV、只输出 SQL，**不连线上、不碰在写的库**。
// 先用 7 周前的本地副本 dump 跑一遍(--dir 指向副本导出的 TSV)验证再上真数据。
// ------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

// ---- 可调映射（切换当天按 wp_bookly_staff / 新 practitioners 对照填好）----
// 旧 Bookly staff_id → 新 practitioner id；对不上的填 null（= 未分配，事后在后台拖）
const STAFF_MAP = {
  // 例：  12: 1,   // Bookly staff 12  →  新 practitioner 1 (Ting Wang)
};
// location_id / service_id 默认原样保留（新 D1 特意复用了同一套 id）。需要改就在这里覆盖。
const LOCATION_MAP = {};   // 例： {5: 3}
const SERVICE_MAP  = {};   // 例： {9: 2}
const DEDUP_BY_EMAIL = true; // 同邮箱合并为同一客户（新站身份=邮箱）；空邮箱各自独立

// ---- CLI ----
const args = process.argv.slice(2);
const dir = (args[args.indexOf("--dir") + 1]) || "./export";
const WIPE = args.includes("--wipe"); // 先清掉 D1 里现有(测试)数据

// ---- TSV 解析（mysql/mariadb --batch：制表符分隔，NULL = \N，首行列名；
//      数据里的换行/制表符/反斜杠被转义成 \n \t \\，需还原）----
function unesc(s) {
  return s.replace(/\\([0ntr\\])/g, (_, c) => (c === "0" ? "\0" : c === "n" ? "\n" : c === "t" ? "\t" : c === "r" ? "\r" : "\\"));
}
function readTsv(file) {
  const raw = fs.readFileSync(path.join(dir, file), "utf8");
  const lines = raw.split("\n").filter((l) => l.length);
  const cols = lines[0].split("\t");
  return lines.slice(1).map((line) => {
    const cells = line.split("\t");
    const o = {};
    // mariadb --batch 把 NULL 导成字面 "NULL"（本数据里 空串='' 与 NULL 有区分）；也兼容 mysql 的 \N
    cols.forEach((c, i) => { o[c] = cells[i] === "NULL" || cells[i] === "\\N" || cells[i] === undefined ? null : unesc(cells[i]); });
    return o;
  });
}
const sql = (v) => v === null || v === undefined ? "NULL" : "'" + String(v).replace(/'/g, "''") + "'";
const num = (v) => v === null || v === undefined || v === "" ? "NULL" : String(Number(v));

const customers = readTsv("customers.tsv");
const appts     = readTsv("appointments.tsv");
const capps     = readTsv("customer_appointments.tsv");

// ---- 客户按邮箱去重：建 旧customer_id → 规范customer_id 映射 ----
const canonical = {};              // oldCustomerId → keepCustomerId
const emailToId = {};              // lower(email) → keepCustomerId
const keptCustomers = [];
for (const c of customers) {
  const email = (c.email || "").trim().toLowerCase();
  if (DEDUP_BY_EMAIL && email && emailToId[email]) {
    canonical[c.id] = emailToId[email];          // 合并到已存在的同邮箱客户
  } else {
    canonical[c.id] = c.id;
    if (email) emailToId[email] = c.id;
    // 姓名：full_name 优先，空则用 first+last
    const name = (c.full_name && c.full_name.trim()) || [c.first_name, c.last_name].filter(Boolean).join(" ").trim();
    keptCustomers.push({ id: c.id, full_name: name, phone: c.phone, email: c.email, notes: c.notes, created_at: c.created_at });
  }
}

// ---- 输出 SQL ----
const out = [];
out.push("-- AcuPro Bookly → D1 迁移，自动生成，请先核对再执行");
out.push("PRAGMA foreign_keys=OFF;");
if (WIPE) {
  out.push("DELETE FROM customer_appointments;");
  out.push("DELETE FROM appointments;");
  out.push("DELETE FROM customers;");
}
// customers
for (const c of keptCustomers) {
  out.push(`INSERT INTO customers (id,full_name,phone,email,notes,created_at) VALUES (${num(c.id)},${sql(c.full_name)},${sql(c.phone)},${sql(c.email)},${sql(c.notes)},${sql(c.created_at)});`);
}
// appointments（staff/location/service 映射；补 cancel_token）
let unmappedStaff = new Set();
for (const a of appts) {
  let staff = STAFF_MAP.hasOwnProperty(a.staff_id) ? STAFF_MAP[a.staff_id] : null;
  if (staff === null && a.staff_id) unmappedStaff.add(a.staff_id);
  const loc = a.location_id != null && LOCATION_MAP[a.location_id] != null ? LOCATION_MAP[a.location_id] : a.location_id;
  const svc = a.service_id  != null && SERVICE_MAP[a.service_id]  != null ? SERVICE_MAP[a.service_id]  : a.service_id;
  out.push(`INSERT INTO appointments (id,location_id,staff_id,service_id,start_date,end_date,internal_note,cancel_token,created_at) VALUES (${num(a.id)},${num(loc)},${staff===null?"NULL":num(staff)},${num(svc)},${sql(a.start_date)},${sql(a.end_date)},${sql(a.internal_note)},${sql(crypto.randomUUID())},${sql(a.created_at)});`);
}
// customer_appointments（customer_id 映射到规范 id）
for (const ca of capps) {
  const cust = canonical[ca.customer_id] ?? ca.customer_id;
  out.push(`INSERT INTO customer_appointments (id,customer_id,appointment_id,status,notes,created_at) VALUES (${num(ca.id)},${num(cust)},${num(ca.appointment_id)},${sql(ca.status || "approved")},${sql(ca.notes)},${sql(ca.created_at)});`);
}
out.push("PRAGMA foreign_keys=ON;");
process.stdout.write(out.join("\n") + "\n");

// ---- 摘要到 stderr（核对用）----
console.error("=== 迁移摘要 ===");
console.error("原始客户:", customers.length, " → 去重后:", keptCustomers.length, DEDUP_BY_EMAIL ? "(按邮箱合并)" : "(未去重)");
console.error("预约:", appts.length, " 客户-预约关系:", capps.length);
if (unmappedStaff.size) console.error("⚠️ 未映射的 staff_id(将落未分配):", [...unmappedStaff].join(", "), " → 在 STAFF_MAP 里补全可自动分配医生");
