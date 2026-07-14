import { useEffect, useMemo, useState } from "react";
import { servicesByCategory, locations, CONTACT, type Service } from "../data";
import { slotsForDate, serviceIdsAtLocation } from "../lib/availability";

const STEPS = ["Clinic", "Service", "Date & time", "Your details"];
const locName = (id: number) => locations.find((l) => l.id === id)?.name ?? `Location ${id}`;

function nextDays(n: number): Date[] {
  const out: Date[] = [];
  const base = new Date();
  for (let i = 0; i < n; i++) {
    const d = new Date(base);
    d.setDate(base.getDate() + i);
    out.push(d);
  }
  return out;
}
const fmtDate = (d: Date) => d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
const isSameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
const nowHHMM = () => {
  const n = new Date();
  return `${String(n.getHours()).padStart(2, "0")}:${String(n.getMinutes()).padStart(2, "0")}`;
};

export default function Booking() {
  const [step, setStep] = useState(0);
  const [locationId, setLocationId] = useState<number | null>(null);
  const [service, setService] = useState<Service | null>(null);
  const [date, setDate] = useState<Date | null>(null);
  const [time, setTime] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ name: "", email: "", phone: "", notes: "" });
  const [d1svc, setD1svc] = useState<Map<number, { id: number; title: string; price: number; duration_min: number }> | null>(null);
  const [currency, setCurrency] = useState("GBP");

  // Live catalogue from the admin (D1): title, price, duration + which services are public.
  useEffect(() => {
    fetch("/api/services")
      .then((r) => r.json())
      .then((d: any) => {
        if (Array.isArray(d?.services)) {
          const m = new Map<number, any>();
          d.services.forEach((s: any) => m.set(Number(s.id), s));
          setD1svc(m);
        }
        if (d?.currency) setCurrency(d.currency);
      })
      .catch(() => {});
  }, []);

  const cur = (p: number) => (currency === "AED" ? `AED ${p}` : `£${p}`);

  const cats = useMemo(() => {
    let all = servicesByCategory();
    if (d1svc) {
      // keep only public services, and take title/price/duration from the admin catalogue
      all = all
        .map((c) => ({
          ...c,
          items: c.items.filter((s) => d1svc.has(s.id)).map((s) => {
            const o = d1svc.get(s.id)!;
            return { ...s, title: o.title, price: o.price, duration_min: o.duration_min };
          }),
        }))
        .filter((c) => c.items.length);
      // services that exist only in the admin (newly added) — show under a general category
      const known = new Set(all.flatMap((c) => c.items.map((i) => i.id)));
      const extras = [...d1svc.values()].filter((o) => !known.has(Number(o.id)));
      if (extras.length) {
        all = [...all, { id: -1, name: "Treatments", items: extras.map((o) => ({ id: Number(o.id), title: o.title, price: o.price, duration_min: o.duration_min, category_id: -1 })) }];
      }
    }
    if (locationId == null) return all;
    const ids = serviceIdsAtLocation(locationId);
    const filtered = all.map((c) => ({ ...c, items: c.items.filter((s) => ids.has(s.id) || s.category_id === -1) })).filter((c) => c.items.length);
    return filtered.length ? filtered : all;
  }, [locationId, d1svc]);

  const slots = useMemo(() => {
    if (!service || !date) return [];
    let list = slotsForDate(service, date, { locationId });
    if (isSameDay(date, new Date())) {
      const now = nowHHMM();
      list = list.filter((s) => s.time > now); // no past times today
    }
    return list;
  }, [service, date, locationId]);

  const go = (n: number) => setStep(n);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!service || !date || !time || !locationId) return;
    setSubmitting(true); setError(null);
    try {
      const res = await fetch("/api/book", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          service_id: service.id, location_id: locationId, staff_id: null,
          date: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`,
          time, duration_min: service.duration_min,
          name: form.name, email: form.email, phone: form.phone, notes: form.notes,
        }),
      });
      const data = (await res.json()) as any;
      if (!res.ok) throw new Error(data.error || "Booking failed");
      setDone(true);
    } catch (err: any) {
      setError(err?.message ?? "Something went wrong");
    } finally {
      setSubmitting(false);
    }
  }

  if (done) {
    return (
      <div className="card confirm-box" style={{ maxWidth: 620, margin: "0 auto" }}>
        <div className="tick">✓</div>
        <h2>Booking request received</h2>
        <p>
          Thank you — we've received your request for <strong>{service?.title}</strong> at{" "}
          <strong>{locationId && locName(locationId)}</strong> on <strong>{date && fmtDate(date)} at {time}</strong>.
          Our team will confirm by email &amp; WhatsApp shortly.
        </p>
        <a href="/" className="btn btn-primary" style={{ marginTop: 8 }}>Back to home</a>
      </div>
    );
  }

  return (
    <>
      <div className="steps">
        {STEPS.map((s, i) => (
          <div key={s} className={`step ${i === step ? "active" : ""} ${i < step ? "done" : ""}`}>{i < step ? "✓" : i + 1} {s}</div>
        ))}
      </div>

      <div className="booking-wrap">
        <div>
          {/* Step 0: Clinic */}
          {step === 0 && (
            <div>
              <div className="notice">Choose the clinic you'd like to visit.</div>
              <div className="pick">
                {locations.map((l) => {
                  const online = /video|online|global/i.test(l.name);
                  return (
                    <button key={l.id} className={`pick-item ${locationId === l.id ? "sel" : ""}`}
                      onClick={() => { setLocationId(l.id); setService(null); setDate(null); setTime(null); go(1); }}>
                      <span className="meta"><span className="name">{l.name}</span><span className="dur">{online ? "Online video consultation" : "In-person clinic"}</span></span>
                      <span>›</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Step 1: Service */}
          {step === 1 && locationId && (
            <div>
              <div className="notice">Select a treatment at <strong>{locName(locationId)}</strong>.</div>
              {cats.map((cat) => (
                <div className="svc-cat" key={cat.id}>
                  <h3>{cat.name}</h3>
                  <div className="pick">
                    {cat.items.map((s) => (
                      <button key={s.id} className={`pick-item ${service?.id === s.id ? "sel" : ""}`}
                        onClick={() => { setService(s); setDate(null); setTime(null); go(2); }}>
                        <span className="meta"><span className="name">{s.title}</span><span className="dur">{s.duration_min} min</span></span>
                        <span className="price">{s.price > 0 ? `from ${cur(s.price)}` : "Enquire"}</span>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
              <button className="btn btn-ghost" onClick={() => go(0)}>← Back</button>
            </div>
          )}

          {/* Step 2: Date + time */}
          {step === 2 && service && (
            <div>
              <h3 style={{ marginBottom: 12 }}>Pick a date</h3>
              <div className="date-row">
                {nextDays(14).map((d) => (
                  <button key={d.toISOString()} className={`date-chip ${date && isSameDay(date, d) ? "sel" : ""}`}
                    onClick={() => { setDate(d); setTime(null); }}>
                    <div className="dow">{d.toLocaleDateString("en-GB", { weekday: "short" })}</div>
                    <div className="dnum">{d.getDate()}</div>
                    <div className="dow">{d.toLocaleDateString("en-GB", { month: "short" })}</div>
                  </button>
                ))}
              </div>
              {date && (
                <>
                  <h3 style={{ margin: "24px 0 12px" }}>Available times — {fmtDate(date)}</h3>
                  {slots.length ? (
                    <div className="slot-grid">
                      {slots.map((sl) => (
                        <div key={sl.time} className={`slot ${time === sl.time ? "sel" : ""}`} onClick={() => setTime(sl.time)}>{sl.time}</div>
                      ))}
                    </div>
                  ) : (
                    <p className="muted">No available times on this day — please try another date.</p>
                  )}
                </>
              )}
              <div style={{ display: "flex", gap: 12, marginTop: 26 }}>
                <button className="btn btn-ghost" onClick={() => go(1)}>← Back</button>
                <button className="btn btn-primary" disabled={!time} onClick={() => go(3)}>Continue →</button>
              </div>
            </div>
          )}

          {/* Step 3: Details */}
          {step === 3 && (
            <form onSubmit={submit}>
              <div className="notice">Almost done — enter your details to request this appointment.</div>
              <div className="field"><label>Full name</label>
                <input required placeholder="Jane Smith" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
              <div className="grid grid-2">
                <div className="field"><label>Email</label>
                  <input type="email" required placeholder="jane@email.com" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></div>
                <div className="field"><label>Phone</label>
                  <input required placeholder="+44 ..." value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></div>
              </div>
              <div className="field"><label>Notes (optional)</label>
                <textarea rows={3} placeholder="Anything we should know?" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></div>
              {error && <div className="notice" style={{ borderColor: "var(--terra)", background: "#fbeee7", color: "var(--terra)" }}>{error}</div>}
              <div style={{ display: "flex", gap: 12, marginTop: 8 }}>
                <button type="button" className="btn btn-ghost" onClick={() => go(2)}>← Back</button>
                <button type="submit" className="btn btn-primary" disabled={submitting}>{submitting ? "Booking…" : "Confirm booking →"}</button>
              </div>
            </form>
          )}
        </div>

        <aside className="card summary">
          <h3 style={{ fontFamily: "var(--font-head)" }}>Your booking</h3>
          <div className="row"><span>Clinic</span><span>{locationId ? locName(locationId) : "—"}</span></div>
          <div className="row"><span>Service</span><span>{service?.title ?? "—"}</span></div>
          <div className="row"><span>Duration</span><span>{service ? `${service.duration_min} min` : "—"}</span></div>
          <div className="row"><span>Date</span><span>{date ? fmtDate(date) : "—"}</span></div>
          <div className="row"><span>Time</span><span>{time ?? "—"}</span></div>
          <div className="row" style={{ borderBottom: "none", marginTop: 6 }}>
            <span>Price</span>
            <span style={{ fontFamily: "var(--font-head)", fontSize: "1.3rem", color: "var(--pine)" }}>
              {service ? (service.price > 0 ? `from ${cur(service.price)}` : "On enquiry") : "—"}
            </span>
          </div>
          <p className="muted" style={{ marginTop: 14 }}>
            Need help? WhatsApp <a href={CONTACT.whatsappUrl} style={{ color: "var(--pine)", fontWeight: 600 }}>{CONTACT.whatsapp}</a>
          </p>
        </aside>
      </div>
    </>
  );
}
