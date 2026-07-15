/// <reference types="@cloudflare/workers-types" />

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  RESEND_API_KEY?: string;
  MAIL_FROM?: string;
  SITE_CURRENCY?: string; // per-site display currency: "GBP" (UK) | "AED" (UAE)
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });

const CLINIC_INFO: Record<number, { name: string; addr: string; phone: string }> = {
  3: { name: "London Victoria", addr: "10 Buckingham Palace Rd, London, SW1W 0QP", phone: "07521 808882" },
  11: { name: "City of London", addr: "33-34 Bury St, London, EC3A 5AR", phone: "07521 808882" },
  4: { name: "Online Video Consultation", addr: "Online", phone: "+44 (0)20 3239 7888" },
};

async function sendMail(env: Env, to: string, subject: string, html: string) {
  if (!env.RESEND_API_KEY || !to) return; // no-op until an API key is configured
  const from = env.MAIL_FROM || "AcuPro Clinic <onboarding@resend.dev>";
  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: "Bearer " + env.RESEND_API_KEY, "content-type": "application/json" },
      body: JSON.stringify({ from, to, subject, html }),
    });
  } catch { /* ignore */ }
}

function patientEmailHtml(o: { name: string; service: string; date: string; time: string; note?: string; clinic: { name: string; addr: string; phone: string } }) {
  return `<div style="font-family:Arial,sans-serif;color:#23201c;font-size:15px;line-height:1.6">
    <p>Dear ${o.name},</p>
    <p>Thank you for booking with AcuPro Clinic. Here are your appointment details:</p>
    <p><b>${o.service}</b></p>
    <p><b>Time:</b> ${o.date} @ ${o.time}</p>
    <p><b>Location:</b> ${o.clinic.name}<br>${o.clinic.addr}<br>${o.clinic.phone}</p>
    ${o.note ? `<p><b>Note:</b> ${o.note}</p>` : ""}
    <p><b>Reschedule:</b> <a href="https://acuproclinic.co.uk/online-booking">book again</a> and add a note "replace the one on date …", or reply to this email and we'll adjust manually.</p>
    <p><b>Cancellation:</b> free up to 24 hours before — just reply "CANCEL" to this email.</p>
    <p>Thank you for choosing AcuPro Clinic.</p>
    <hr><p style="font-size:13px;color:#777">Head Office: +44 (0)20 3239 7888<br>City Branch: 33-34 Bury St, London, EC3A 5AR<br>Victoria Branch: 10 Buckingham Palace Rd, London, SW1W 0QP</p>
  </div>`;
}
function doctorEmailHtml(o: { name: string; service: string; note: string; date: string; time: string; addr: string }) {
  return `<div style="font-family:Arial,sans-serif;color:#23201c;font-size:15px;line-height:1.6">
    <p>Hello.</p><p>You have a new booking.</p>
    <p><b>Client name:</b> ${o.name}</p>
    <p><b>Service:</b> ${o.service}</p>
    ${o.note ? `<p><b>Note:</b> ${o.note}</p>` : ""}
    <p><b>Date:</b> ${o.date}<br><b>Time:</b> ${o.time}</p>
    <p><b>Location:</b> ${o.addr}</p>
  </div>`;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Public service catalogue — this site's region, only services visible to patients.
    if (url.pathname === "/api/services" && request.method === "GET") {
      const region = env.SITE_CURRENCY === "AED" ? "UAE" : "UK";
      const { results } = await env.DB.prepare(
        "SELECT id,title,price,duration_min,description FROM services WHERE COALESCE(visibility,'public')='public' AND COALESCE(region,'UK')=? ORDER BY title",
      ).bind(region).all();
      return json({ services: results, currency: env.SITE_CURRENCY === "AED" ? "AED" : "GBP" });
    }

    // Public practitioner roster — for the Team page (name, photo, bio).
    if (url.pathname === "/api/practitioners" && request.method === "GET") {
      const { results } = await env.DB.prepare(
        "SELECT id,name,photo,clinics,bio FROM practitioners ORDER BY position, id",
      ).all();
      return json({ practitioners: results });
    }

    // Real availability: per-day 30-min slots for a clinic+service, from practitioner working hours minus existing appointments.
    if (url.pathname === "/api/availability" && request.method === "GET") {
      const locId = Number(url.searchParams.get("location_id"));
      const svcId = Number(url.searchParams.get("service_id"));
      const TZ = "Europe/London"; // UK clinic timezone (UAE site would use Asia/Dubai)
      if (!locId || !svcId) return json({ error: "missing params" }, 400);
      const loc = await env.DB.prepare("SELECT abbr FROM locations WHERE id=?").bind(locId).first<{ abbr: string }>();
      const svc = await env.DB.prepare("SELECT duration_min FROM services WHERE id=?").bind(svcId).first<{ duration_min: number }>();
      const abbr = loc?.abbr; const dur = svc?.duration_min || 60;
      if (!abbr) return json({ days: [], tz: TZ });
      const pracs = ((await env.DB.prepare("SELECT id,services FROM practitioners WHERE clinics LIKE ?").bind("%" + abbr + "%").all<{ id: number; services: string }>()).results) || [];
      const staff = pracs.filter((p) => { const s = (p.services || "").split(",").map((x) => x.trim()).filter(Boolean); return !s.length || s.includes(String(svcId)); }).map((p) => p.id);
      if (!staff.length) return json({ days: [], tz: TZ });
      const ph = staff.map(() => "?").join(",");
      const wh = (((await env.DB.prepare(`SELECT practitioner_id,dow,start_time,end_time,date FROM working_hours WHERE practitioner_id IN (${ph})`).bind(...staff).all<any>()).results) || []);
      const dfmt = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
      const todayStr = dfmt.format(new Date());
      const base = new Date(todayStr + "T12:00:00Z");
      const DAYS = 31;
      const endStr = dfmt.format(new Date(base.getTime() + DAYS * 86400000));
      const appts = (((await env.DB.prepare(`SELECT staff_id,start_date,end_date FROM appointments WHERE staff_id IN (${ph}) AND start_date < ? AND end_date > ?`).bind(...staff, endStr + " 23:59:59", todayStr + " 00:00:00").all<any>()).results) || []);
      const toMin = (t: string) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
      const pad = (n: number) => String(n).padStart(2, "0");
      const days: any[] = [];
      for (let i = 0; i < DAYS; i++) {
        const ds = dfmt.format(new Date(base.getTime() + i * 86400000));
        const dow = ((new Date(ds + "T12:00:00Z").getUTCDay() + 6) % 7) + 1; // 1=Mon..7=Sun
        const anyFree: Record<string, boolean> = {}; const working: Record<string, boolean> = {};
        for (const sid of staff) {
          const ex = wh.filter((w) => w.practitioner_id === sid && w.date === ds);
          const blocks = ex.length ? ex : wh.filter((w) => w.practitioner_id === sid && !w.date && Number(w.dow) === dow);
          if (!blocks.length) continue;
          const sAppts = appts.filter((a) => a.staff_id === sid && (a.start_date || "").slice(0, 10) === ds).map((a) => ({ s: toMin((a.start_date || "").slice(11, 16)), e: toMin((a.end_date || "").slice(11, 16)) }));
          for (const b of blocks) {
            const ws = toMin(b.start_time), we = toMin(b.end_time);
            for (let t = ws; t + dur <= we; t += 30) {
              const k = String(t); working[k] = true;
              if (!sAppts.some((a) => a.s < t + dur && a.e > t)) anyFree[k] = true;
            }
          }
        }
        const times = Object.keys(working).map(Number).sort((a, b) => a - b);
        if (!times.length) continue;
        days.push({ date: ds, slots: times.map((t) => ({ t: pad(Math.floor(t / 60)) + ":" + pad(t % 60), s: anyFree[String(t)] ? "available" : "booked" })) });
      }
      return json({ days, tz: TZ, currency: env.SITE_CURRENCY === "AED" ? "AED" : "GBP" });
    }

    if (url.pathname === "/api/book" && request.method === "POST") {
      try {
        const b = (await request.json()) as any;
        const {
          service_id, staff_id, location_id, date, time,
          duration_min = 60, name, email, phone, notes = "",
        } = b;
        if (!service_id || !date || !time || !name || !email) {
          return json({ error: "missing fields" }, 400);
        }
        const start = `${date} ${time}:00`;
        const endMin = toMin(time) + Number(duration_min);
        const end = `${date} ${pad(Math.floor(endMin / 60))}:${pad(endMin % 60)}:00`;

        // Auto-assign: pick a random practitioner at this clinic who is free at this time.
        // (Admin can re-assign by drag-and-drop afterwards.)
        let assigned: number | null = staff_id ?? null;
        if (!assigned && location_id) {
          const loc = await env.DB.prepare("SELECT abbr FROM locations WHERE id=?").bind(location_id).first<{ abbr: string }>();
          if (loc?.abbr) {
            const cands = await env.DB.prepare("SELECT id, services FROM practitioners WHERE clinics LIKE ?").bind("%" + loc.abbr + "%").all<{ id: number; services: string }>();
            const busy = await env.DB.prepare(
              "SELECT staff_id FROM appointments WHERE staff_id IS NOT NULL AND start_date < ? AND end_date > ?",
            ).bind(end, start).all<{ staff_id: number }>();
            const busyIds = new Set((busy.results || []).map((r) => r.staff_id));
            // Only practitioners who offer this service (empty services list = can do all).
            const ids = (cands.results || [])
              .filter((r) => {
                const svc = (r.services || "").split(",").map((s) => s.trim()).filter(Boolean);
                return svc.length === 0 || svc.includes(String(service_id));
              })
              .map((r) => r.id);
            const free = ids.filter((id) => !busyIds.has(id));
            const pool = free.length ? free : ids;
            if (pool.length) assigned = pool[Math.floor(Math.random() * pool.length)];
          }
        }

        const cust = await env.DB.prepare(
          "INSERT INTO customers(full_name,phone,email) VALUES(?,?,?) RETURNING id",
        ).bind(name, phone ?? null, email).first<{ id: number }>();

        const appt = await env.DB.prepare(
          "INSERT INTO appointments(location_id,staff_id,service_id,start_date,end_date) VALUES(?,?,?,?,?) RETURNING id",
        ).bind(location_id ?? null, assigned, service_id, start, end)
          .first<{ id: number }>();

        await env.DB.prepare(
          "INSERT INTO customer_appointments(customer_id,appointment_id,status,notes) VALUES(?,?,?,?)",
        ).bind(cust!.id, appt!.id, "pending", notes).run();

        // Send confirmation (patient) + notification (assigned practitioner) in the background.
        ctx.waitUntil((async () => {
          try {
            const svc = await env.DB.prepare("SELECT title FROM services WHERE id=?").bind(service_id).first<{ title: string }>();
            const clinic = CLINIC_INFO[location_id as number] || { name: "AcuPro Clinic", addr: "", phone: "" };
            const serviceTitle = svc?.title || "Appointment";
            const jobs: Promise<void>[] = [
              sendMail(env, email, "Your AcuPro Clinic appointment", patientEmailHtml({ name, service: serviceTitle, date, time, note: notes, clinic })),
            ];
            if (assigned) {
              const d = await env.DB.prepare("SELECT email FROM practitioners WHERE id=?").bind(assigned).first<{ email: string }>();
              if (d?.email) jobs.push(sendMail(env, d.email, "New booking — " + name, doctorEmailHtml({ name, service: serviceTitle, note: notes, date, time, addr: clinic.addr })));
            }
            await Promise.all(jobs);
          } catch { /* ignore */ }
        })());

        return json({ ok: true, appointment_id: appt!.id });
      } catch (e: any) {
        return json({ error: String(e?.message ?? e) }, 500);
      }
    }

    // fall through to static assets (SPA)
    return env.ASSETS.fetch(request);
  },
};

const pad = (n: number) => String(n).padStart(2, "0");
const toMin = (t: string) => {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
};
