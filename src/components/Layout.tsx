import { Link, useLocation } from "react-router-dom";
import { CONTACT } from "../data";

export function Layout({ children }: { children: React.ReactNode }) {
  const { pathname } = useLocation();
  return (
    <>
      <header className="site-header">
        <div className="container nav">
          <Link to="/" className="brand">
            <span className="brand-mark">针</span>
            AcuPro Clinic
          </Link>
          <nav className="nav-links">
            <a href="/#services">Services</a>
            <a href="/#team">Our Team</a>
            <a href="/#clinics">Clinics</a>
            <a href="/#pricing">Pricing</a>
          </nav>
          <div className="nav-cta">
            <span className="region-pill">🇬🇧 UK</span>
            {pathname !== "/book" && (
              <Link to="/book" className="btn btn-primary">Book Now</Link>
            )}
          </div>
        </div>
      </header>

      <main>{children}</main>

      <footer className="site-footer">
        <div className="container">
          <div className="footer-grid">
            <div>
              <div className="brand" style={{ color: "#fff", marginBottom: 14 }}>
                <span className="brand-mark">针</span> AcuPro Clinic
              </div>
              <p style={{ color: "rgba(255,255,255,0.7)", maxWidth: "34ch" }}>
                Award-winning acupuncture &amp; Traditional Chinese Medicine in the
                heart of London — since 2013.
              </p>
            </div>
            <div>
              <h4>Contact</h4>
              <a href={`mailto:${CONTACT.email}`}>{CONTACT.email}</a>
              <a href={CONTACT.whatsappUrl}>WhatsApp {CONTACT.whatsapp}</a>
              <a href={`tel:${CONTACT.phone}`}>{CONTACT.phone}</a>
            </div>
            <div>
              <h4>Clinics</h4>
              <a href="/#clinics">London Victoria</a>
              <a href="/#clinics">City of London</a>
              <a href="/#clinics">Online Video Consultation</a>
            </div>
          </div>
          <div className="footer-bottom">
            <span>© {new Date().getFullYear()} AcuPro Clinic. All rights reserved.</span>
            <span>UK · United Arab Emirates · Global Online</span>
          </div>
        </div>
      </footer>
    </>
  );
}
