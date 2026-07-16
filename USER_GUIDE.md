# AcuPro Clinic — Staff User Guide

A short guide to running day-to-day bookings. No technical knowledge needed.

---

## 1. The websites

| Site | Address | What it's for |
| --- | --- | --- |
| **Admin** (staff) | https://acupro-admin.jinzhiqi19860716.workers.dev | Where you manage all bookings |
| UK site (patients) | https://acupro-uk.jinzhiqi19860716.workers.dev | London patients book online (prices in £) |
| UAE site (patients) | https://acupro-uae.jinzhiqi19860716.workers.dev | Abu Dhabi patients book online (prices in AED, English / العربية) |
| Portal | https://acuproclinic-redesign.jinzhiqi19860716.workers.dev | Landing page that points visitors to UK / UAE / Online |

**Admin login password:** `acupro2026`

> Tip: after we release an update, press **Cmd/Ctrl + Shift + R** once to make sure you're seeing the latest version.

---

## 2. Managing bookings (Admin → Bookings)

Three views, switch with the **Week / Day / Month** buttons:

- **Month** — the whole month at a glance, with how many bookings each day has. Click a day to open it.
- **Week** — the seven days, with each day's bookings listed.
- **Day** — the detailed view: one column per practitioner, time down the side. This is where you do most of the work.

**Location filter** (top of the view): show only Victoria, only City, only Abu Dhabi, etc., or "All locations".

### In the Day view you can:

- **See every appointment** as a coloured block (colour = the treatment; a legend shows underneath). The shaded background is each practitioner's working hours.
- **Create a booking** — click any empty space in a practitioner's column (it shows the time), or use **+ New booking**. You can book past times too (for back-filling records).
  - If the patient already exists, type their name / phone / email in **Find existing customer** and pick them.
  - Tick **"Send this note in the confirmation email"** if you want your note to reach the patient & practitioner.
- **Move an appointment** — drag a block to another practitioner and/or time. A confirmation pops up before it saves.
- **Edit / cancel** — click an appointment to change the time, service, practitioner, notes, or to **Delete** it.
- **Team notes** — the "📌 Team notes" box at the top of each day is a shared message board. Leave notes for colleagues (e.g. "Room 3 unavailable after 5pm"). Everyone sees them.

---

## 3. Practitioners (Admin → Practitioners)

- **Add / remove** practitioners.
- Click the **clinic chips** (VCT / CITY / ONLINE / AUH) to set where each one works.
- Enter each practitioner's **email** — booking notifications go there.
- **🕑 Hours** — set each practitioner's weekly working hours. This drives what times patients can book.
- **Services** — tick which treatments each practitioner offers (used to auto-assign the right person).
- **Click a practitioner's photo** — edit their **photo** and **bio** (the bio shows on the website's Team page).

---

## 4. Services & prices (Admin → Services)

- Two separate catalogues — switch with **UK (£)** and **UAE (AED)** at the top. Each has its own treatments and prices.
- For each service: set a **colour** (used on the calendar), **price**, **duration**.
- **Visibility** — 🌐 Public shows it on the patient booking page; 🔒 Private is admin-only (you can still book it, patients can't see it).
- **Click a service name** to edit its name and its **Information** (the description patients see when they hover it).

---

## 5. How patients book (and cancel)

1. Patient picks **Clinic → Service → Time → details** and confirms. No login needed.
2. They can only book **available** future times (the grid shows Available / Booked / Unavailable, in the clinic's local time).
3. Everyone gets an **email**: the patient a confirmation, the assigned practitioner a heads-up. Same when you reschedule.
4. The patient's confirmation email has a **"View or cancel my appointment"** button — they can cancel themselves, which frees the slot and notifies the practitioner. To reschedule, they cancel and book again.

---

## 6. Emails

- Sent automatically for new bookings, reschedules, and cancellations — to both patient and practitioner.
- Sender is **bookings@acuproclinic.uk**. (Free tier: up to 100 emails/day, 3,000/month — plenty.)
- Practitioner notifications go to the email set on their profile in the Practitioners page.

---

## Need a change?

Anything you'd like added or adjusted — new service, different email wording, a report, etc. — just let the tech team know.
