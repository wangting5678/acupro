-- AcuPro booking schema (D1 / SQLite) — aligned to Bookly core tables
DROP TABLE IF EXISTS customer_appointments;
DROP TABLE IF EXISTS appointments;
DROP TABLE IF EXISTS customers;
DROP TABLE IF EXISTS staff_schedule_items;
DROP TABLE IF EXISTS staff_services;
DROP TABLE IF EXISTS staff;
DROP TABLE IF EXISTS services;
DROP TABLE IF EXISTS locations;

CREATE TABLE locations (
  id      INTEGER PRIMARY KEY,
  name    TEXT NOT NULL,
  info    TEXT,
  abbr    TEXT              -- clinic short code shown as a badge (VCT / CITY / ONLINE)
);

CREATE TABLE services (
  id           INTEGER PRIMARY KEY,
  category_id  INTEGER,
  title        TEXT NOT NULL,
  price        REAL DEFAULT 0,
  duration_min INTEGER DEFAULT 60
);

CREATE TABLE staff (
  id    INTEGER PRIMARY KEY,
  name  TEXT NOT NULL,
  photo TEXT               -- practitioner photo path, e.g. /staff/3.jpg
);

CREATE TABLE staff_services (
  staff_id    INTEGER NOT NULL,
  service_id  INTEGER NOT NULL,
  location_id INTEGER
);
CREATE INDEX idx_ss_service ON staff_services(service_id);

CREATE TABLE staff_schedule_items (
  staff_id    INTEGER NOT NULL,
  location_id INTEGER,
  day_index   INTEGER NOT NULL,     -- 1=Mon .. 7=Sun (Bookly)
  start_time  TEXT NOT NULL,        -- "HH:MM:SS"
  end_time    TEXT NOT NULL
);
CREATE INDEX idx_sched_staff ON staff_schedule_items(staff_id);

CREATE TABLE customers (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  full_name  TEXT,
  phone      TEXT,
  email      TEXT,
  notes      TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE appointments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  location_id   INTEGER,
  staff_id      INTEGER,
  service_id    INTEGER,
  start_date    TEXT NOT NULL,       -- "YYYY-MM-DD HH:MM:SS"
  end_date      TEXT,
  internal_note TEXT,
  created_at    TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_appt_start ON appointments(start_date);

CREATE TABLE customer_appointments (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id    INTEGER NOT NULL,
  appointment_id INTEGER NOT NULL,
  status         TEXT DEFAULT 'pending',   -- pending | approved | cancelled | done
  notes          TEXT,
  created_at     TEXT DEFAULT (datetime('now'))
);
