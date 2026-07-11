import { Link } from "react-router-dom";
import { servicesByCategory, team, clinics, CONTACT } from "../data";

const initials = (name: string) =>
  name.replace(/^(Dr|Mr|Ms|Mrs|Miss)\.?\s+/i, "").split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase();

export function Home() {
  const cats = servicesByCategory();
  return (
    <>
      {/* Hero */}
      <section className="hero">
        <div className="container hero-inner">
          <div>
            <div className="eyebrow">Traditional Chinese Medicine · London</div>
            <h1>Balance, restored — the AcuPro way.</h1>
            <p className="lead">
              Award-winning acupuncture, herbal medicine and wellness care from
              experienced TCM practitioners. Trusted by thousands across London.
            </p>
            <div className="badges">
              <span className="badge">✔ 5,500+ patients cared for</span>
              <span className="badge">✔ Since 2013</span>
              <span className="badge">✔ 3 ways to visit</span>
            </div>
            <div className="hero-cta">
              <Link to="/book" className="btn btn-primary">Book an appointment →</Link>
              <a href={CONTACT.whatsappUrl} className="btn btn-ghost">Free 15-min enquiry</a>
            </div>
          </div>
          <div className="hero-visual">
            <span className="glyph">道</span>
            <div className="stat-card">
              <strong>25,000+</strong>
              <span>appointments delivered at our London clinics</span>
            </div>
          </div>
        </div>
      </section>

      {/* Trust bar */}
      <section className="trust">
        <div className="container trust-inner">
          <div className="trust-item"><strong>2</strong><span>London clinics + online</span></div>
          <div className="trust-item"><strong>16</strong><span>expert practitioners</span></div>
          <div className="trust-item"><strong>15+</strong><span>treatments &amp; therapies</span></div>
          <div className="trust-item"><strong>10 yrs</strong><span>caring for London</span></div>
        </div>
      </section>

      {/* Services */}
      <section className="section" id="services">
        <div className="container">
          <div className="center" style={{ marginBottom: 44 }}>
            <div className="eyebrow">What we offer</div>
            <h2>Treatments &amp; pricing</h2>
            <p className="lead center">
              From acupuncture and herbal medicine to sports massage and aesthetic
              wellness — every session tailored to you.
            </p>
          </div>
          <div id="pricing">
            {cats.map((cat) => (
              <div className="svc-cat" key={cat.id}>
                <h3>{cat.name}</h3>
                <div className="svc-list">
                  {cat.items.map((s) => (
                    <div className="svc-row" key={s.id}>
                      <div className="meta">
                        <span className="name">{s.title}</span>
                        <span className="dur">{s.duration_min} min</span>
                      </div>
                      <div className="price">
                        {s.price > 0 ? <>£{s.price}</> : <small>Enquire</small>}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <div className="center">
            <Link to="/book" className="btn btn-primary">Book a treatment →</Link>
          </div>
        </div>
      </section>

      {/* Team */}
      <section className="section" id="team" style={{ background: "#fff", borderBlock: "1px solid var(--line)" }}>
        <div className="container">
          <div className="center" style={{ marginBottom: 44 }}>
            <div className="eyebrow">Meet the practitioners</div>
            <h2>Our team</h2>
          </div>
          <div className="grid grid-3">
            {team.slice(0, 6).map((m) => (
              <div className="card team-card" key={m.id}>
                <div className="team-avatar">{initials(m.name)}</div>
                <h3 style={{ fontFamily: "var(--font-head)" }}>{m.name}</h3>
                <div className="role">{m.specialisation || m.type || "TCM Practitioner"}</div>
                {m.slogan && <p style={{ marginTop: 10, fontSize: "0.92rem" }}>{m.slogan}</p>}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Clinics */}
      <section className="section" id="clinics">
        <div className="container">
          <div className="center" style={{ marginBottom: 44 }}>
            <div className="eyebrow">Where to find us</div>
            <h2>Our clinics</h2>
          </div>
          <div className="grid grid-3">
            {clinics.map((c) => {
              const online = /video|online/i.test(c.name);
              return (
                <div className="card clinic-card" key={c.id}>
                  <span className="tag">{online ? "Online" : "In person"}</span>
                  <h3>{c.name}</h3>
                  <p className="addr">
                    {c.address}
                    {c.postcode ? <>, {c.postcode}</> : null}
                  </p>
                  {c.telephone && (
                    <p style={{ margin: 0 }}>
                      <a href={`tel:${c.telephone}`} style={{ color: "var(--pine)", fontWeight: 600 }}>
                        {c.telephone}
                      </a>
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="section">
        <div className="container">
          <div className="cta-band">
            <h2>Ready to feel better?</h2>
            <p className="lead center" style={{ color: "rgba(255,255,255,0.8)" }}>
              Book online in under two minutes, or send us a message on WhatsApp.
            </p>
            <div className="hero-cta" style={{ justifyContent: "center", marginTop: 18 }}>
              <Link to="/book" className="btn btn-gold">Book now →</Link>
              <a href={CONTACT.whatsappUrl} className="btn btn-ghost" style={{ color: "#fff", borderColor: "rgba(255,255,255,0.4)" }}>
                WhatsApp us
              </a>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
