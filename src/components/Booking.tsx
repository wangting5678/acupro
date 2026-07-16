import { useEffect, useMemo, useState } from "react";
import { servicesByCategory, locations, CONTACT, type Service } from "../data";
import { slotsForDate, serviceIdsAtLocation } from "../lib/availability";

const STEPS = ["Clinic", "Service", "Date & time", "Your details"];
const AR: Record<string, string> = {
  "Clinic": "العيادة", "Service": "الخدمة", "Date & time": "التاريخ والوقت", "Your details": "بياناتك",
  "Choose the clinic you'd like to visit.": "اختر العيادة التي ترغب بزيارتها.",
  "Select a treatment at": "اختر جلسة علاج في", "In-person clinic": "عيادة حضورية", "Online video consultation": "استشارة فيديو عبر الإنترنت",
  "Choose a time": "اختر وقتًا", "Available": "متاح", "Booked": "محجوز", "Unavailable": "غير متاح",
  "Loading availability…": "جارٍ تحميل المواعيد…", "No available times in the next 30 days — please contact us on WhatsApp.": "لا توجد مواعيد متاحة خلال الـ30 يومًا القادمة — يُرجى التواصل معنا عبر واتساب.",
  "London time": "بتوقيت لندن", "Gulf time": "بتوقيت الإمارات", "Next 30 days": "الأيام الـ30 القادمة",
  "← Back": "→ رجوع", "Continue →": "متابعة ←", "from": "من", "Enquire": "استفسر", "On enquiry": "عند الطلب", "min": "دقيقة",
  "Almost done — enter your details to request this appointment.": "أوشكت على الانتهاء — أدخل بياناتك لطلب هذا الموعد.",
  "Full name": "الاسم الكامل", "Email": "البريد الإلكتروني", "Phone": "الهاتف", "Notes (optional)": "ملاحظات (اختياري)",
  "Anything we should know?": "هل من شيء نودّ معرفته؟", "Confirm booking →": "تأكيد الحجز ←", "Booking…": "جارٍ الحجز…", "Something went wrong": "حدث خطأ ما",
  "Booking request received": "تم استلام طلب الحجز", "Back to home": "العودة للرئيسية",
  "Your booking": "حجزك", "Service": "الخدمة", "Duration": "المدة", "Date": "التاريخ", "Time": "الوقت", "Price": "السعر",
  "Need help? WhatsApp": "بحاجة لمساعدة؟ واتساب",
};

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
const toMinLocal = (t: string) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
// "now" in the clinic's timezone (UK bookings are London time even if the visitor is elsewhere)
const clinicNow = (tz: string) => {
  try {
    const p = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date());
    const g = (t: string) => (p.find((x) => x.type === t) || { value: "0" }).value;
    return { date: `${g("year")}-${g("month")}-${g("day")}`, min: (+g("hour")) * 60 + (+g("minute")) };
  } catch { const n = new Date(); return { date: "", min: n.getHours() * 60 + n.getMinutes() }; }
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
  const [avail, setAvail] = useState<{ days: { date: string; slots: { t: string; s: string }[] }[]; tz: string } | null>(null);
  const [locs, setLocs] = useState<{ id: number; name: string }[]>(locations as any);
  const locName = (id: number) => locs.find((l) => l.id === id)?.name ?? `Location ${id}`;

  // Clinics for this site's region (UK shows London + online; UAE shows Abu Dhabi).
  useEffect(() => {
    fetch("/api/locations").then((r) => r.json()).then((d: any) => { if (Array.isArray(d?.locations) && d.locations.length) setLocs(d.locations); }).catch(() => {});
  }, []);

  // Language (EN/AR) — driven by the header toggle via the "acupro-lang" event.
  const [lang, setLang] = useState<string>(() => { try { return localStorage.getItem("acupro_lang") || "en"; } catch { return "en"; } });
  useEffect(() => {
    const h = (e: any) => setLang(e.detail || "en");
    window.addEventListener("acupro-lang", h as any);
    return () => window.removeEventListener("acupro-lang", h as any);
  }, []);
  const t = (s: string) => (lang === "ar" ? (AR[s] || s) : s);
  const tzLabel = (tz: string) => (tz === "Asia/Dubai" ? t("Gulf time") : t("London time"));

  // Live availability from D1 (working hours minus existing appointments) once clinic + service are chosen.
  useEffect(() => {
    if (!service || !locationId) { setAvail(null); return; }
    setAvail(null);
    fetch(`/api/availability?location_id=${locationId}&service_id=${service.id}`)
      .then((r) => r.json())
      .then((d: any) => { if (d && Array.isArray(d.days)) setAvail({ days: d.days, tz: d.tz || "Europe/London" }); })
      .catch(() => {});
  }, [service, locationId]);

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
            return { ...s, title: o.title, price: o.price, duration_min: o.duration_min, description: o.description || "" };
          }),
        }))
        .filter((c) => c.items.length);
      // services that exist only in the admin (newly added) — show under a general category
      const known = new Set(all.flatMap((c) => c.items.map((i) => i.id)));
      const extras = [...d1svc.values()].filter((o) => !known.has(Number(o.id)));
      if (extras.length) {
        all = [...all, { id: -1, name: "Treatments", items: extras.map((o) => ({ id: Number(o.id), title: o.title, price: o.price, duration_min: o.duration_min, category_id: -1, description: o.description || "" })) }];
      }
    }
    if (locationId == null) return all;
    const ids = serviceIdsAtLocation(locationId);
    const filtered = all.map((c) => ({ ...c, items: c.items.filter((s) => ids.has(s.id) || s.category_id === -1) })).filter((c) => c.items.length);
    return filtered.length ? filtered : all;
  }, [locationId, d1svc]);

  // Multi-day grid derived from live availability. Each slot is one of three states:
  // available (bookable) · booked (all practitioners taken) · past (before now, or within the next hour).
  const days = useMemo(() => {
    if (!avail) return [];
    const now = clinicNow(avail.tz || "Europe/London");
    // Keep today (until midnight) even if every slot is already past — just show them greyed.
    return avail.days.map((d) => ({
      date: new Date(d.date + "T00:00:00"),
      slots: d.slots.map((sl) => {
        const past = d.date < now.date || (d.date === now.date && toMinLocal(sl.t) <= now.min + 60);
        return { time: sl.t, state: past ? "past" : (sl.s === "booked" ? "booked" : "available") };
      }),
    }));
  }, [avail]);

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
        <h2>{t("Booking request received")}</h2>
        <p>
          Thank you — we've received your request for <strong>{service?.title}</strong> at{" "}
          <strong>{locationId && locName(locationId)}</strong> on <strong>{date && fmtDate(date)} at {time}</strong>.
          Our team will confirm by email &amp; WhatsApp shortly.
        </p>
        <a href="/" className="btn btn-primary" style={{ marginTop: 8 }}>{t("Back to home")}</a>
      </div>
    );
  }

  return (
    <>
      <div className="steps">
        {STEPS.map((s, i) => (
          <div key={s} className={`step ${i === step ? "active" : ""} ${i < step ? "done" : ""}`}>{i < step ? "✓" : i + 1} {t(s)}</div>
        ))}
      </div>

      <div className="booking-wrap">
        <div style={{ minWidth: 0 }}>
          {/* Step 0: Clinic */}
          {step === 0 && (
            <div>
              <div className="notice">{t("Choose the clinic you'd like to visit.")}</div>
              <div className="pick">
                {locs.map((l) => {
                  const online = /video|online|global/i.test(l.name);
                  return (
                    <button key={l.id} className={`pick-item ${locationId === l.id ? "sel" : ""}`}
                      onClick={() => { setLocationId(l.id); setService(null); setDate(null); setTime(null); go(1); }}>
                      <span className="meta"><span className="name">{l.name}</span><span className="dur">{online ? t("Online video consultation") : t("In-person clinic")}</span></span>
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
              <div className="notice">{t("Select a treatment at")} <strong>{locName(locationId)}</strong>.</div>
              {cats.map((cat) => (
                <div className="svc-cat" key={cat.id}>
                  <h3>{cat.name}</h3>
                  <div className="pick">
                    {cat.items.map((s) => (
                      <button key={s.id} className={`pick-item ${service?.id === s.id ? "sel" : ""}`}
                        data-info={(s as any).description || undefined}
                        onClick={() => { setService(s); setDate(null); setTime(null); go(2); }}>
                        <span className="meta"><span className="name">{s.title}</span><span className="dur">{s.duration_min} {t("min")}</span></span>
                        <span className="price">{s.price > 0 ? `${t("from")} ${cur(s.price)}` : t("Enquire")}</span>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
              <button className="btn btn-ghost" onClick={() => go(0)}>{t("← Back")}</button>
            </div>
          )}

          {/* Step 2: Date + time — compact multi-day grid, live from D1 */}
          {step === 2 && service && (
            <div>
              <h3 style={{ marginBottom: 4 }}>{t("Choose a time")}</h3>
              <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "center", margin: "0 0 12px", fontSize: ".8rem", color: "var(--ink-soft, #7a7266)" }}>
                <span>{t("Next 30 days")} · {tzLabel(avail?.tz || "Europe/London")}</span>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}><i style={{ width: 12, height: 12, borderRadius: 3, border: "1px solid var(--line,#e5ddcf)", background: "#fff", display: "inline-block" }} /> {t("Available")}</span>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}><i style={{ width: 12, height: 12, borderRadius: 3, background: "#ded6c6", display: "inline-block" }} /> {t("Booked")}</span>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}><i style={{ width: 12, height: 12, borderRadius: 3, background: "#f2ede3", display: "inline-block" }} /> {t("Unavailable")}</span>
              </div>
              {avail === null ? (
                <p className="muted">{t("Loading availability…")}</p>
              ) : days.length ? (
                <div style={{ display: "flex", gap: 8, overflowX: "auto", paddingBottom: 8 }}>
                  {days.map(({ date: d, slots }) => (
                    <div key={d.toISOString()} style={{ minWidth: 104, flex: "0 0 104px" }}>
                      <div style={{ background: "var(--pine)", color: "#fff", fontWeight: 700, fontSize: ".78rem", textAlign: "center", padding: "7px 4px", borderRadius: "9px 9px 0 0" }}>
                        {d.toLocaleDateString("en-GB", { weekday: "short" })}, {d.toLocaleDateString("en-GB", { month: "short", day: "numeric" })}
                      </div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 5, padding: 6, border: "1px solid var(--line, #e5ddcf)", borderTop: "none", borderRadius: "0 0 9px 9px" }}>
                        {slots.map((sl) => {
                          if (sl.state === "past") return <div key={sl.time} className="bslot bslot--past">{sl.time}</div>;
                          if (sl.state === "booked") return <div key={sl.time} className="bslot bslot--booked" title="Fully booked">{sl.time}</div>;
                          const sel = !!date && isSameDay(date, d) && time === sl.time;
                          return (
                            <button key={sl.time} className={`bslot bslot--avail ${sel ? "sel" : ""}`} onClick={() => { setDate(d); setTime(sl.time); }}>{sl.time}</button>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="muted">{t("No available times in the next 30 days — please contact us on WhatsApp.")}</p>
              )}
              <div style={{ display: "flex", gap: 12, marginTop: 20 }}>
                <button className="btn btn-ghost" onClick={() => go(1)}>{t("← Back")}</button>
                <button className="btn btn-primary" disabled={!time} onClick={() => go(3)}>{t("Continue →")}</button>
              </div>
            </div>
          )}

          {/* Step 3: Details */}
          {step === 3 && (
            <form onSubmit={submit}>
              <div className="notice">{t("Almost done — enter your details to request this appointment.")}</div>
              <div className="field"><label>{t("Full name")}</label>
                <input required placeholder="Jane Smith" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
              <div className="grid grid-2">
                <div className="field"><label>{t("Email")}</label>
                  <input type="email" required placeholder="jane@email.com" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></div>
                <div className="field"><label>{t("Phone")}</label>
                  <input required placeholder="+44 ..." value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></div>
              </div>
              <div className="field"><label>{t("Notes (optional)")}</label>
                <textarea rows={3} placeholder={t("Anything we should know?")} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></div>
              {error && <div className="notice" style={{ borderColor: "var(--terra)", background: "#fbeee7", color: "var(--terra)" }}>{error}</div>}
              <div style={{ display: "flex", gap: 12, marginTop: 8 }}>
                <button type="button" className="btn btn-ghost" onClick={() => go(2)}>{t("← Back")}</button>
                <button type="submit" className="btn btn-primary" disabled={submitting}>{submitting ? t("Booking…") : t("Confirm booking →")}</button>
              </div>
            </form>
          )}
        </div>

        <aside className="card summary">
          <h3 style={{ fontFamily: "var(--font-head)" }}>{t("Your booking")}</h3>
          <div className="row"><span>{t("Clinic")}</span><span>{locationId ? locName(locationId) : "—"}</span></div>
          <div className="row"><span>{t("Service")}</span><span>{service?.title ?? "—"}</span></div>
          <div className="row"><span>{t("Duration")}</span><span>{service ? `${service.duration_min} ${t("min")}` : "—"}</span></div>
          <div className="row"><span>{t("Date")}</span><span>{date ? fmtDate(date) : "—"}</span></div>
          <div className="row"><span>{t("Time")}</span><span>{time ?? "—"}</span></div>
          <div className="row" style={{ borderBottom: "none", marginTop: 6 }}>
            <span>{t("Price")}</span>
            <span style={{ fontFamily: "var(--font-head)", fontSize: "1.3rem", color: "var(--pine)" }}>
              {service ? (service.price > 0 ? `${t("from")} ${cur(service.price)}` : t("On enquiry")) : "—"}
            </span>
          </div>
          <p className="muted" style={{ marginTop: 14 }}>
            {t("Need help? WhatsApp")} <a href={CONTACT.whatsappUrl} style={{ color: "var(--pine)", fontWeight: 600 }}>{CONTACT.whatsapp}</a>
          </p>
        </aside>
      </div>
    </>
  );
}
