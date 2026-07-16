import { useEffect, useState } from "react";

type Info = { name: string; service: string; date: string; time: string; clinic: string; addr: string };

const fmtDate = (ds: string) => {
  const d = new Date(ds + "T00:00:00");
  return isNaN(d.getTime()) ? ds : d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
};

export default function Cancel() {
  const [state, setState] = useState<"loading" | "found" | "notfound" | "cancelling" | "done" | "error">("loading");
  const [info, setInfo] = useState<Info | null>(null);
  const [token, setToken] = useState("");

  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get("t") || "";
    setToken(t);
    if (!t) { setState("notfound"); return; }
    fetch("/api/booking?t=" + encodeURIComponent(t))
      .then((r) => r.json())
      .then((d: any) => { if (d && d.found) { setInfo(d); setState("found"); } else setState("notfound"); })
      .catch(() => setState("error"));
  }, []);

  async function doCancel() {
    setState("cancelling");
    try {
      const r = await fetch("/api/cancel", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ t: token }) });
      const d = (await r.json()) as any;
      setState(d && d.ok ? "done" : "notfound");
    } catch { setState("error"); }
  }

  if (state === "loading") return <div className="card" style={{ maxWidth: 560, margin: "0 auto" }}><p className="muted">Loading your appointment…</p></div>;

  if (state === "notfound") return (
    <div className="card" style={{ maxWidth: 560, margin: "0 auto" }}>
      <h2 style={{ fontFamily: "var(--font-head)" }}>Appointment not found</h2>
      <p>This link is invalid, or the appointment has already been cancelled. If you need help, contact us on WhatsApp or by phone.</p>
      <a href="/" className="btn btn-primary" style={{ marginTop: 8 }}>Back to home</a>
    </div>
  );

  if (state === "error") return (
    <div className="card" style={{ maxWidth: 560, margin: "0 auto" }}>
      <h2 style={{ fontFamily: "var(--font-head)" }}>Something went wrong</h2>
      <p>Please try again, or contact the clinic to cancel.</p>
    </div>
  );

  if (state === "done") return (
    <div className="card confirm-box" style={{ maxWidth: 560, margin: "0 auto" }}>
      <div className="tick">✓</div>
      <h2>Appointment cancelled</h2>
      <p>Your appointment has been cancelled and a confirmation email is on its way. We hope to see you another time.</p>
      <a href="/book" className="btn btn-primary" style={{ marginTop: 8 }}>Book a new appointment</a>
    </div>
  );

  // found (or cancelling)
  return (
    <div className="card" style={{ maxWidth: 560, margin: "0 auto" }}>
      <h2 style={{ fontFamily: "var(--font-head)", marginTop: 0 }}>Your appointment</h2>
      {info && (
        <div style={{ margin: "10px 0 20px" }}>
          <div className="row" style={{ display: "flex", justifyContent: "space-between", padding: "10px 0", borderBottom: "1px dashed var(--line)" }}><span className="muted">Name</span><strong>{info.name}</strong></div>
          <div className="row" style={{ display: "flex", justifyContent: "space-between", padding: "10px 0", borderBottom: "1px dashed var(--line)" }}><span className="muted">Treatment</span><strong>{info.service}</strong></div>
          <div className="row" style={{ display: "flex", justifyContent: "space-between", padding: "10px 0", borderBottom: "1px dashed var(--line)" }}><span className="muted">When</span><strong style={{ textAlign: "right" }}>{fmtDate(info.date)}<br />{info.time}</strong></div>
          <div className="row" style={{ display: "flex", justifyContent: "space-between", padding: "10px 0" }}><span className="muted">Clinic</span><strong style={{ textAlign: "right" }}>{info.clinic}</strong></div>
        </div>
      )}
      <p className="muted" style={{ fontSize: ".88rem" }}>Cancellations are free up to 24 hours before your appointment. To reschedule, cancel here and book a new time.</p>
      <div style={{ display: "flex", gap: 12, marginTop: 12, flexWrap: "wrap" }}>
        <button className="btn btn-primary" style={{ background: "var(--terra, #b0553a)", borderColor: "var(--terra, #b0553a)" }} disabled={state === "cancelling"} onClick={doCancel}>
          {state === "cancelling" ? "Cancelling…" : "Cancel this appointment"}
        </button>
        <a href="/book" className="btn btn-ghost">Book a different time</a>
      </div>
    </div>
  );
}
