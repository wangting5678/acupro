/// <reference types="@cloudflare/workers-types" />

export interface Env {
  DB: D1Database;
  ADMIN_PASSWORD: string;
  RESEND_API_KEY?: string;
  MAIL_FROM?: string;
}

const json = (d: unknown, s = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json", ...headers } });

const CLINIC_INFO: Record<number, { name: string; addr: string; phone: string }> = {
  3: { name: "London Victoria", addr: "10 Buckingham Palace Rd, London, SW1W 0QP", phone: "07521 808882" },
  11: { name: "City of London", addr: "33-34 Bury St, London, EC3A 5AR", phone: "07521 808882" },
  4: { name: "Online Video Consultation", addr: "Online", phone: "+44 (0)20 3239 7888" },
};
async function sendMail(env: Env, to: string, subject: string, html: string) {
  if (!env.RESEND_API_KEY || !to) return;
  const from = env.MAIL_FROM || "AcuPro Clinic <onboarding@resend.dev>";
  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: "Bearer " + env.RESEND_API_KEY, "content-type": "application/json" },
      body: JSON.stringify({ from, to, subject, html }),
    });
  } catch { /* ignore */ }
}
// Notify patient + assigned practitioner about a booking (new or changed).
async function notifyBooking(env: Env, appointmentId: number, kind: "new" | "updated") {
  try {
    const r = await env.DB.prepare(
      `SELECT c.full_name, c.email AS pemail, s.title AS service, a.location_id, a.start_date, ca.notes,
              p.email AS demail
       FROM appointments a
       JOIN customer_appointments ca ON ca.appointment_id=a.id
       JOIN customers c ON c.id=ca.customer_id
       LEFT JOIN services s ON s.id=a.service_id
       LEFT JOIN practitioners p ON p.id=a.staff_id
       WHERE a.id=? LIMIT 1`,
    ).bind(appointmentId).first<any>();
    if (!r) return;
    const clinic = CLINIC_INFO[r.location_id] || { name: "AcuPro Clinic", addr: "", phone: "" };
    const date = (r.start_date || "").slice(0, 10), time = (r.start_date || "").slice(11, 16);
    const verb = kind === "new" ? "confirmed" : "updated";
    const pHtml = `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.6"><p>Dear ${r.full_name},</p><p>Your AcuPro Clinic appointment has been ${verb}:</p><p><b>${r.service || "Appointment"}</b></p><p><b>Time:</b> ${date} @ ${time}</p><p><b>Location:</b> ${clinic.name}<br>${clinic.addr}<br>${clinic.phone}</p><p>To change or cancel, reply to this email.</p><p>Thank you for choosing AcuPro Clinic.</p></div>`;
    const dHtml = `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.6"><p>Hello.</p><p>Booking ${kind === "new" ? "added" : "updated"}.</p><p><b>Client:</b> ${r.full_name}<br><b>Service:</b> ${r.service || ""}<br><b>Date:</b> ${date}<br><b>Time:</b> ${time}<br><b>Location:</b> ${clinic.addr}</p></div>`;
    const jobs = [sendMail(env, r.pemail, `Your AcuPro appointment ${verb}`, pHtml)];
    if (r.demail) jobs.push(sendMail(env, r.demail, `Booking ${kind} — ${r.full_name}`, dHtml));
    await Promise.all(jobs);
  } catch { /* ignore */ }
}

async function sessionToken(pw: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(pw + "::acupro-admin-session"));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function getCookie(req: Request, name: string): string | null {
  const m = (req.headers.get("cookie") || "").match(new RegExp("(?:^|; )" + name + "=([^;]+)"));
  return m ? m[1] : null;
}
async function isAuthed(req: Request, env: Env): Promise<boolean> {
  const sess = getCookie(req, "sess");
  return !!sess && sess === (await sessionToken(env.ADMIN_PASSWORD));
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/api/login" && req.method === "POST") {
      const { password } = (await req.json()) as any;
      if (password !== env.ADMIN_PASSWORD) return json({ error: "Wrong password" }, 401);
      const tok = await sessionToken(env.ADMIN_PASSWORD);
      return json({ ok: true }, 200, { "set-cookie": `sess=${tok}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=86400` });
    }
    if (url.pathname === "/api/logout") return json({ ok: true }, 200, { "set-cookie": "sess=; Path=/; Max-Age=0" });

    if (url.pathname.startsWith("/api/") && !(await isAuthed(req, env))) return json({ error: "unauthorized" }, 401);

    if (url.pathname === "/api/meta" && req.method === "GET") {
      const [services, practitioners, locations] = await Promise.all([
        env.DB.prepare("SELECT id,title,price,duration_min,color FROM services ORDER BY title").all(),
        env.DB.prepare("SELECT id,name,photo,clinics FROM practitioners ORDER BY position").all(),
        env.DB.prepare("SELECT id,name,abbr FROM locations ORDER BY name").all(),
      ]);
      return json({ services: services.results, practitioners: practitioners.results, locations: locations.results });
    }

    if (url.pathname === "/api/appointments" && req.method === "GET") {
      const { results } = await env.DB.prepare(
        `SELECT ca.id, ca.notes, ca.customer_id, ca.appointment_id,
                c.full_name, c.email, c.phone,
                a.service_id, a.staff_id, a.location_id, a.start_date, a.end_date,
                s.title AS service, s.price, s.duration_min,
                l.name AS location, l.abbr AS loc_abbr,
                p.name AS practitioner, p.photo AS practitioner_photo
         FROM customer_appointments ca
         JOIN customers c ON c.id = ca.customer_id
         JOIN appointments a ON a.id = ca.appointment_id
         LEFT JOIN services s ON s.id = a.service_id
         LEFT JOIN locations l ON l.id = a.location_id
         LEFT JOIN practitioners p ON p.id = a.staff_id
         ORDER BY a.start_date LIMIT 1000`,
      ).all();
      return json({ appointments: results });
    }

    // fuzzy customer search (for the New booking modal)
    if (url.pathname === "/api/customers" && req.method === "GET") {
      const q = (url.searchParams.get("q") || "").trim();
      if (q.length < 2) return json({ customers: [] });
      const like = "%" + q + "%";
      const { results } = await env.DB.prepare(
        "SELECT id, full_name, email, phone FROM customers WHERE full_name LIKE ? OR phone LIKE ? OR email LIKE ? ORDER BY full_name LIMIT 12",
      ).bind(like, like, like).all();
      return json({ customers: results });
    }

    // drag-drop: reassign practitioner
    if (url.pathname === "/api/assign" && req.method === "POST") {
      const { appointment_id, staff_id } = (await req.json()) as any;
      await env.DB.prepare("UPDATE appointments SET staff_id=? WHERE id=?").bind(staff_id || null, appointment_id).run();
      return json({ ok: true });
    }

    if (url.pathname === "/api/update" && req.method === "POST") {
      const b = (await req.json()) as any;
      const { ca_id, appointment_id, customer_id, start_date, service_id, staff_id, location_id, notes, full_name, phone, email } = b;
      let end = start_date;
      if (service_id && start_date) {
        const svc = await env.DB.prepare("SELECT duration_min FROM services WHERE id=?").bind(service_id).first<{ duration_min: number }>();
        const t = new Date(start_date.replace(" ", "T") + "Z");
        end = new Date(t.getTime() + (svc?.duration_min ?? 60) * 60000).toISOString().slice(0, 19).replace("T", " ");
      }
      await env.DB.prepare("UPDATE appointments SET start_date=?, end_date=?, service_id=?, staff_id=?, location_id=? WHERE id=?")
        .bind(start_date, end, service_id ?? null, staff_id || null, location_id ?? null, appointment_id).run();
      await env.DB.prepare("UPDATE customer_appointments SET notes=? WHERE id=?").bind(notes ?? "", ca_id).run();
      if (customer_id) await env.DB.prepare("UPDATE customers SET full_name=?, phone=?, email=? WHERE id=?").bind(full_name ?? "", phone ?? "", email ?? "", customer_id).run();
      return json({ ok: true });
    }

    // admin creates a booking (back-fill / 补单 — any date/time allowed)
    if (url.pathname === "/api/create" && req.method === "POST") {
      const b = (await req.json()) as any;
      const { start_date, service_id, staff_id, location_id, notes, full_name, phone, email, customer_id } = b;
      if (!start_date || !full_name) return json({ error: "missing fields" }, 400);
      let end = start_date;
      if (service_id) {
        const svc = await env.DB.prepare("SELECT duration_min FROM services WHERE id=?").bind(service_id).first<{ duration_min: number }>();
        const t = new Date(start_date.replace(" ", "T") + "Z");
        end = new Date(t.getTime() + (svc?.duration_min ?? 60) * 60000).toISOString().slice(0, 19).replace("T", " ");
      }
      // reuse an existing customer (keep their contact info fresh) or create a new one
      let cust: { id: number } | null;
      if (customer_id) {
        await env.DB.prepare("UPDATE customers SET full_name=?, phone=?, email=? WHERE id=?").bind(full_name, phone ?? "", email ?? "", customer_id).run();
        cust = { id: customer_id };
      } else {
        cust = await env.DB.prepare("INSERT INTO customers(full_name,phone,email) VALUES(?,?,?) RETURNING id").bind(full_name, phone ?? "", email ?? "").first<{ id: number }>();
      }
      const appt = await env.DB.prepare("INSERT INTO appointments(location_id,staff_id,service_id,start_date,end_date) VALUES(?,?,?,?,?) RETURNING id").bind(location_id ?? null, staff_id || null, service_id ?? null, start_date, end).first<{ id: number }>();
      await env.DB.prepare("INSERT INTO customer_appointments(customer_id,appointment_id,notes) VALUES(?,?,?)").bind(cust!.id, appt!.id, notes ?? "").run();
      ctx.waitUntil(notifyBooking(env, appt!.id, "new"));
      return json({ ok: true });
    }

    // move a booking: change practitioner AND time (drag-drop); location follows the practitioner
    if (url.pathname === "/api/move" && req.method === "POST") {
      const { appointment_id, staff_id, start_date } = (await req.json()) as any;
      const a = await env.DB.prepare("SELECT service_id, location_id FROM appointments WHERE id=?").bind(appointment_id).first<{ service_id: number; location_id: number }>();
      let end = start_date;
      if (a?.service_id && start_date) {
        const svc = await env.DB.prepare("SELECT duration_min FROM services WHERE id=?").bind(a.service_id).first<{ duration_min: number }>();
        const t = new Date(start_date.replace(" ", "T") + "Z");
        end = new Date(t.getTime() + (svc?.duration_min ?? 60) * 60000).toISOString().slice(0, 19).replace("T", " ");
      }
      // location follows the assigned practitioner's clinics
      const ABBR2LOC: Record<string, number> = { VCT: 3, CITY: 11, ONLINE: 4 };
      let newLoc = a?.location_id ?? null;
      if (staff_id) {
        const p = await env.DB.prepare("SELECT clinics FROM practitioners WHERE id=?").bind(staff_id).first<{ clinics: string }>();
        const clinics = (p?.clinics || "").split(",").map((s) => s.trim()).filter(Boolean);
        const curAbbr = Object.keys(ABBR2LOC).find((k) => ABBR2LOC[k] === a?.location_id);
        if (clinics.length && (!curAbbr || !clinics.includes(curAbbr))) newLoc = ABBR2LOC[clinics[0]];
      }
      await env.DB.prepare("UPDATE appointments SET staff_id=?, start_date=?, end_date=?, location_id=? WHERE id=?").bind(staff_id || null, start_date, end, newLoc, appointment_id).run();
      ctx.waitUntil(notifyBooking(env, appointment_id, "updated"));
      return json({ ok: true });
    }

    // reorder practitioner columns
    if (url.pathname === "/api/prac_order" && req.method === "POST") {
      const { ids } = (await req.json()) as any;
      if (Array.isArray(ids)) {
        for (let i = 0; i < ids.length; i++) {
          await env.DB.prepare("UPDATE practitioners SET position=? WHERE id=?").bind(i + 1, ids[i]).run();
        }
      }
      return json({ ok: true });
    }

    // ---- practitioner roster CRUD ----
    if (url.pathname === "/api/prac" && req.method === "GET") {
      const { results } = await env.DB.prepare("SELECT id,name,photo,clinics,email,services,position FROM practitioners ORDER BY position, id").all();
      return json({ practitioners: results });
    }
    if (url.pathname === "/api/prac_save" && req.method === "POST") {
      const { id, name, clinics, photo, email, services } = (await req.json()) as any;
      if (!name) return json({ error: "name required" }, 400);
      if (id) {
        await env.DB.prepare("UPDATE practitioners SET name=?, clinics=?, photo=?, email=?, services=? WHERE id=?").bind(name, clinics ?? "", photo ?? null, email ?? "", services ?? "", id).run();
        return json({ ok: true, id });
      }
      const mx = await env.DB.prepare("SELECT COALESCE(MAX(id),0)+1 AS nid, COALESCE(MAX(position),0)+1 AS npos FROM practitioners").first<{ nid: number; npos: number }>();
      await env.DB.prepare("INSERT INTO practitioners(id,name,photo,clinics,email,services,position) VALUES(?,?,?,?,?,?,?)").bind(mx!.nid, name, photo ?? null, clinics ?? "", email ?? "", services ?? "", mx!.npos).run();
      return json({ ok: true, id: mx!.nid });
    }
    if (url.pathname === "/api/prac_delete" && req.method === "POST") {
      const { id } = (await req.json()) as any;
      await env.DB.prepare("UPDATE appointments SET staff_id=NULL WHERE staff_id=?").bind(id).run(); // unassign their bookings
      await env.DB.prepare("DELETE FROM practitioners WHERE id=?").bind(id).run();
      await env.DB.prepare("DELETE FROM working_hours WHERE practitioner_id=?").bind(id).run();
      return json({ ok: true });
    }

    // ---- service catalogue CRUD (title / price / duration / colour) ----
    if (url.pathname === "/api/services" && req.method === "GET") {
      const { results } = await env.DB.prepare("SELECT id,title,price,duration_min,color FROM services ORDER BY title").all();
      return json({ services: results });
    }
    if (url.pathname === "/api/service_save" && req.method === "POST") {
      const { id, title, price, duration_min, color } = (await req.json()) as any;
      if (!title) return json({ error: "title required" }, 400);
      if (id) {
        await env.DB.prepare("UPDATE services SET title=?, price=?, duration_min=?, color=? WHERE id=?")
          .bind(title, price ?? 0, duration_min ?? 60, color ?? null, id).run();
        return json({ ok: true, id });
      }
      const mx = await env.DB.prepare("SELECT COALESCE(MAX(id),0)+1 AS nid FROM services").first<{ nid: number }>();
      await env.DB.prepare("INSERT INTO services(id,title,price,duration_min,color) VALUES(?,?,?,?,?)")
        .bind(mx!.nid, title, price ?? 0, duration_min ?? 60, color ?? null).run();
      return json({ ok: true, id: mx!.nid });
    }
    if (url.pathname === "/api/service_delete" && req.method === "POST") {
      const { id } = (await req.json()) as any;
      await env.DB.prepare("UPDATE appointments SET service_id=NULL WHERE service_id=?").bind(id).run();
      await env.DB.prepare("DELETE FROM services WHERE id=?").bind(id).run();
      return json({ ok: true });
    }

    // ---- working hours (weekly shifts, edited on the Practitioners page) ----
    if (url.pathname === "/api/hours" && req.method === "GET") {
      const { results } = await env.DB.prepare("SELECT id,practitioner_id,dow,start_time,end_time,date FROM working_hours").all();
      return json({ hours: results });
    }
    if (url.pathname === "/api/hours_add" && req.method === "POST") {
      const { practitioner_id, dow, start, end, date } = (await req.json()) as any;
      if (!practitioner_id || !dow || !start || !end) return json({ error: "missing" }, 400);
      await env.DB.prepare("INSERT INTO working_hours(practitioner_id,dow,start_time,end_time,date) VALUES(?,?,?,?,?)").bind(practitioner_id, dow, start, end, date || null).run();
      return json({ ok: true });
    }
    if (url.pathname === "/api/hours_del" && req.method === "POST") {
      const { id } = (await req.json()) as any;
      await env.DB.prepare("DELETE FROM working_hours WHERE id=?").bind(id).run();
      return json({ ok: true });
    }

    // cancel = delete (no status)
    if (url.pathname === "/api/delete" && req.method === "POST") {
      const { ca_id, appointment_id } = (await req.json()) as any;
      await env.DB.prepare("DELETE FROM customer_appointments WHERE id=?").bind(ca_id).run();
      await env.DB.prepare("DELETE FROM appointments WHERE id=?").bind(appointment_id).run();
      return json({ ok: true });
    }

    return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
  },
};

const PAGE = `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AcuPro Admin · Bookings</title>
<style>
  :root{--pine:#1f4d43;--pine2:#163830;--gold:#c98a3f;--bg:#f4ede2;--ink:#23201c;--line:#e0d6c6;--card:#fff}
  *{box-sizing:border-box}
  body{margin:0;font-family:-apple-system,system-ui,sans-serif;background:var(--bg);color:var(--ink)}
  header{background:var(--pine);color:#fff;padding:14px 20px;display:flex;justify-content:space-between;align-items:center;position:sticky;top:0;z-index:5}
  header h1{font-size:1.05rem;margin:0}
  header button{background:rgba(255,255,255,.15);color:#fff;border:0;padding:8px 14px;border-radius:8px;font-size:.85rem;cursor:pointer}
  .wrap{max-width:100%;margin:0 auto;padding:16px}
  .login{max-width:340px;margin:12vh auto;background:#fff;padding:28px;border-radius:16px;box-shadow:0 12px 40px -20px rgba(0,0,0,.3)}
  .login h1{font-size:1.3rem;margin:0 0 4px;color:var(--pine)}.login p{color:#777;font-size:.9rem;margin:0 0 18px}
  input,select,textarea{width:100%;font:inherit;padding:11px 12px;border:1px solid var(--line);border-radius:9px;background:#fff}
  .btn{background:var(--pine);color:#fff;border:0;padding:10px 16px;border-radius:9px;font-weight:600;cursor:pointer;font-size:.92rem}
  .btn.ghost{background:#fff;color:var(--pine);border:1px solid var(--line)}
  .btn.danger{background:#fff;color:#b0553a;border:1px solid #e6c4b8}
  .toolbar{display:flex;align-items:center;gap:10px;margin-bottom:14px;flex-wrap:wrap}
  .toolbar .range{font-weight:700;font-size:1.05rem;margin:0 6px}
  .nav-btn{border:1px solid var(--line);background:#fff;border-radius:8px;padding:8px 12px;cursor:pointer;font-weight:600}
  .nav-btn.on{background:var(--pine);color:#fff;border-color:var(--pine)}
  .cbadge{color:#fff;font-size:.6rem;font-weight:700;padding:1px 5px;border-radius:4px;letter-spacing:.03em;margin-left:4px}
  .av{width:30px;height:30px;border-radius:50%;object-fit:cover;vertical-align:middle;margin-right:6px}
  .av.ph{display:inline-grid;place-items:center;background:var(--pine);color:#fff;font-size:.68rem;font-weight:600}
  .av.big{width:54px;height:54px;margin-right:12px}
  /* week */
  .week{display:grid;grid-template-columns:repeat(7,1fr);gap:8px}
  .day{background:var(--card);border:1px solid var(--line);border-radius:12px;min-height:110px;padding:8px;cursor:pointer}
  .day.today{border-color:var(--pine);box-shadow:0 0 0 2px rgba(31,77,67,.12)}
  .day:hover{border-color:var(--pine)}
  .day h4{margin:0 0 8px;font-size:.8rem;color:#7a7266;text-align:center;font-weight:700}.day h4 b{display:block;font-size:1.1rem;color:var(--ink)}
  .chip{background:#f3f7f4;border-left:3px solid var(--pine);border-radius:6px;padding:5px 7px;margin-bottom:6px;font-size:.76rem}
  .chip .t{font-weight:700}.chip .n{color:#4a463f;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .empty{color:#bbb;font-size:.75rem;text-align:center;margin-top:16px}
  /* day time-grid */
  .daygrid{display:flex;overflow-x:auto;border:1px solid var(--line);border-radius:12px;background:#fff}
  .col{min-width:150px;flex:1 0 150px;border-right:1px solid var(--line);position:relative}
  .col:last-child{border-right:0}
  .col.gutter{min-width:64px;flex:0 0 64px;background:#faf6ef}
  .colhead{height:56px;display:flex;flex-direction:column;align-items:center;justify-content:center;border-bottom:1px solid var(--line);position:sticky;top:0;background:#fff;z-index:2;font-size:.82rem;font-weight:600;text-align:center;padding:4px;cursor:grab}
  .colhead:active{cursor:grabbing}
  .colhead img,.colhead .ph{width:26px;height:26px;border-radius:50%;margin-bottom:2px}
  .colbody{position:relative;height:720px}
  .whblock{position:absolute;left:2px;right:2px;background:rgba(31,77,67,.12);border:1px solid rgba(31,77,67,.28);border-radius:5px;font-size:.62rem;color:#1f4d43;z-index:0;overflow:hidden}
  .whblock span{position:absolute;top:1px;left:4px}
  .move-prev{position:absolute;left:2px;right:2px;background:rgba(31,77,67,.18);border:2px dashed var(--pine);border-radius:6px;z-index:6;pointer-events:none}
  .hourline{position:absolute;left:0;right:0;border-top:1px dashed #eee;pointer-events:none}
  .gutter .hourlabel{position:absolute;right:6px;font-size:.72rem;color:#999;transform:translateY(-7px)}
  .col.drop-hi{background:#eef5f0}
  .appt{position:absolute;z-index:1;background:rgba(249,222,190,.72);border:1px solid rgba(201,138,63,.55);border-left:3px solid var(--gold);border-radius:6px;padding:4px 6px;font-size:.74rem;cursor:grab;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.08);backdrop-filter:saturate(1.1)}
  .appt{line-height:1.2}
  .appt .s{color:#5f5a50;font-size:.66rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  /* service legend */
  .legend{display:flex;flex-wrap:wrap;gap:4px 12px;margin:0 0 8px;font-size:.72rem;color:#5f5a50}
  .legend .lg{display:inline-flex;align-items:center;gap:5px}
  .legend .sw{width:11px;height:11px;border-radius:3px;display:inline-block}
  /* services table */
  .svcrow{display:flex;align-items:center;gap:10px;padding:9px 14px;border-bottom:1px solid var(--line)}
  .svcrow:last-child{border-bottom:0}
  .svcrow input[type=color]{width:38px;height:34px;padding:2px;cursor:pointer}
  .svcrow .st{flex:1;max-width:320px}
  .svcrow .sp{width:90px}.svcrow .sd{width:90px}
  /* customer search */
  .csrch{position:relative}
  .csugg{position:absolute;left:0;right:0;top:100%;background:#fff;border:1px solid var(--line);border-radius:0 0 9px 9px;box-shadow:0 8px 24px -12px rgba(0,0,0,.3);z-index:3;max-height:220px;overflow:auto}
  .csugg div{padding:9px 12px;cursor:pointer;font-size:.86rem;border-bottom:1px solid #f0ebe1}
  .csugg div:hover{background:#f3f7f4}
  .cust-picked{display:flex;align-items:center;justify-content:space-between;gap:8px;background:#eef5f0;border:1px solid #cfe0d5;border-radius:9px;padding:9px 12px;font-size:.86rem}
  .cust-picked b.x{cursor:pointer;color:#b0553a}
  /* roster */
  .rosterbox{background:#fff;border:1px solid var(--line);border-radius:12px;overflow:hidden}
  .prow{display:flex;align-items:center;gap:12px;padding:10px 14px;border-bottom:1px solid var(--line)}
  .prow:last-child{border-bottom:0}
  .pname{flex:1;max-width:220px}
  .pemail{flex:1;max-width:240px}
  .clset{display:flex;gap:6px}
  .clchip{border:1px solid var(--line);background:#fff;color:#7a7266;border-radius:999px;padding:5px 12px;font-size:.78rem;font-weight:700;cursor:pointer}
  .addrow{display:flex;align-items:center;gap:12px;margin-top:14px;background:#fff;border:1px dashed var(--gold);border-radius:12px;padding:12px 14px}
  .addrow input{flex:1;max-width:280px}
  .appt:hover{filter:brightness(.97)}
  .appt .t{font-weight:700}.appt .n{color:#4a463f}
  .appt.dragging{opacity:.4}
  /* unassigned strip */
  .unassigned{background:#fff;border:1px dashed var(--gold);border-radius:10px;padding:8px;margin-bottom:12px;min-height:44px}
  .unassigned h5{margin:0 0 6px;font-size:.75rem;color:#a9772a;text-transform:uppercase;letter-spacing:.05em}
  .uchip{display:inline-block;background:#fbe7cf;border:1px solid #eacb97;border-radius:8px;padding:6px 10px;margin:0 6px 6px 0;font-size:.8rem;cursor:grab}
  /* modal */
  .modal-bg{display:none;position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:50;align-items:center;justify-content:center;padding:16px}
  .modal-bg.on{display:flex}
  .modal{background:#fff;border-radius:16px;max-width:460px;width:100%;padding:24px;max-height:90vh;overflow:auto}
  .modal h3{margin:0 0 16px;color:var(--pine)}
  .fld{margin-bottom:12px}.fld label{display:block;font-size:.8rem;font-weight:600;margin-bottom:4px}
  .grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px}
  .modal-actions{display:flex;gap:8px;justify-content:space-between;margin-top:18px}
  .prow .btn{padding:7px 11px;font-size:.82rem;white-space:nowrap}
  /* weekly hours editor */
  .hday{display:flex;align-items:center;gap:10px;padding:7px 0;border-bottom:1px solid var(--line)}
  .hlabel{width:38px;font-weight:700;font-size:.82rem;color:var(--pine)}
  .hchips{flex:1;display:flex;flex-wrap:wrap;gap:5px;min-width:0}
  .hchip{background:#eef5f0;border:1px solid #cfe0d5;border-radius:999px;padding:3px 9px;font-size:.78rem;font-weight:600;color:#1f4d43;display:inline-flex;align-items:center;gap:6px}
  .hchip b{cursor:pointer;color:#b0553a;font-weight:700}
  .hadd{display:flex;align-items:center;gap:4px}
  .hadd input{width:96px;padding:5px 6px}
  .hadd .btn{padding:6px 10px;font-size:.8rem}
  /* services editor */
  .svcgrid{display:grid;grid-template-columns:1fr 1fr;gap:6px 14px;max-height:52vh;overflow:auto}
  .svcopt{display:flex;align-items:center;gap:8px;font-size:.85rem;padding:3px 0}
  .svcopt input{width:auto}
  .movesum{background:#f3f7f4;border-radius:8px;padding:10px 12px;font-size:.9rem}
</style></head><body>
<div id="app"></div>
<script>
const $=s=>document.querySelector(s);
const UK='https://acupro-uk.jinzhiqi19860716.workers.dev';
const CLINIC_COLOR={VCT:'#256b45',CITY:'#b0553a',ONLINE:'#4a3f7a'};
const START=9,END=21; let HPX=60; // 9am-9pm; HPX (px/hour) is recomputed per render to fit one screen
function fitHPX(){HPX=Math.max(30,Math.min(58,Math.floor((window.innerHeight-300)/(END-START))))}
const COLH=()=>(END-START)*HPX;
let appts=[],meta={services:[],practitioners:[],locations:[]},view='week',cursor=monday(new Date()),dayDate=new Date();
let page='bookings',pracList=[],newClin=new Set(),hours=[],svcList=[];
let selCust=null,custTimer=null,custResults=[];
const CLINIC_ALL=['VCT','CITY','ONLINE'];
const DOW_NAMES=['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
function mins(sd){return +sd.slice(11,13)*60 + +sd.slice(14,16)}
function hmToMin(hm){return +hm.slice(0,2)*60 + +hm.slice(3,5)}
function minToHm(m){return String(Math.floor(m/60)).padStart(2,'0')+':'+String(m%60).padStart(2,'0')}
function curDow(){return dayDate.getDay()===0?7:dayDate.getDay()}
function monday(d){d=new Date(d);const g=(d.getDay()+6)%7;d.setDate(d.getDate()-g);d.setHours(0,0,0,0);return d}
function ymd(d){return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0')}
function esc(s){return (s==null?'':''+s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}
function rgba(hex,a){const h=(hex||'#c98a3f').replace('#','');const n=parseInt(h.length===3?h.split('').map(c=>c+c).join(''):h,16);return 'rgba('+((n>>16)&255)+','+((n>>8)&255)+','+(n&255)+','+a+')'}
function initials(n){n=(''+(n||'')).replace(/\\(.*\\)/,'').trim();return n.split(/\\s+/).map(w=>w[0]||'').slice(0,2).join('').toUpperCase()}
function avatar(photo,name,cls){return photo?'<img draggable="false" class="av '+(cls||'')+'" src="'+UK+photo+'" alt="">':'<span class="av ph '+(cls||'')+'">'+initials(name)+'</span>'}
function cbadge(ab){if(!ab)return '';return '<span class="cbadge" style="background:'+(CLINIC_COLOR[ab]||'#7a7266')+'">'+esc(ab)+'</span>'}
async function api(p,o){const r=await fetch(p,o);let d={};try{d=await r.json()}catch(e){};return{ok:r.ok,data:d}}

function loginView(msg){$('#app').innerHTML='<div class="login"><h1>AcuPro Admin</h1><p>Booking management</p><input id="pw" type="password" placeholder="Password" autofocus><button class="btn" style="width:100%;margin-top:12px" onclick="doLogin()">Sign in</button><div style="color:#b0553a;font-size:.85rem;margin-top:8px">'+(msg||'')+'</div></div>';$('#pw').addEventListener('keydown',e=>{if(e.key==='Enter')doLogin()})}
async function doLogin(){const {ok,data}=await api('/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:$('#pw').value})});ok?boot():loginView(data.error||'Login failed')}
async function boot(){const m=await api('/api/meta');if(!m.ok)return loginView('');meta=m.data;await load()}
async function load(){const a=await api('/api/appointments');if(!a.ok)return loginView('');appts=a.data.appointments||[];const h=await api('/api/hours');hours=h.ok?(h.data.hours||[]):[];render()}

function navbtn(p,label){const fn=p==='roster'?'goRoster':p==='services'?'goServices':'goBookings';return '<button style="background:'+(page===p?'#fff':'rgba(255,255,255,.15)')+';color:'+(page===p?'#1f4d43':'#fff')+';font-weight:600" onclick="'+fn+'()">'+label+'</button>'}
function shell(inner){return '<header><h1>📅 AcuPro</h1><div style="display:flex;gap:8px">'+navbtn('bookings','Bookings')+navbtn('roster','Practitioners')+navbtn('services','Services')+'</div><button onclick="logout()">Sign out</button></header><div class="wrap">'+inner+'</div>'+modalHtml()}
function render(){if(page==='roster')return renderRoster();if(page==='services')return renderServices();view==='day'?renderDay():renderWeek()}
function goBookings(){page='bookings';render()}
function goRoster(){page='roster';loadPrac()}
function goServices(){page='services';loadServices()}

function renderWeek(){
  const days=[...Array(7)].map((_,i)=>{const d=new Date(cursor);d.setDate(d.getDate()+i);return d});
  const end=new Date(cursor);end.setDate(end.getDate()+6);
  const label=cursor.toLocaleDateString('en-GB',{day:'numeric',month:'short'})+' – '+end.toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'});
  const todayS=ymd(new Date());
  const cols=days.map(d=>{const ds=ymd(d);
    const list=appts.filter(a=>a.start_date&&a.start_date.slice(0,10)===ds).sort((a,b)=>a.start_date.localeCompare(b.start_date));
    const chips=list.map(a=>'<div class="chip"><div class="t">'+a.start_date.slice(11,16)+cbadge(a.loc_abbr)+'</div><div class="n">'+esc(a.full_name)+'</div></div>').join('')||'<div class="empty">—</div>';
    return '<div class="day'+(ds===todayS?' today':'')+'" onclick=\\'openDay("'+ds+'")\\'><h4>'+d.toLocaleDateString('en-GB',{weekday:'short'})+'<b>'+d.getDate()+'</b></h4>'+chips+'</div>';
  }).join('');
  $('#app').innerHTML=shell('<div class="toolbar"><button class="nav-btn on">Week</button><button class="nav-btn" onclick="toDayView()">Day</button><span style="width:12px"></span><button class="nav-btn" onclick="wk(-7)">←</button><button class="nav-btn" onclick="wkToday()">This week</button><button class="nav-btn" onclick="wk(7)">→</button><span class="range">'+label+'</span><span style="flex:1"></span><button class="btn" onclick="openCreate()">+ New booking</button></div><div class="week">'+cols+'</div>');
}
function wk(n){cursor.setDate(cursor.getDate()+n);render()}
function wkToday(){cursor=monday(new Date());render()}
function openDay(ds){dayDate=new Date(ds+'T00:00:00');view='day';render()}
function toDayView(){dayDate=new Date();view='day';render()}
function toWeek(){view='week';render()}

function renderDay(){
  fitHPX();
  const ds=ymd(dayDate);
  const label=dayDate.toLocaleDateString('en-GB',{weekday:'long',day:'numeric',month:'short',year:'numeric'});
  const svcColor={};meta.services.forEach(s=>{if(s.color)svcColor[s.id]=s.color});
  const list=appts.filter(a=>a.start_date&&a.start_date.slice(0,10)===ds);
  const cols=meta.practitioners;
  // unassigned
  const un=list.filter(a=>!a.staff_id);
  const unHtml='<div class="unassigned" data-pid="" ondragover="dOver(event)" ondragleave="dLeave(event)" ondrop="dDrop(event,\\'\\')"><h5>Unassigned — drag onto a practitioner</h5>'+
    (un.map(a=>'<span class="uchip" draggable="true" ondragstart="dStart(event,'+a.id+')" ondragend="dEnd(event)" onclick="openEdit('+a.id+')">'+a.start_date.slice(11,16)+' '+esc(a.full_name)+cbadge(a.loc_abbr)+'</span>').join('')||'<span style="color:#7a7266;font-size:.82rem">✅ No unassigned bookings right now. &nbsp;📧 Email notifications: up to <b>100/day · 3,000/month</b> (Resend free tier).</span>')+'</div>';
  // gutter
  let gutter='<div class="col gutter"><div class="colhead"></div><div class="colbody" style="height:'+COLH()+'px">';
  for(let h=START;h<=END;h++){gutter+='<div class="hourlabel" style="top:'+((h-START)*HPX)+'px">'+((h%12)||12)+(h<12?'am':'pm')+'</div>'}
  gutter+='</div></div>';
  const dow=curDow();
  const body=cols.map(p=>{
    const items=list.filter(a=>String(a.staff_id)===String(p.id));
    let lines='';for(let h=START;h<=END;h++){lines+='<div class="hourline" style="top:'+((h-START)*HPX)+'px"></div>'}
    const whs=hours.filter(h=>String(h.practitioner_id)===String(p.id)&&!h.date&&h.dow===dow);
    const whHtml=whs.map(h=>{const s=hmToMin(h.start_time),e=hmToMin(h.end_time);const top=(s-START*60)/60*HPX,hgt=Math.max((e-s)/60*HPX,6);return '<div class="whblock" style="top:'+top+'px;height:'+hgt+'px" title="Working hours '+h.start_time+'–'+h.end_time+' — edit in Practitioners"><span>'+h.start_time+'–'+h.end_time+'</span></div>'}).join('');
    const laid=layoutLanes(items);
    const blocks=laid.map(a=>{
      const sm=mins(a.start_date), dur=a.duration_min||60;
      const top=(sm-START*60)/60*HPX, hgt=Math.max(dur/60*HPX-2,22);
      const w=100/a._lanes, left=a._lane*w;
      const col=svcColor[a.service_id]||'#c98a3f';
      const style='top:'+top+'px;height:'+hgt+'px;left:calc('+left+'% + 2px);width:calc('+w+'% - 4px);background:'+rgba(col,.22)+';border-color:'+rgba(col,.5)+';border-left:3px solid '+col;
      const svcName=hgt>=40?'<div class="s">'+esc(a.service||'')+'</div>':'';
      return '<div class="appt" draggable="true" title="'+esc(a.service||'')+' · '+esc(a.full_name)+'" style="'+style+'" ondragstart="dStart(event,'+a.id+')" ondragend="dEnd(event)" onclick="openEdit('+a.id+')"><div class="t">'+a.start_date.slice(11,16)+cbadge(a.loc_abbr)+'</div><div class="n">'+esc(a.full_name)+'</div>'+svcName+'</div>';
    }).join('');
    return '<div class="col" data-pid="'+p.id+'" ondragover="dOver(event)" ondragleave="dLeave(event)" ondrop="dDrop(event,'+p.id+')"><div class="colhead" draggable="true" ondragstart="colDragStart(event,'+p.id+')" ondragover="event.preventDefault()" ondrop="colDrop(event,'+p.id+')" title="Drag to reorder">'+avatar(p.photo,p.name)+esc(p.name)+'</div><div class="colbody" style="height:'+COLH()+'px">'+whHtml+lines+blocks+'</div></div>';
  }).join('');
  const usedSvc=[...new Set(list.map(a=>a.service_id).filter(Boolean))].map(id=>meta.services.find(s=>String(s.id)===String(id))).filter(Boolean);
  const legend=usedSvc.length?'<div class="legend">'+usedSvc.map(s=>'<span class="lg"><span class="sw" style="background:'+(s.color||'#c98a3f')+'"></span>'+esc(s.title)+'</span>').join('')+'</div>':'';
  $('#app').innerHTML=shell('<div class="toolbar"><button class="nav-btn" onclick="toWeek()">Week</button><button class="nav-btn on">Day</button><span style="width:12px"></span><button class="nav-btn" onclick="dy(-1)">←</button><button class="nav-btn" onclick="dyToday()">Today</button><button class="nav-btn" onclick="dy(1)">→</button><span class="range">'+label+'</span><span style="flex:1"></span><span style="font-size:.78rem;color:#7a7266;margin-right:6px">Shaded = working hours (set in Practitioners)</span><button class="btn" onclick="openCreate()">+ New booking</button></div>'+unHtml+legend+'<div class="daygrid">'+gutter+body+'</div>');
}
function dy(n){dayDate.setDate(dayDate.getDate()+n);render()}
function dyToday(){dayDate=new Date();render()}

// drag-drop
let dragId=null,colDragId=null,grabDy=0,pendingMove=null;
function dStart(e,id){dragId=id;const r=e.target.getBoundingClientRect();grabDy=e.clientY-r.top;e.target.classList.add('dragging');e.dataTransfer.effectAllowed='move'}
function dEnd(e){e.target.classList.remove('dragging')}
function colDragStart(e,pid){colDragId=pid;e.dataTransfer.effectAllowed='move';e.stopPropagation()}
async function colDrop(e,targetPid){e.preventDefault();e.stopPropagation();const src=colDragId;colDragId=null;if(src==null||src===targetPid)return;
  const arr=meta.practitioners.slice();const from=arr.findIndex(p=>p.id===src),to=arr.findIndex(p=>p.id===targetPid);if(from<0||to<0)return;
  const [m]=arr.splice(from,1);arr.splice(to,0,m);meta.practitioners=arr;render();
  await api('/api/prac_order',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({ids:arr.map(p=>p.id)})});
}
function dOver(e){e.preventDefault();e.currentTarget.classList.add('drop-hi')}
function dLeave(e){e.currentTarget.classList.remove('drop-hi')}
function layoutLanes(items){const arr=items.slice().sort((a,b)=>a.start_date.localeCompare(b.start_date));const laneEnd=[];arr.forEach(a=>{const s=mins(a.start_date),e=s+(a.duration_min||60);let ln=laneEnd.findIndex(x=>x<=s);if(ln<0){ln=laneEnd.length;laneEnd.push(e)}else laneEnd[ln]=e;a._lane=ln});const total=Math.max(laneEnd.length,1);arr.forEach(a=>a._lanes=total);return arr}
function dDrop(e,pid){e.preventDefault();e.currentTarget.classList.remove('drop-hi');if(dragId==null)return;
  const a=appts.find(x=>x.id===dragId);const gy=grabDy;dragId=null;grabDy=0;if(!a)return;
  if(pid===''||pid==null){
    pendingMove={kind:'unassign',appointment_id:a.appointment_id};
    openMoveConfirm(a,'Unassigned','—');return;
  }
  const bodyEl=e.currentTarget.querySelector('.colbody');const rect=bodyEl.getBoundingClientRect();
  let m=START*60+Math.round(((e.clientY-rect.top-gy)/HPX*60)/15)*15; m=Math.max(START*60,Math.min(m,END*60-15));
  const hm=String(Math.floor(m/60)).padStart(2,'0')+':'+String(m%60).padStart(2,'0');
  const prac=meta.practitioners.find(p=>String(p.id)===String(pid));
  pendingMove={kind:'move',appointment_id:a.appointment_id,staff_id:pid,start_date:ymd(dayDate)+' '+hm+':00'};
  openMoveConfirm(a,prac?prac.name:('#'+pid),hm);
}
function openMoveConfirm(a,pracName,hm){
  const from='<b>'+esc(a.practitioner||'Unassigned')+'</b> · '+a.start_date.slice(11,16);
  const to='<b>'+esc(pracName)+'</b>'+(hm&&hm!=='—'?' · '+hm:'');
  $('#mbox').innerHTML='<h3>Confirm change</h3>'+
    '<p style="margin:0 0 4px;color:#7a7266;font-size:.85rem">Booking for <b>'+esc(a.full_name)+'</b> — '+esc(a.service||'')+'</p>'+
    '<div style="display:flex;align-items:center;gap:10px;margin:14px 0;font-size:.95rem"><span style="color:#999">'+from+'</span><span style="font-size:1.2rem;color:var(--gold)">→</span><span style="color:var(--pine)">'+to+'</span></div>'+
    '<div class="modal-actions" style="justify-content:flex-end"><button class="btn ghost" onclick="cancelMove()">Cancel</button><button class="btn" onclick="confirmMove()">Confirm</button></div>';
  $('#mbg').classList.add('on');
}
async function confirmMove(){const pm=pendingMove;pendingMove=null;closeM();if(!pm)return;
  if(pm.kind==='unassign'){await api('/api/assign',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({appointment_id:pm.appointment_id,staff_id:null})});}
  else{await api('/api/move',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({appointment_id:pm.appointment_id,staff_id:pm.staff_id,start_date:pm.start_date})});}
  load();
}
function cancelMove(){pendingMove=null;closeM();render();}

// modal
function opt(arr,val,label,sel){return arr.map(o=>'<option value="'+o[val]+'"'+(String(o[val])===String(sel)?' selected':'')+'>'+esc(o[label])+'</option>').join('')}
function modalHtml(){return '<div class="modal-bg" id="mbg"><div class="modal" id="mbox"></div></div>'}
function openEdit(id){const a=appts.find(x=>x.id===id);if(!a)return;
  const date=a.start_date.slice(0,10),time=a.start_date.slice(11,16);
  $('#mbox').innerHTML='<h3>Edit booking</h3>'+
    '<div class="fld"><label>Customer name</label><input id="e_name" value="'+esc(a.full_name)+'"></div>'+
    '<div class="grid2"><div class="fld"><label>Phone</label><input id="e_phone" value="'+esc(a.phone)+'"></div><div class="fld"><label>Email</label><input id="e_email" value="'+esc(a.email)+'"></div></div>'+
    '<div class="grid2"><div class="fld"><label>Date</label><input id="e_date" type="date" value="'+date+'"></div><div class="fld"><label>Time</label><input id="e_time" type="time" value="'+time+'"></div></div>'+
    '<div class="fld"><label>Service</label><select id="e_service">'+opt(meta.services,'id','title',a.service_id)+'</select></div>'+
    '<div class="grid2"><div class="fld"><label>Practitioner</label><select id="e_staff"><option value="">Unassigned</option>'+opt(meta.practitioners,'id','name',a.staff_id)+'</select></div>'+
    '<div class="fld"><label>Location</label><select id="e_loc"><option value="">—</option>'+opt(meta.locations,'id','name',a.location_id)+'</select></div></div>'+
    '<div class="fld"><label>Notes</label><textarea id="e_notes" rows="2">'+esc(a.notes)+'</textarea></div>'+
    '<div class="modal-actions"><button class="btn danger" onclick="delBk('+a.id+')">Delete booking</button><div style="display:flex;gap:8px"><button class="btn ghost" onclick="closeM()">Close</button><button class="btn" onclick="saveEdit('+a.id+')">Save</button></div></div>';
  $('#mbg').classList.add('on');
}
function closeM(){$('#mbg').classList.remove('on')}
async function saveEdit(id){const a=appts.find(x=>x.id===id);
  await api('/api/update',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({ca_id:a.id,appointment_id:a.appointment_id,customer_id:a.customer_id,start_date:$('#e_date').value+' '+$('#e_time').value+':00',service_id:+$('#e_service').value,staff_id:$('#e_staff').value?+$('#e_staff').value:null,location_id:$('#e_loc').value?+$('#e_loc').value:null,notes:$('#e_notes').value,full_name:$('#e_name').value,phone:$('#e_phone').value,email:$('#e_email').value})});
  closeM();load();
}
async function delBk(id){const a=appts.find(x=>x.id===id);if(!confirm('Delete this booking?'))return;await api('/api/delete',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({ca_id:a.id,appointment_id:a.appointment_id})});closeM();load()}
function openCreate(){selCust=null;custResults=[];const d=view==='day'?ymd(dayDate):ymd(new Date());
  $('#mbox').innerHTML='<h3>New booking</h3>'+
    '<div class="fld"><label>Find existing customer</label><div class="csrch"><input id="c_search" placeholder="Search name, phone or email…" oninput="custSearch(this.value)" autocomplete="off"><div class="csugg" id="c_sugg" style="display:none"></div></div></div>'+
    '<div id="c_pickwrap"></div>'+
    '<div class="fld"><label>Customer name</label><input id="c_name" placeholder="Full name" oninput="if(selCust)clearCust(true)"></div>'+
    '<div class="grid2"><div class="fld"><label>Phone</label><input id="c_phone"></div><div class="fld"><label>Email</label><input id="c_email"></div></div>'+
    '<div class="grid2"><div class="fld"><label>Date</label><input id="c_date" type="date" value="'+d+'"></div><div class="fld"><label>Time</label><input id="c_time" type="time" value="10:00"></div></div>'+
    '<div class="fld"><label>Service</label><select id="c_service">'+opt(meta.services,'id','title','')+'</select></div>'+
    '<div class="grid2"><div class="fld"><label>Practitioner</label><select id="c_staff"><option value="">Unassigned</option>'+opt(meta.practitioners,'id','name','')+'</select></div>'+
    '<div class="fld"><label>Location</label><select id="c_loc">'+opt(meta.locations,'id','name','')+'</select></div></div>'+
    '<div class="fld"><label>Notes</label><textarea id="c_notes" rows="2"></textarea></div>'+
    '<div class="modal-actions"><span style="color:#999;font-size:.78rem;align-self:center">Back-fill: past times allowed</span><div style="display:flex;gap:8px"><button class="btn ghost" onclick="closeM()">Close</button><button class="btn" onclick="createBk()">Create</button></div></div>';
  $('#mbg').classList.add('on');
}
function custSearch(q){clearTimeout(custTimer);const box=$('#c_sugg');if(!box)return;q=(q||'').trim();
  if(q.length<2){box.style.display='none';box.innerHTML='';return}
  custTimer=setTimeout(async()=>{const {ok,data}=await api('/api/customers?q='+encodeURIComponent(q));if(!ok)return;custResults=data.customers||[];
    box.innerHTML=custResults.length?custResults.map(c=>'<div onclick="pickCust('+c.id+')">'+esc(c.full_name)+' <span style="color:#999">'+esc(c.email||'')+(c.phone?' · '+esc(c.phone):'')+'</span></div>').join(''):'<div style="color:#999;cursor:default">No match — fill the fields below to create a new customer</div>';
    box.style.display='block';},250);
}
function pickCust(id){const c=custResults.find(x=>x.id===id);if(!c)return;selCust=c;$('#c_name').value=c.full_name||'';$('#c_phone').value=c.phone||'';$('#c_email').value=c.email||'';$('#c_search').value=c.full_name||'';$('#c_sugg').style.display='none';renderPicked();}
function renderPicked(){const w=$('#c_pickwrap');if(!w)return;w.innerHTML=selCust?'<div class="cust-picked"><span>✓ Linked to existing customer <b>'+esc(selCust.full_name)+'</b> (edits update their record)</span><b class="x" onclick="clearCust()">✕</b></div>':''}
function clearCust(keepFields){selCust=null;if(!keepFields){$('#c_search').value='';}renderPicked();}
async function createBk(){const body={start_date:$('#c_date').value+' '+$('#c_time').value+':00',service_id:+$('#c_service').value,staff_id:$('#c_staff').value?+$('#c_staff').value:null,location_id:$('#c_loc').value?+$('#c_loc').value:null,notes:$('#c_notes').value,full_name:$('#c_name').value,phone:$('#c_phone').value,email:$('#c_email').value,customer_id:selCust?selCust.id:null};
  if(!body.full_name){alert('Enter customer name');return}
  await api('/api/create',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});closeM();load()}
// ---- practitioner roster ----
async function loadPrac(){const [p,h]=await Promise.all([api('/api/prac'),api('/api/hours')]);if(!p.ok)return loginView('');pracList=p.data.practitioners||[];hours=h.ok?(h.data.hours||[]):[];renderRoster()}
function clchip(ab,on,cb){return '<button class="clchip'+(on?' on':'')+'" style="'+(on?'background:'+CLINIC_COLOR[ab]+';color:#fff;border-color:'+CLINIC_COLOR[ab]:'')+'" onclick="'+cb+'">'+ab+'</button>'}
function ppayload(p){return {id:p.id,name:p.name,clinics:p.clinics||'',photo:p.photo,email:p.email||'',services:p.services||''}}
function svcCount(p){return (p.services||'').split(',').map(s=>s.trim()).filter(Boolean).length}
function hoursCount(p){return hours.filter(h=>String(h.practitioner_id)===String(p.id)&&!h.date).length}
function renderRoster(){
  const rows=pracList.map(p=>{const set=new Set((p.clinics||'').split(',').map(s=>s.trim()).filter(Boolean));
    const chips=CLINIC_ALL.map(ab=>clchip(ab,set.has(ab),'toggleClinic('+p.id+',\\''+ab+'\\')')).join('');
    const sc=svcCount(p),hc=hoursCount(p);
    return '<div class="prow">'+avatar(p.photo,p.name)+'<input class="pname" value="'+esc(p.name)+'" onchange="renamePrac('+p.id+',this.value)"><input class="pemail" value="'+esc(p.email||'')+'" placeholder="email for notifications" onchange="setEmail('+p.id+',this.value)"><div class="clset">'+chips+'</div>'+
      '<button class="btn ghost" onclick="openHours('+p.id+')">🕑 Hours ('+hc+')</button>'+
      '<button class="btn ghost" onclick="openServices('+p.id+')">Services ('+(sc||'all')+')</button>'+
      '<button class="btn danger" onclick="delPrac('+p.id+')">Delete</button></div>';
  }).join('');
  const nc=CLINIC_ALL.map(ab=>clchip(ab,newClin.has(ab),'toggleNewClin(\\''+ab+'\\')')).join('');
  $('#app').innerHTML=shell('<h2 style="margin:4px 0 6px;font-size:1.25rem">Practitioners</h2><p style="color:#7a7266;font-size:.85rem;margin:0 0 16px">Click a clinic chip to toggle where a practitioner works. <b>Hours</b> sets the weekly schedule (shown on the day view &amp; drives booking availability). <b>Services</b> sets which treatments they offer (used for auto-assignment). Email is used for booking notifications.</p><div class="rosterbox">'+rows+'</div><div class="addrow"><input id="np_name" placeholder="New practitioner name"><input id="np_email" placeholder="email"><div class="clset">'+nc+'</div><button class="btn" onclick="addPrac()">+ Add</button></div>');
}
function toggleNewClin(ab){newClin.has(ab)?newClin.delete(ab):newClin.add(ab);renderRoster()}
async function saveP(p){await api('/api/prac_save',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(p)})}
async function toggleClinic(id,ab){const p=pracList.find(x=>x.id===id);const set=new Set((p.clinics||'').split(',').map(s=>s.trim()).filter(Boolean));set.has(ab)?set.delete(ab):set.add(ab);p.clinics=CLINIC_ALL.filter(a=>set.has(a)).join(',');renderRoster();await saveP(ppayload(p))}
async function renamePrac(id,name){const p=pracList.find(x=>x.id===id);p.name=name;await saveP(ppayload(p))}
async function setEmail(id,email){const p=pracList.find(x=>x.id===id);p.email=email;await saveP(ppayload(p))}
async function delPrac(id){if(!confirm('Delete this practitioner? Their bookings become Unassigned.'))return;await api('/api/prac_delete',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id})});loadPrac()}
async function addPrac(){const name=$('#np_name').value.trim();if(!name){alert('Enter a name');return}await saveP({name,email:$('#np_email').value.trim(),clinics:CLINIC_ALL.filter(a=>newClin.has(a)).join(','),services:''});newClin=new Set();loadPrac()}
// weekly hours editor (roster)
async function refreshHours(){const h=await api('/api/hours');hours=h.ok?(h.data.hours||[]):[]}
function openHours(pid){const p=pracList.find(x=>x.id===pid);if(!p)return;
  const days=DOW_NAMES.map((nm,i)=>{const d=i+1;
    const shifts=hours.filter(h=>String(h.practitioner_id)===String(pid)&&!h.date&&+h.dow===d).sort((a,b)=>a.start_time.localeCompare(b.start_time));
    const chips=shifts.map(s=>'<span class="hchip">'+s.start_time+'–'+s.end_time+'<b onclick="delHourR('+s.id+','+pid+')" title="Remove">✕</b></span>').join('')||'<span style="color:#c3bcae;font-size:.8rem">Off</span>';
    return '<div class="hday"><div class="hlabel">'+nm+'</div><div class="hchips">'+chips+'</div><div class="hadd"><input type="time" id="hs_'+d+'" value="09:00" step="900"><span>–</span><input type="time" id="he_'+d+'" value="17:00" step="900"><button class="btn ghost" onclick="addHourR('+pid+','+d+')">Add</button></div></div>';
  }).join('');
  $('#mbox').innerHTML='<h3>Weekly hours — '+esc(p.name)+'</h3><p style="color:#7a7266;font-size:.82rem;margin:0 0 12px">Recurring weekly schedule (09:00–21:00). The day view and the public booking page read availability from this.</p>'+days+'<div class="modal-actions" style="justify-content:flex-end"><button class="btn" onclick="closeM();renderRoster()">Done</button></div>';
  $('#mbg').classList.add('on');
}
async function addHourR(pid,d){const s=$('#hs_'+d).value,e=$('#he_'+d).value;if(!s||!e||e<=s){alert('Enter a valid start and end (end after start)');return}
  await api('/api/hours_add',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({practitioner_id:pid,dow:d,start:s,end:e,date:null})});
  await refreshHours();openHours(pid);}
async function delHourR(id,pid){await api('/api/hours_del',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id})});await refreshHours();openHours(pid);}
// services editor (roster)
function openServices(pid){const p=pracList.find(x=>x.id===pid);if(!p)return;
  const set=new Set((p.services||'').split(',').map(s=>s.trim()).filter(Boolean));
  const rows=meta.services.map(s=>'<label class="svcopt"><input type="checkbox" '+(set.has(String(s.id))?'checked':'')+' onchange="toggleSvc('+pid+','+s.id+',this.checked)"> '+esc(s.title)+'</label>').join('');
  $('#mbox').innerHTML='<h3>Services — '+esc(p.name)+'</h3><p style="color:#7a7266;font-size:.82rem;margin:0 0 12px">Tick the treatments this practitioner offers. If none are ticked, they are treated as able to do <b>all</b> services (used when the booking page auto-assigns a free practitioner).</p><div class="svcgrid">'+rows+'</div><div class="modal-actions" style="justify-content:flex-end"><button class="btn" onclick="closeM();renderRoster()">Done</button></div>';
  $('#mbg').classList.add('on');
}
async function toggleSvc(pid,sid,on){const p=pracList.find(x=>x.id===pid);const set=new Set((p.services||'').split(',').map(s=>s.trim()).filter(Boolean));on?set.add(String(sid)):set.delete(String(sid));p.services=meta.services.filter(s=>set.has(String(s.id))).map(s=>s.id).join(',');await saveP(ppayload(p))}
// ---- services catalogue page ----
async function loadServices(){const {ok,data}=await api('/api/services');if(!ok)return loginView('');svcList=data.services||[];meta.services=svcList;renderServices()}
function renderServices(){
  const rows=svcList.map(s=>'<div class="svcrow"><input type="color" value="'+(s.color||'#c98a3f')+'" onchange="svcSet('+s.id+',\\'color\\',this.value)" title="Colour on the day view"><input class="st" value="'+esc(s.title)+'" onchange="svcSet('+s.id+',\\'title\\',this.value)"><input class="sp" type="number" min="0" value="'+(s.price||0)+'" onchange="svcSet('+s.id+',\\'price\\',this.value)" title="Price (£)"><input class="sd" type="number" min="5" step="5" value="'+(s.duration_min||60)+'" onchange="svcSet('+s.id+',\\'duration_min\\',this.value)" title="Duration (min)"><button class="btn danger" onclick="svcDel('+s.id+')">Delete</button></div>').join('');
  $('#app').innerHTML=shell('<h2 style="margin:4px 0 6px;font-size:1.25rem">Services</h2><p style="color:#7a7266;font-size:.85rem;margin:0 0 16px">Each service has a <b>colour</b> used to shade its bookings on the day view (so you can tell treatments apart at a glance). Price is in £, duration in minutes. Changes are saved automatically.</p><div class="rosterbox">'+rows+'</div><div class="addrow"><input type="color" id="ns_color" value="#4a6fa5"><input id="ns_title" placeholder="New service name" style="flex:1;max-width:280px"><input id="ns_price" type="number" placeholder="£" min="0" style="width:90px"><input id="ns_dur" type="number" placeholder="min" value="60" min="5" step="5" style="width:90px"><button class="btn" onclick="svcAdd()">+ Add</button></div>');
}
async function svcSave(s){await api('/api/service_save',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(s)})}
async function svcSet(id,k,v){const s=svcList.find(x=>x.id===id);s[k]=(k==='price'||k==='duration_min')?+v:v;await svcSave({id:s.id,title:s.title,price:s.price,duration_min:s.duration_min,color:s.color})}
async function svcDel(id){if(!confirm('Delete this service? Existing bookings keep their time but lose the service label.'))return;await api('/api/service_delete',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id})});loadServices()}
async function svcAdd(){const t=$('#ns_title').value.trim();if(!t){alert('Enter a name');return}await svcSave({title:t,price:+$('#ns_price').value||0,duration_min:+$('#ns_dur').value||60,color:$('#ns_color').value});loadServices()}
async function logout(){await fetch('/api/logout');loginView('')}
boot();
</script></body></html>`;
