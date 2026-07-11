/// <reference types="@cloudflare/workers-types" />

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

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

        const cust = await env.DB.prepare(
          "INSERT INTO customers(full_name,phone,email) VALUES(?,?,?) RETURNING id",
        ).bind(name, phone ?? null, email).first<{ id: number }>();

        const appt = await env.DB.prepare(
          "INSERT INTO appointments(location_id,staff_id,service_id,start_date,end_date) VALUES(?,?,?,?,?) RETURNING id",
        ).bind(location_id ?? null, staff_id ?? null, service_id, start, end)
          .first<{ id: number }>();

        await env.DB.prepare(
          "INSERT INTO customer_appointments(customer_id,appointment_id,status,notes) VALUES(?,?,?,?)",
        ).bind(cust!.id, appt!.id, "pending", notes).run();

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
