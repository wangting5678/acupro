import { useMemo, useState } from "react";
import {
  servicesByCategory, locations, staff, CONTACT, type Service,
} from "../data";
import { locationsForService, staffForService, slotsForDate } from "../lib/availability";

const STEPS = ["Service", "Location", "Date & time", "Your details"];
const staffName = (id: number) => staff.find((s) => s.id === id)?.name ?? `Practitioner ${id}`;
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
const fmtDate = (d: Date) =>
  d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });

export default function Booking() {
  const [step, setStep] = useState(0);
  const [service, setService] = useState<Service | null>(null);
  const [locationId, setLocationId] = useState<number | null>(null);
  const [staffId, setStaffId] = useState<number | null>(null);
  const [date, setDate] = useState<Date | null>(null);
  const [time, setTime] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ name: "", email: "", phone: "", notes: "" });

  const cats = servicesByCategory();
  const serviceLocations = useMemo(() => (service ? locationsForService(service.id) : []), [service]);
  const serviceStaff = useMemo(() => (service ? staffForService(service.id, locationId) : []), [service, locationId]);
  const slots = useMemo(
    () => (service && date ? slotsForDate(service, date, { locationId, staffId }) : []),
    [service, date, locationId, staffId],
  );
  const go = (n: number) => setStep(n);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!service || !date || !time) return;
    setSubmitting(true); setError(null);
    try {
      const res = await fetch("/api/book", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          service_id: service.id, staff_id: staffId, location_id: locationId,
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
          Thank you — we've received your request for <strong>{service?.title}</strong> on{" "}
          <strong>{date && fmtDate(date)} at {time}</strong>. Our team will confirm by email &amp; WhatsApp shortly.
        </p>
        <p className="muted">A member of our team will confirm shortly. Reference kept on file.</p>
        <a href="/" className="btn btn-primary" style={{ marginTop: 8 }}>Back to home</a>
      </div>
    );
  }

  return (
    <>
      <div className="steps">
        {STEPS.map((s, i) => (
          <div key={s} className={`step ${i === step ? "active" : ""} ${i < step ? "done" : ""}`}>
            {i < step ? "✓" : i + 1} {s}
          </div>
        ))}
      </div>

      <div className="booking-wrap">
        <div>
          {step === 0 && (
            <div>
              {cats.map((cat) => (
                <div className="svc-cat" key={cat.id}>
                  <h3>{cat.name}</h3>
                  <div className="pick">
                    {cat.items.map((s) => (
                      <button key={s.id} className={`pick-item ${service?.id === s.id ? "sel" : ""}`}
                        onClick={() => { setService(s); setLocationId(null); setStaffId(null); setDate(null); setTime(null); go(1); }}>
                        <span className="meta"><span className="name">{s.title}</span><span className="dur">{s.duration_min} min</span></span>
                        <span className="price">{s.price > 0 ? `£${s.price}` : "Enquire"}</span>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}

          {step === 1 && service && (
            <div>
              <div className="notice">Choose a clinic and practitioner for <strong>{service.title}</strong>.</div>
              <h3 style={{ marginBottom: 12 }}>Clinic</h3>
              <div className="pick" style={{ marginBottom: 26 }}>
                {(serviceLocations.length ? serviceLocations : locations.map((l) => l.id)).map((lid) => (
                  <button key={lid} className={`pick-item ${locationId === lid ? "sel" : ""}`} onClick={() => { setLocationId(lid); setStaffId(null); }}>
                    <span className="name">{locName(lid)}</span><span>›</span>
                  </button>
                ))}
              </div>
              <h3 style={{ marginBottom: 12 }}>Practitioner</h3>
              <div className="pick">
                <button className={`pick-item ${staffId === null ? "sel" : ""}`} onClick={() => setStaffId(null)}>
                  <span className="name">Any available practitioner</span><span>›</span>
                </button>
                {serviceStaff.slice(0, 8).map((sid) => (
                  <button key={sid} className={`pick-item ${staffId === sid ? "sel" : ""}`} onClick={() => setStaffId(sid)}>
                    <span className="name">{staffName(sid)}</span><span>›</span>
                  </button>
                ))}
              </div>
              <div style={{ display: "flex", gap: 12, marginTop: 26 }}>
                <button className="btn btn-ghost" onClick={() => go(0)}>← Back</button>
                <button className="btn btn-primary" disabled={!locationId} onClick={() => go(2)}>Continue →</button>
              </div>
            </div>
          )}

          {step === 2 && service && (
            <div>
              <h3 style={{ marginBottom: 12 }}>Pick a date</h3>
              <div className="date-row">
                {nextDays(14).map((d) => (
                  <button key={d.toISOString()} className={`date-chip ${date?.toDateString() === d.toDateString() ? "sel" : ""}`}
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
                    <p className="muted">No availability on this day for the current selection — try another date or practitioner.</p>
                  )}
                </>
              )}
              <div style={{ display: "flex", gap: 12, marginTop: 26 }}>
                <button className="btn btn-ghost" onClick={() => go(1)}>← Back</button>
                <button className="btn btn-primary" disabled={!time} onClick={() => go(3)}>Continue →</button>
              </div>
            </div>
          )}

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
          <div className="row"><span>Service</span><span>{service?.title ?? "—"}</span></div>
          <div className="row"><span>Duration</span><span>{service ? `${service.duration_min} min` : "—"}</span></div>
          <div className="row"><span>Clinic</span><span>{locationId ? locName(locationId) : "—"}</span></div>
          <div className="row"><span>Practitioner</span><span>{staffId ? staffName(staffId) : service ? "Any available" : "—"}</span></div>
          <div className="row"><span>Date</span><span>{date ? fmtDate(date) : "—"}</span></div>
          <div className="row"><span>Time</span><span>{time ?? "—"}</span></div>
          <div className="row" style={{ borderBottom: "none", marginTop: 6 }}>
            <span>Price</span>
            <span style={{ fontFamily: "var(--font-head)", fontSize: "1.3rem", color: "var(--pine)" }}>
              {service ? (service.price > 0 ? `£${service.price}` : "On enquiry") : "—"}
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
