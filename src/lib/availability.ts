import { schedules, staffServices, type Service } from "../data";

// Bookly day_index: 1 = Monday ... 7 = Sunday.
// JS getDay(): 0 = Sunday ... 6 = Saturday.
const jsDayToBookly = (jsDay: number) => (jsDay === 0 ? 7 : jsDay);

export type Slot = { time: string; staffIds: number[] };

/** Staff who can perform a given service (optionally at a given location). */
export function staffForService(serviceId: number, locationId?: number | null): number[] {
  const ids = staffServices
    .filter(
      (ss) =>
        ss.service_id === serviceId &&
        (locationId == null || ss.location_id == null || ss.location_id === locationId),
    )
    .map((ss) => ss.staff_id);
  return Array.from(new Set(ids));
}

/** Location ids where a service is offered. */
export function locationsForService(serviceId: number): number[] {
  const ids = staffServices
    .filter((ss) => ss.service_id === serviceId && ss.location_id != null)
    .map((ss) => ss.location_id as number);
  return Array.from(new Set(ids));
}

function toMinutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}
function fromMinutes(m: number): string {
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

/**
 * Draft availability: generate candidate slots from staff weekly schedules for
 * the chosen date, at the service's duration granularity. (Existing-appointment
 * conflict checks happen server-side against D1 in the production build.)
 */
export function slotsForDate(
  service: Service,
  date: Date,
  opts: { locationId?: number | null; staffId?: number | null } = {},
): Slot[] {
  const bookly = jsDayToBookly(date.getDay());
  const eligibleStaff = new Set(staffForService(service.id, opts.locationId));
  const step = 30; // 30-min grid
  const dur = Math.max(service.duration_min, 30);

  const bucket = new Map<string, Set<number>>();
  for (const sch of schedules) {
    if (sch.day !== bookly) continue;
    if (!eligibleStaff.has(sch.staff_id)) continue;
    if (opts.staffId && sch.staff_id !== opts.staffId) continue;
    if (opts.locationId && sch.location_id != null && sch.location_id !== opts.locationId) continue;
    const start = toMinutes(sch.start);
    const end = toMinutes(sch.end);
    for (let t = start; t + dur <= end; t += step) {
      const key = fromMinutes(t);
      if (!bucket.has(key)) bucket.set(key, new Set());
      bucket.get(key)!.add(sch.staff_id);
    }
  }

  return Array.from(bucket.entries())
    .sort((a, b) => toMinutes(a[0]) - toMinutes(b[0]))
    .map(([time, ids]) => ({ time, staffIds: Array.from(ids) }));
}
