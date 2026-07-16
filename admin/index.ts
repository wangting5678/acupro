/// <reference types="@cloudflare/workers-types" />

export interface Env {
  DB: D1Database;
  ADMIN_PASSWORD: string;
  RESEND_API_KEY?: string;
  MAIL_FROM?: string;
  PUBLIC_URL?: string; // public site base for patient cancel links
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
async function notifyBooking(env: Env, appointmentId: number, kind: "new" | "updated", includeNote = false) {
  try {
    const r = await env.DB.prepare(
      `SELECT c.full_name, c.email AS pemail, s.title AS service, a.location_id, a.start_date, ca.notes,
              p.email AS demail, a.cancel_token
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
    const noteHtml = includeNote && r.notes ? `<p><b>Note:</b> ${r.notes}</p>` : "";
    const cancelUrl = r.cancel_token ? `${env.PUBLIC_URL || "https://acupro-uk.jinzhiqi19860716.workers.dev"}/cancel?t=${r.cancel_token}` : "";
    const cancelHtml = cancelUrl ? `<p style="margin:16px 0"><a href="${cancelUrl}" style="background:#1f4d43;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;display:inline-block;font-weight:600">View or cancel my appointment</a></p>` : "";
    const pHtml = `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.6"><p>Dear ${r.full_name},</p><p>Your AcuPro Clinic appointment has been ${verb}:</p><p><b>${r.service || "Appointment"}</b></p><p><b>Time:</b> ${date} @ ${time}</p><p><b>Location:</b> ${clinic.name}<br>${clinic.addr}<br>${clinic.phone}</p>${noteHtml}${cancelHtml}<p>Thank you for choosing AcuPro Clinic.</p></div>`;
    const dHtml = `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.6"><p>Hello.</p><p>Booking ${kind === "new" ? "added" : "updated"}.</p><p><b>Client:</b> ${r.full_name}<br><b>Service:</b> ${r.service || ""}<br><b>Date:</b> ${date}<br><b>Time:</b> ${time}<br><b>Location:</b> ${clinic.addr}</p>${noteHtml}</div>`;
    const jobs = [sendMail(env, r.pemail, `Your AcuPro appointment ${verb}`, pHtml)];
    if (r.demail) jobs.push(sendMail(env, r.demail, `Booking ${kind} — ${r.full_name}`, dHtml));
    await Promise.all(jobs);
  } catch { /* ignore */ }
}

async function getCurrency(env: Env): Promise<string> {
  const r = await env.DB.prepare("SELECT value FROM settings WHERE key='currency'").first<{ value: string }>();
  return r?.value === "AED" ? "AED" : "GBP";
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
        env.DB.prepare("SELECT id,title,price,duration_min,color,visibility FROM services ORDER BY title").all(),
        env.DB.prepare("SELECT id,name,photo,clinics FROM practitioners ORDER BY position").all(),
        env.DB.prepare("SELECT id,name,abbr FROM locations ORDER BY name").all(),
      ]);
      return json({ services: services.results, practitioners: practitioners.results, locations: locations.results, currency: await getCurrency(env) });
    }

    // global currency setting (GBP | AED)
    if (url.pathname === "/api/currency" && req.method === "POST") {
      const { currency } = (await req.json()) as any;
      const cur = currency === "AED" ? "AED" : "GBP";
      await env.DB.prepare("INSERT INTO settings(key,value) VALUES('currency',?) ON CONFLICT(key) DO UPDATE SET value=?").bind(cur, cur).run();
      return json({ ok: true, currency: cur });
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
      const { start_date, service_id, staff_id, location_id, notes, full_name, phone, email, customer_id, email_note } = b;
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
      const appt = await env.DB.prepare("INSERT INTO appointments(location_id,staff_id,service_id,start_date,end_date,cancel_token) VALUES(?,?,?,?,?,?) RETURNING id").bind(location_id ?? null, staff_id || null, service_id ?? null, start_date, end, crypto.randomUUID()).first<{ id: number }>();
      await env.DB.prepare("INSERT INTO customer_appointments(customer_id,appointment_id,notes) VALUES(?,?,?)").bind(cust!.id, appt!.id, notes ?? "").run();
      ctx.waitUntil(notifyBooking(env, appt!.id, "new", !!email_note));
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
      const ABBR2LOC: Record<string, number> = { VCT: 3, CITY: 11, ONLINE: 4, AUH: 20 };
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
      const { results } = await env.DB.prepare("SELECT id,name,photo,clinics,email,services,bio,position FROM practitioners ORDER BY position, id").all();
      return json({ practitioners: results });
    }
    if (url.pathname === "/api/prac_save" && req.method === "POST") {
      const { id, name, clinics, photo, email, services, bio } = (await req.json()) as any;
      if (!name) return json({ error: "name required" }, 400);
      if (id) {
        await env.DB.prepare("UPDATE practitioners SET name=?, clinics=?, photo=?, email=?, services=?, bio=? WHERE id=?").bind(name, clinics ?? "", photo ?? null, email ?? "", services ?? "", bio ?? "", id).run();
        return json({ ok: true, id });
      }
      const mx = await env.DB.prepare("SELECT COALESCE(MAX(id),0)+1 AS nid, COALESCE(MAX(position),0)+1 AS npos FROM practitioners").first<{ nid: number; npos: number }>();
      await env.DB.prepare("INSERT INTO practitioners(id,name,photo,clinics,email,services,bio,position) VALUES(?,?,?,?,?,?,?,?)").bind(mx!.nid, name, photo ?? null, clinics ?? "", email ?? "", services ?? "", bio ?? "", mx!.npos).run();
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
      const { results } = await env.DB.prepare("SELECT id,title,price,duration_min,color,visibility,description,region FROM services ORDER BY title").all();
      return json({ services: results });
    }
    if (url.pathname === "/api/service_save" && req.method === "POST") {
      const { id, title, price, duration_min, color, visibility, description, region } = (await req.json()) as any;
      if (!title) return json({ error: "title required" }, 400);
      const vis = visibility === "private" ? "private" : "public";
      const reg = region === "UAE" ? "UAE" : "UK";
      if (id) {
        await env.DB.prepare("UPDATE services SET title=?, price=?, duration_min=?, color=?, visibility=?, description=?, region=? WHERE id=?")
          .bind(title, price ?? 0, duration_min ?? 60, color ?? null, vis, description ?? "", reg, id).run();
        return json({ ok: true, id });
      }
      const mx = await env.DB.prepare("SELECT COALESCE(MAX(id),0)+1 AS nid FROM services").first<{ nid: number }>();
      await env.DB.prepare("INSERT INTO services(id,title,price,duration_min,color,visibility,description,region) VALUES(?,?,?,?,?,?,?,?)")
        .bind(mx!.nid, title, price ?? 0, duration_min ?? 60, color ?? null, vis, description ?? "", reg).run();
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

    // ---- staff notes / message board (per day) ----
    if (url.pathname === "/api/notes" && req.method === "GET") {
      const date = url.searchParams.get("date") || "";
      const { results } = await env.DB.prepare("SELECT id,date,author,body,created_at FROM staff_notes WHERE date=? ORDER BY created_at").bind(date).all();
      return json({ notes: results });
    }
    if (url.pathname === "/api/note_add" && req.method === "POST") {
      const { date, author, body } = (await req.json()) as any;
      if (!date || !body || !String(body).trim()) return json({ error: "missing" }, 400);
      const now = new Date().toISOString();
      await env.DB.prepare("INSERT INTO staff_notes(date,author,body,created_at) VALUES(?,?,?,?)").bind(date, (author || "").trim() || "Staff", String(body).trim(), now).run();
      return json({ ok: true });
    }
    if (url.pathname === "/api/note_del" && req.method === "POST") {
      const { id } = (await req.json()) as any;
      await env.DB.prepare("DELETE FROM staff_notes WHERE id=?").bind(id).run();
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
  /* month view */
  .monthgrid{display:grid;grid-template-columns:repeat(7,1fr);gap:6px;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:10px}
  .mhead{text-align:center;font-size:.72rem;font-weight:700;color:#8a8172;text-transform:uppercase;letter-spacing:.04em;padding:4px 0}
  .mcell{min-height:92px;border:1px solid var(--line);border-radius:10px;padding:7px 8px;cursor:pointer;background:#fff}
  .mcell:hover{border-color:var(--pine)}
  .mcell.out{background:#faf6ef}
  .mcell.today{border-color:var(--pine);box-shadow:0 0 0 2px rgba(31,77,67,.12)}
  .mnum{font-weight:700;font-size:.9rem}
  .mcell.out .mnum{color:#c3bcae}
  .mcount{margin-top:8px;font-size:.72rem;color:#fff;background:var(--pine);border-radius:6px;padding:2px 7px;display:inline-block}
  /* team notes board */
  .notesbox{background:#fff;border:1px dashed var(--pine);border-radius:10px;padding:9px 14px;margin-bottom:12px}
  .notesbox h5{margin:0 0 6px;font-size:.75rem;color:#1f4d43;text-transform:uppercase;letter-spacing:.05em}
  .noteitem{position:relative;padding:6px 22px 6px 0;border-bottom:1px dashed var(--line)}
  .noteitem:last-of-type{border-bottom:0}
  .nauthor{font-weight:700;font-size:.85rem;margin-right:8px}
  .ntime{font-size:.72rem;color:#a9a08d}
  .nbody{font-size:.9rem;color:#4a463f;margin-top:2px;white-space:pre-wrap}
  .ndel{position:absolute;right:0;top:6px;background:none;border:0;color:#b0553a;cursor:pointer;font-size:.8rem}
  .noteadd{display:flex;gap:8px;margin-top:10px}
  .noteadd input{flex:1}
  .noteadd .btn{padding:8px 14px;white-space:nowrap}
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
  .colbody.bookable{cursor:pointer}
  .hovertime{position:absolute;left:4px;background:var(--pine);color:#fff;font-size:.68rem;font-weight:700;padding:1px 7px;border-radius:5px;z-index:3;pointer-events:none;transform:translateY(-1px);white-space:nowrap;box-shadow:0 1px 4px rgba(0,0,0,.2)}
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
  .stname{flex:1;max-width:320px;text-align:left;background:#fff;border:1px solid var(--line);border-radius:9px;padding:11px 12px;font:inherit;font-weight:600;color:var(--ink);cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .stname:hover{border-color:var(--pine);background:#f6faf8}
  .stname .hasinfo{color:#256b45;font-weight:600;font-size:.82rem}
  .regtgl{border:1px solid var(--line);background:#fff;color:#7a7266;border-radius:999px;padding:7px 16px;font-size:.85rem;font-weight:700;cursor:pointer}
  .regtgl.on{background:var(--pine);color:#fff;border-color:var(--pine)}
  .svcrow:last-child{border-bottom:0}
  .svcrow input[type=color]{width:38px;height:34px;padding:2px;cursor:pointer}
  .svcrow .st{flex:1;max-width:320px}
  .svcrow .sp{width:70px}.svcrow .sd{width:70px}
  .svchead{display:flex;align-items:center;gap:10px;padding:9px 14px;border-bottom:2px solid var(--line);font-size:.7rem;font-weight:700;color:#8a8172;text-transform:uppercase;letter-spacing:.04em}
  .nf{display:flex;align-items:center;gap:5px}
  .nf>span{color:#8a8172;font-size:.9rem}
  .vistgl{border:1px solid var(--line);border-radius:999px;padding:7px 13px;font-size:.8rem;font-weight:700;cursor:pointer;white-space:nowrap}
  .vistgl.pub{background:#eef5f0;color:#256b45;border-color:#cfe0d5}
  .vistgl.prv{background:#f6ede0;color:#a9772a;border-color:#e6d3ac}
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
const CLINIC_COLOR={VCT:'#256b45',CITY:'#b0553a',ONLINE:'#4a3f7a',AUH:'#a9772a'};
const START=9,END=21; let HPX=60; // 9am-9pm; HPX (px/hour) is recomputed per render to fit one screen
function fitHPX(){HPX=Math.max(30,Math.min(58,Math.floor((window.innerHeight-300)/(END-START))))}
const PAD=12; // top breathing room so the first hour label (9am) isn't hidden under the sticky header
const COLH=()=>(END-START)*HPX+PAD+8;
let appts=[],meta={services:[],practitioners:[],locations:[]},view='week',cursor=monday(new Date()),dayDate=new Date();
let page='bookings',pracList=[],newClin=new Set(),hours=[],svcList=[],locFilter='',svcRegion='UK',monthCursor=new Date(),notes=[];
function setLocFilter(v){locFilter=v;render()}
function locFilterCtrl(){
  const opts='<option value="">All locations</option>'+meta.locations.filter(l=>l.abbr).map(l=>'<option value="'+l.abbr+'"'+(locFilter===l.abbr?' selected':'')+'>'+esc(l.name)+'</option>').join('');
  return '<span style="font-size:.8rem;color:#7a7266;margin:0 6px 0 4px">Location:</span><select onchange="setLocFilter(this.value)" style="width:auto;padding:8px 10px;font-weight:600;border:1px solid var(--line);border-radius:8px;background:#fff;cursor:pointer">'+opts+'</select>';
}
function pracInLoc(p){return !locFilter||(p.clinics||'').split(',').map(s=>s.trim()).includes(locFilter)}
function apptInLoc(a){return !locFilter||a.loc_abbr===locFilter}
let selCust=null,custTimer=null,custResults=[];
const CLINIC_ALL=['VCT','CITY','ONLINE','AUH'];
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
function photoUrl(photo){return /^https?:\\/\\//.test(photo||'')?photo:UK+photo}
function avatar(photo,name,cls){return photo?'<img draggable="false" class="av '+(cls||'')+'" src="'+photoUrl(photo)+'" alt="">':'<span class="av ph '+(cls||'')+'">'+initials(name)+'</span>'}
function cbadge(ab){if(!ab)return '';return '<span class="cbadge" style="background:'+(CLINIC_COLOR[ab]||'#7a7266')+'">'+esc(ab)+'</span>'}
async function api(p,o){const r=await fetch(p,o);let d={};try{d=await r.json()}catch(e){};return{ok:r.ok,data:d}}

function loginView(msg){$('#app').innerHTML='<div class="login"><h1>AcuPro Admin</h1><p>Booking management</p><input id="pw" type="password" placeholder="Password" autofocus><button class="btn" style="width:100%;margin-top:12px" onclick="doLogin()">Sign in</button><div style="color:#b0553a;font-size:.85rem;margin-top:8px">'+(msg||'')+'</div></div>';$('#pw').addEventListener('keydown',e=>{if(e.key==='Enter')doLogin()})}
async function doLogin(){const {ok,data}=await api('/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:$('#pw').value})});ok?boot():loginView(data.error||'Login failed')}
async function boot(){const m=await api('/api/meta');if(!m.ok)return loginView('');meta=m.data;await load()}
async function load(){const a=await api('/api/appointments');if(!a.ok)return loginView('');appts=a.data.appointments||[];const h=await api('/api/hours');hours=h.ok?(h.data.hours||[]):[];render()}

function navbtn(p,label){const fn=p==='roster'?'goRoster':p==='services'?'goServices':'goBookings';return '<button style="background:'+(page===p?'#fff':'rgba(255,255,255,.15)')+';color:'+(page===p?'#1f4d43':'#fff')+';font-weight:600" onclick="'+fn+'()">'+label+'</button>'}
function shell(inner){return '<header><h1>📅 AcuPro</h1><div style="display:flex;gap:8px">'+navbtn('bookings','Bookings')+navbtn('roster','Practitioners')+navbtn('services','Services')+'</div><button onclick="logout()">Sign out</button></header><div class="wrap">'+inner+'</div>'+modalHtml()}
function render(){if(page==='roster')return renderRoster();if(page==='services')return renderServices();if(view==='month')return renderMonth();view==='day'?renderDay():renderWeek()}
function viewTabs(){return '<button class="nav-btn'+(view==='week'?' on':'')+'" onclick="toWeek()">Week</button><button class="nav-btn'+(view==='day'?' on':'')+'" onclick="toDayView()">Day</button><button class="nav-btn'+(view==='month'?' on':'')+'" onclick="toMonth()">Month</button>'}
function toMonth(){view='month';monthCursor=new Date();render()}
function mo(n){monthCursor=new Date(monthCursor.getFullYear(),monthCursor.getMonth()+n,1);render()}
function moToday(){monthCursor=new Date();render()}
function renderMonth(){
  const first=new Date(monthCursor.getFullYear(),monthCursor.getMonth(),1);
  const gs=monday(first);const label=first.toLocaleDateString('en-GB',{month:'long',year:'numeric'});const todayS=ymd(new Date());
  const head=['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map(x=>'<div class="mhead">'+x+'</div>').join('');
  let cells='';
  for(let i=0;i<42;i++){const d=new Date(gs);d.setDate(gs.getDate()+i);const ds=ymd(d);const inM=d.getMonth()===first.getMonth();
    const cnt=appts.filter(a=>a.start_date&&a.start_date.slice(0,10)===ds&&apptInLoc(a)).length;
    cells+='<div class="mcell'+(inM?'':' out')+(ds===todayS?' today':'')+'" onclick=\\'openDay("'+ds+'")\\'><div class="mnum">'+d.getDate()+'</div>'+(cnt?'<div class="mcount">'+cnt+' booking'+(cnt>1?'s':'')+'</div>':'')+'</div>';
  }
  $('#app').innerHTML=shell('<div class="toolbar">'+viewTabs()+'<span style="width:12px"></span><button class="nav-btn" onclick="mo(-1)">←</button><button class="nav-btn" onclick="moToday()">This month</button><button class="nav-btn" onclick="mo(1)">→</button><span class="range">'+label+'</span>'+locFilterCtrl()+'<span style="flex:1"></span><button class="btn" onclick="openCreate()">+ New booking</button></div><div class="monthgrid">'+head+cells+'</div>');
}
function goBookings(){page='bookings';render()}
function goRoster(){page='roster';loadPrac()}
function goServices(){page='services';loadServices()}

function renderWeek(){
  const days=[...Array(7)].map((_,i)=>{const d=new Date(cursor);d.setDate(d.getDate()+i);return d});
  const end=new Date(cursor);end.setDate(end.getDate()+6);
  const label=cursor.toLocaleDateString('en-GB',{day:'numeric',month:'short'})+' – '+end.toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'});
  const todayS=ymd(new Date());
  const cols=days.map(d=>{const ds=ymd(d);
    const list=appts.filter(a=>a.start_date&&a.start_date.slice(0,10)===ds&&apptInLoc(a)).sort((a,b)=>a.start_date.localeCompare(b.start_date));
    const chips=list.map(a=>'<div class="chip"><div class="t">'+a.start_date.slice(11,16)+cbadge(a.loc_abbr)+'</div><div class="n">'+esc(a.full_name)+'</div></div>').join('')||'<div class="empty">—</div>';
    return '<div class="day'+(ds===todayS?' today':'')+'" onclick=\\'openDay("'+ds+'")\\'><h4>'+d.toLocaleDateString('en-GB',{weekday:'short'})+'<b>'+d.getDate()+'</b></h4>'+chips+'</div>';
  }).join('');
  $('#app').innerHTML=shell('<div class="toolbar">'+viewTabs()+'<span style="width:12px"></span><button class="nav-btn" onclick="wk(-7)">←</button><button class="nav-btn" onclick="wkToday()">This week</button><button class="nav-btn" onclick="wk(7)">→</button><span class="range">'+label+'</span>'+locFilterCtrl()+'<span style="flex:1"></span><button class="btn" onclick="openCreate()">+ New booking</button></div><div class="week">'+cols+'</div>');
}
function wk(n){cursor.setDate(cursor.getDate()+n);render()}
function wkToday(){cursor=monday(new Date());render()}
function openDay(ds){dayDate=new Date(ds+'T00:00:00');view='day';loadDayNotes()}
function toDayView(){dayDate=new Date();view='day';loadDayNotes()}
function toWeek(){view='week';render()}
async function loadDayNotes(){const n=await api('/api/notes?date='+ymd(dayDate));notes=n.ok?(n.data.notes||[]):[];renderDay()}
let noteAuthor='';
async function addNote(){const b=$('#note_body').value.trim();if(!b)return;noteAuthor=$('#note_author').value.trim();await api('/api/note_add',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({date:ymd(dayDate),author:noteAuthor,body:b})});await loadDayNotes()}
async function delNote(id){if(!confirm('Delete this note?'))return;await api('/api/note_del',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id})});await loadDayNotes()}
function notesBox(){
  const list=notes.map(n=>'<div class="noteitem"><span class="nauthor">'+esc(n.author)+'</span><span class="ntime">'+(n.created_at?new Date(n.created_at).toLocaleString('en-GB',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}):'')+'</span><button class="ndel" onclick="delNote('+n.id+')" title="Delete">✕</button><div class="nbody">'+esc(n.body)+'</div></div>').join('')||'<div style="color:#7a7266;font-size:.82rem">No notes yet — leave a message for colleagues about this day.</div>';
  return '<div class="notesbox"><h5>📌 Team notes — '+dayDate.toLocaleDateString('en-GB',{weekday:'short',day:'numeric',month:'short'})+'</h5><div class="notelist">'+list+'</div><div class="noteadd"><input id="note_author" placeholder="Your name" value="'+esc(noteAuthor)+'" style="max-width:150px"><input id="note_body" placeholder="Leave a note for this day…" onkeydown="if(event.key===\\'Enter\\')addNote()"><button class="btn" onclick="addNote()">Post</button></div></div>';
}

function renderDay(){
  fitHPX();
  const ds=ymd(dayDate);
  const label=dayDate.toLocaleDateString('en-GB',{weekday:'long',day:'numeric',month:'short',year:'numeric'});
  const svcColor={};meta.services.forEach(s=>{if(s.color)svcColor[s.id]=s.color});
  const list=appts.filter(a=>a.start_date&&a.start_date.slice(0,10)===ds);
  const cols=meta.practitioners.filter(pracInLoc);
  // unassigned
  const un=list.filter(a=>!a.staff_id&&apptInLoc(a));
  const unHtml='<div class="unassigned" data-pid="" ondragover="dOver(event)" ondragleave="dLeave(event)" ondrop="dDrop(event,\\'\\')"><h5>Unassigned — drag onto a practitioner</h5>'+
    (un.map(a=>'<span class="uchip" draggable="true" ondragstart="dStart(event,'+a.id+')" ondragend="dEnd(event)" onclick="openEdit('+a.id+')">'+a.start_date.slice(11,16)+' '+esc(a.full_name)+cbadge(a.loc_abbr)+'</span>').join('')||'<span style="color:#7a7266;font-size:.82rem">✅ No unassigned bookings right now. &nbsp;📧 Email notifications: up to <b>100/day · 3,000/month</b> (Resend free tier).</span>')+'</div>';
  // gutter
  let gutter='<div class="col gutter"><div class="colhead"></div><div class="colbody" style="height:'+COLH()+'px">';
  for(let h=START;h<=END;h++){gutter+='<div class="hourlabel" style="top:'+(PAD+(h-START)*HPX)+'px">'+((h%12)||12)+(h<12?'am':'pm')+'</div>'}
  gutter+='</div></div>';
  const dow=curDow();
  const body=cols.map(p=>{
    const items=list.filter(a=>String(a.staff_id)===String(p.id));
    let lines='';for(let h=START;h<=END;h++){lines+='<div class="hourline" style="top:'+(PAD+(h-START)*HPX)+'px"></div>'}
    const whs=hours.filter(h=>String(h.practitioner_id)===String(p.id)&&!h.date&&h.dow===dow);
    const whHtml=whs.map(h=>{const s=hmToMin(h.start_time),e=hmToMin(h.end_time);const top=PAD+(s-START*60)/60*HPX,hgt=Math.max((e-s)/60*HPX,6);return '<div class="whblock" style="top:'+top+'px;height:'+hgt+'px" title="Working hours '+h.start_time+'–'+h.end_time+' — edit in Practitioners"><span>'+h.start_time+'–'+h.end_time+'</span></div>'}).join('');
    const laid=layoutLanes(items);
    const blocks=laid.map(a=>{
      const sm=mins(a.start_date), dur=a.duration_min||60;
      const top=PAD+(sm-START*60)/60*HPX, hgt=Math.max(dur/60*HPX-2,22);
      const w=100/a._lanes, left=a._lane*w;
      const col=svcColor[a.service_id]||'#c98a3f';
      const style='top:'+top+'px;height:'+hgt+'px;left:calc('+left+'% + 2px);width:calc('+w+'% - 4px);background:'+rgba(col,.22)+';border-color:'+rgba(col,.5)+';border-left:3px solid '+col;
      const svcName=hgt>=40?'<div class="s">'+esc(a.service||'')+'</div>':'';
      return '<div class="appt" draggable="true" title="'+esc(a.service||'')+' · '+esc(a.full_name)+'" style="'+style+'" ondragstart="dStart(event,'+a.id+')" ondragend="dEnd(event)" onclick="openEdit('+a.id+')"><div class="t">'+a.start_date.slice(11,16)+cbadge(a.loc_abbr)+'</div><div class="n">'+esc(a.full_name)+'</div>'+svcName+'</div>';
    }).join('');
    return '<div class="col" data-pid="'+p.id+'" ondragover="dOver(event)" ondragleave="dLeave(event)" ondrop="dDrop(event,'+p.id+')"><div class="colhead" draggable="true" ondragstart="colDragStart(event,'+p.id+')" ondragover="event.preventDefault()" ondrop="colDrop(event,'+p.id+')" title="Drag to reorder">'+avatar(p.photo,p.name)+esc(p.name)+'</div><div class="colbody bookable" style="height:'+COLH()+'px" onmousemove="colHover(event,'+p.id+')" onmouseleave="colHoverOut()" onclick="colClick(event,'+p.id+')">'+whHtml+lines+blocks+'</div></div>';
  }).join('');
  const usedSvc=[...new Set(list.map(a=>a.service_id).filter(Boolean))].map(id=>meta.services.find(s=>String(s.id)===String(id))).filter(Boolean);
  const legend=usedSvc.length?'<div class="legend">'+usedSvc.map(s=>'<span class="lg"><span class="sw" style="background:'+(s.color||'#c98a3f')+'"></span>'+esc(s.title)+'</span>').join('')+'</div>':'';
  $('#app').innerHTML=shell('<div class="toolbar">'+viewTabs()+'<span style="width:12px"></span><button class="nav-btn" onclick="dy(-1)">←</button><button class="nav-btn" onclick="dyToday()">Today</button><button class="nav-btn" onclick="dy(1)">→</button><span class="range">'+label+'</span>'+locFilterCtrl()+'<span style="flex:1"></span><span style="font-size:.78rem;color:#7a7266;margin-right:6px">Shaded = working hours (set in Practitioners)</span><button class="btn" onclick="openCreate()">+ New booking</button></div>'+notesBox()+unHtml+legend+'<div class="daygrid">'+(cols.length?gutter+body:'<div style="padding:40px;color:#7a7266">No practitioners at this location.</div>')+'</div>');
}
function dy(n){dayDate.setDate(dayDate.getDate()+n);loadDayNotes()}
function dyToday(){dayDate=new Date();loadDayNotes()}
// hover empty column → show time; click empty → new booking prefilled with this practitioner + time
function hm12(m){let h=Math.floor(m/60);const mm=m%60,ap=h<12?'am':'pm';h=(h%12)||12;return h+':'+String(mm).padStart(2,'0')+' '+ap}
function snapMin(e,body){const rect=body.getBoundingClientRect();let m=START*60+Math.round(((e.clientY-rect.top-PAD)/HPX*60)/15)*15;return Math.max(START*60,Math.min(m,END*60-15))}
function colHover(e,pid){const body=e.currentTarget;if(e.target.closest('.appt')){colHoverOut();return}
  const m=snapMin(e,body);let el=body.querySelector('.hovertime');if(!el){el=document.createElement('div');el.className='hovertime';body.appendChild(el)}
  el.style.top=(PAD+(m-START*60)/60*HPX)+'px';el.textContent=hm12(m)+' · + book'}
function colHoverOut(){document.querySelectorAll('.hovertime').forEach(x=>x.remove())}
function colClick(e,pid){if(e.target.closest('.appt'))return;const m=snapMin(e,e.currentTarget);
  const p=meta.practitioners.find(x=>String(x.id)===String(pid));const ABBR2LOC={VCT:3,CITY:11,ONLINE:4,AUH:20};
  const ab=p&&p.clinics?(p.clinics.split(',').map(s=>s.trim()).filter(Boolean)[0]):null;
  colHoverOut();openCreate({staff_id:pid,time:minToHm(m),date:ymd(dayDate),location_id:ab?ABBR2LOC[ab]:''})}

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
  let m=START*60+Math.round(((e.clientY-rect.top-gy-PAD)/HPX*60)/15)*15; m=Math.max(START*60,Math.min(m,END*60-15));
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
function svcOpt(sel){return meta.services.map(o=>'<option value="'+o.id+'"'+(String(o.id)===String(sel)?' selected':'')+'>'+esc(o.title)+(o.visibility==='private'?' (private)':'')+'</option>').join('')}
function modalHtml(){return '<div class="modal-bg" id="mbg"><div class="modal" id="mbox"></div></div>'}
function openEdit(id){const a=appts.find(x=>x.id===id);if(!a)return;
  const date=a.start_date.slice(0,10),time=a.start_date.slice(11,16);
  $('#mbox').innerHTML='<h3>Edit booking</h3>'+
    '<div class="fld"><label>Customer name</label><input id="e_name" value="'+esc(a.full_name)+'"></div>'+
    '<div class="grid2"><div class="fld"><label>Phone</label><input id="e_phone" value="'+esc(a.phone)+'"></div><div class="fld"><label>Email</label><input id="e_email" value="'+esc(a.email)+'"></div></div>'+
    '<div class="grid2"><div class="fld"><label>Date</label><input id="e_date" type="date" value="'+date+'"></div><div class="fld"><label>Time</label><input id="e_time" type="time" value="'+time+'"></div></div>'+
    '<div class="fld"><label>Service</label><select id="e_service">'+svcOpt(a.service_id)+'</select></div>'+
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
function openCreate(pre){pre=pre||{};selCust=null;custResults=[];const d=pre.date||(view==='day'?ymd(dayDate):ymd(new Date()));
  $('#mbox').innerHTML='<h3>New booking</h3>'+
    '<div class="fld"><label>Find existing customer</label><div class="csrch"><input id="c_search" placeholder="Search name, phone or email…" oninput="custSearch(this.value)" autocomplete="off"><div class="csugg" id="c_sugg" style="display:none"></div></div></div>'+
    '<div id="c_pickwrap"></div>'+
    '<div class="fld"><label>Customer name</label><input id="c_name" placeholder="Full name" oninput="if(selCust)clearCust(true)"></div>'+
    '<div class="grid2"><div class="fld"><label>Phone</label><input id="c_phone"></div><div class="fld"><label>Email</label><input id="c_email"></div></div>'+
    '<div class="grid2"><div class="fld"><label>Date</label><input id="c_date" type="date" value="'+d+'"></div><div class="fld"><label>Time</label><input id="c_time" type="time" value="'+(pre.time||'10:00')+'"></div></div>'+
    '<div class="fld"><label>Service</label><select id="c_service">'+svcOpt('')+'</select></div>'+
    '<div class="grid2"><div class="fld"><label>Practitioner</label><select id="c_staff"><option value="">Unassigned</option>'+opt(meta.practitioners,'id','name',pre.staff_id||'')+'</select></div>'+
    '<div class="fld"><label>Location</label><select id="c_loc">'+opt(meta.locations,'id','name',pre.location_id||'')+'</select></div></div>'+
    '<div class="fld"><label>Notes</label><textarea id="c_notes" rows="2"></textarea></div>'+
    '<label style="display:flex;align-items:center;gap:8px;font-size:.85rem;cursor:pointer;margin:-4px 0 4px"><input type="checkbox" id="c_emailnote" checked style="width:auto;margin:0"> Send this note in the confirmation email (patient &amp; practitioner)</label>'+
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
async function createBk(){const body={start_date:$('#c_date').value+' '+$('#c_time').value+':00',service_id:+$('#c_service').value,staff_id:$('#c_staff').value?+$('#c_staff').value:null,location_id:$('#c_loc').value?+$('#c_loc').value:null,notes:$('#c_notes').value,full_name:$('#c_name').value,phone:$('#c_phone').value,email:$('#c_email').value,customer_id:selCust?selCust.id:null,email_note:$('#c_emailnote').checked};
  if(!body.full_name){alert('Enter customer name');return}
  await api('/api/create',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});closeM();load()}
// ---- practitioner roster ----
async function loadPrac(){const [p,h]=await Promise.all([api('/api/prac'),api('/api/hours')]);if(!p.ok)return loginView('');pracList=p.data.practitioners||[];hours=h.ok?(h.data.hours||[]):[];renderRoster()}
function clchip(ab,on,cb){return '<button class="clchip'+(on?' on':'')+'" style="'+(on?'background:'+CLINIC_COLOR[ab]+';color:#fff;border-color:'+CLINIC_COLOR[ab]:'')+'" onclick="'+cb+'">'+ab+'</button>'}
function ppayload(p){return {id:p.id,name:p.name,clinics:p.clinics||'',photo:p.photo,email:p.email||'',services:p.services||'',bio:p.bio||''}}
function svcCount(p){return (p.services||'').split(',').map(s=>s.trim()).filter(Boolean).length}
function hoursCount(p){return hours.filter(h=>String(h.practitioner_id)===String(p.id)&&!h.date).length}
function renderRoster(){
  const rows=pracList.map(p=>{const set=new Set((p.clinics||'').split(',').map(s=>s.trim()).filter(Boolean));
    const chips=CLINIC_ALL.map(ab=>clchip(ab,set.has(ab),'toggleClinic('+p.id+',\\''+ab+'\\')')).join('');
    const sc=svcCount(p),hc=hoursCount(p);
    return '<div class="prow"><span onclick="openPrac('+p.id+')" title="Edit photo &amp; bio" style="cursor:pointer;display:inline-flex">'+avatar(p.photo,p.name)+'</span><input class="pname" value="'+esc(p.name)+'" onchange="renamePrac('+p.id+',this.value)"><input class="pemail" value="'+esc(p.email||'')+'" placeholder="email for notifications" onchange="setEmail('+p.id+',this.value)"><div class="clset">'+chips+'</div>'+
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
async function addPrac(){const name=$('#np_name').value.trim();if(!name){alert('Enter a name');return}await saveP({name,email:$('#np_email').value.trim(),clinics:CLINIC_ALL.filter(a=>newClin.has(a)).join(','),services:'',bio:''});newClin=new Set();loadPrac()}
// practitioner detail (photo + bio)
function pdPreview(){const v=$('#pd_photo').value.trim();$('#pv_av').innerHTML=v?('<img class="av big" src="'+(/^https?:/.test(v)?v:UK+v)+'">'):('<span class="av ph big">'+initials($('#pd_name').value)+'</span>')}
function openPrac(id){const p=pracList.find(x=>x.id===id);if(!p)return;
  $('#mbox').innerHTML='<h3>Practitioner details — '+esc(p.name)+'</h3>'+
    '<div style="display:flex;gap:14px;align-items:center;margin-bottom:12px"><span id="pv_av">'+avatar(p.photo,p.name,'big')+'</span><div style="flex:1"><label style="display:block;font-size:.8rem;font-weight:600;margin-bottom:4px">Photo URL / path</label><input id="pd_photo" value="'+esc(p.photo||'')+'" placeholder="/staff/14.jpg or https://…" oninput="pdPreview()"></div></div>'+
    '<div class="fld"><label>Name</label><input id="pd_name" value="'+esc(p.name)+'"></div>'+
    '<div class="fld"><label>Bio / Information — shown to patients on the Team page</label><textarea id="pd_bio" rows="5" placeholder="Short bio, specialisation, experience…">'+esc(p.bio||'')+'</textarea></div>'+
    '<div class="modal-actions" style="justify-content:flex-end"><button class="btn ghost" onclick="closeM()">Close</button><button class="btn" onclick="savePrac('+p.id+')">Save</button></div>';
  $('#mbg').classList.add('on');
}
async function savePrac(id){const p=pracList.find(x=>x.id===id);p.photo=$('#pd_photo').value.trim()||null;p.name=$('#pd_name').value.trim()||p.name;p.bio=$('#pd_bio').value;await saveP(ppayload(p));closeM();renderRoster()}
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
function spayload(s){return {id:s.id,title:s.title,price:s.price,duration_min:s.duration_min,color:s.color,visibility:s.visibility||'public',description:s.description||'',region:s.region||'UK'}}
function visBtn(s){const pub=s.visibility!=='private';return '<button class="vistgl '+(pub?'pub':'prv')+'" onclick="svcVis('+s.id+')" title="'+(pub?'Bookable on the public site':'Admin-only — hidden from the public booking page')+'">'+(pub?'🌐 Public':'🔒 Private')+'</button>'}
function setSvcRegion(r){svcRegion=r;renderServices()}
function renderServices(){
  const sym=svcRegion==='UAE'?'AED':'£';
  const list=svcList.filter(s=>(s.region||'UK')===svcRegion);
  const regBar='<div style="display:flex;align-items:center;gap:8px;margin:0 0 14px"><span style="font-size:.85rem;color:#7a7266;font-weight:600">Catalogue:</span><button class="regtgl'+(svcRegion==='UK'?' on':'')+'" onclick="setSvcRegion(\\'UK\\')">🇬🇧 UK (£)</button><button class="regtgl'+(svcRegion==='UAE'?' on':'')+'" onclick="setSvcRegion(\\'UAE\\')">🇦🇪 UAE (AED)</button></div>';
  const head='<div class="svchead"><span style="width:38px"></span><span style="flex:1;max-width:320px">Service</span><span style="width:104px">Price ('+sym+')</span><span style="width:110px">Duration</span><span style="width:118px">Visibility</span><span style="flex:1"></span></div>';
  const rows=list.map(s=>'<div class="svcrow"><input type="color" value="'+(s.color||'#c98a3f')+'" onchange="svcSet('+s.id+',\\'color\\',this.value)" title="Colour on the day view"><button class="stname" onclick="openSvc('+s.id+')" title="Click to edit name & information">'+esc(s.title)+(s.description?' <span class="hasinfo">· info</span>':'')+'</button><div class="nf"><span>'+sym+'</span><input class="sp" type="number" min="0" value="'+(s.price||0)+'" onchange="svcSet('+s.id+',\\'price\\',this.value)" title="Price"></div><div class="nf"><input class="sd" type="number" min="5" step="5" value="'+(s.duration_min||60)+'" onchange="svcSet('+s.id+',\\'duration_min\\',this.value)" title="Duration in minutes"><span>min</span></div>'+visBtn(s)+'<button class="btn danger" onclick="svcDel('+s.id+')">Delete</button></div>').join('')||'<div style="padding:24px;color:#7a7266">No services in the '+svcRegion+' catalogue yet — add one below.</div>';
  $('#app').innerHTML=shell('<h2 style="margin:4px 0 6px;font-size:1.25rem">Services</h2><p style="color:#7a7266;font-size:.85rem;margin:0 0 12px">Two independent catalogues — <b>UK</b> and <b>UAE</b> — each with its own services, prices (UK in £, UAE in AED — unrelated numbers), descriptions and visibility. Each public site reads its own catalogue. <b>Click a service name</b> to edit its name &amp; information (shown to patients). <b>Visibility:</b> 🌐 Public = on the booking page; 🔒 Private = admin-only. Changes save automatically.</p>'+regBar+'<div class="rosterbox">'+head+rows+'</div><div class="addrow"><input type="color" id="ns_color" value="#4a6fa5" title="Colour"><input id="ns_title" placeholder="New '+svcRegion+' service name" style="flex:1;max-width:280px"><div class="nf"><span>'+sym+'</span><input id="ns_price" type="number" placeholder="0" min="0" style="width:80px"></div><div class="nf"><input id="ns_dur" type="number" placeholder="60" value="60" min="5" step="5" style="width:80px"><span>min</span></div><button class="btn" onclick="svcAdd()">+ Add to '+svcRegion+'</button></div>');
}
async function svcSave(s){await api('/api/service_save',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(s)})}
async function svcSet(id,k,v){const s=svcList.find(x=>x.id===id);s[k]=(k==='price'||k==='duration_min')?+v:v;await svcSave(spayload(s))}
async function svcVis(id){const s=svcList.find(x=>x.id===id);s.visibility=s.visibility==='private'?'public':'private';await svcSave(spayload(s));renderServices()}
async function svcDel(id){if(!confirm('Delete this service? Existing bookings keep their time but lose the service label.'))return;await api('/api/service_delete',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id})});loadServices()}
async function svcAdd(){const t=$('#ns_title').value.trim();if(!t){alert('Enter a name');return}await svcSave({title:t,price:+$('#ns_price').value||0,duration_min:+$('#ns_dur').value||60,color:$('#ns_color').value,visibility:'public',description:'',region:svcRegion});loadServices()}
function openSvc(id){const s=svcList.find(x=>x.id===id);if(!s)return;const sym=(s.region==='UAE')?'AED':'£';
  $('#mbox').innerHTML='<h3>Service details</h3>'+
    '<div class="fld"><label>Name</label><input id="sv_title" value="'+esc(s.title)+'"></div>'+
    '<div class="fld"><label>Information — shown to patients on the booking page</label><textarea id="sv_desc" rows="6" placeholder="Describe what this service is for…">'+esc(s.description||'')+'</textarea></div>'+
    '<div class="modal-actions"><span style="align-self:center;color:#999;font-size:.78rem">'+esc(s.region||'UK')+' · '+sym+(s.price||0)+' · '+(s.duration_min||60)+' min</span><div style="display:flex;gap:8px"><button class="btn ghost" onclick="closeM()">Close</button><button class="btn" onclick="saveSvc('+s.id+')">Save</button></div></div>';
  $('#mbg').classList.add('on');
}
async function saveSvc(id){const s=svcList.find(x=>x.id===id);s.title=$('#sv_title').value;s.description=$('#sv_desc').value;await svcSave(spayload(s));closeM();renderServices()}
async function logout(){await fetch('/api/logout');loginView('')}
boot();
</script></body></html>`;
