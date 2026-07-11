import servicesRaw from "../data/services.json";
import categoriesRaw from "../data/service_categories.json";
import staffRaw from "../data/staff.json";
import staffServicesRaw from "../data/staff_services.json";
import schedulesRaw from "../data/schedules.json";
import locationsRaw from "../data/locations.json";
import teamRaw from "../data/team.json";
import clinicsRaw from "../data/clinics.json";

export type Service = {
  id: number;
  title: string;
  price: number;
  duration_min: number;
  category_id: number;
};
export type Category = { id: number; name: string };
export type Staff = { id: number; name: string };
export type StaffService = { staff_id: number; service_id: number; location_id: number | null };
export type Schedule = { staff_id: number; location_id: number | null; day: number; start: string; end: string };
export type Location = { id: number; name: string; info: string | null };
export type TeamMember = {
  id: number;
  name: string;
  specialisation: string | null;
  slogan: string | null;
  short_text: string | null;
  type: string | null;
};
export type Clinic = {
  id: number;
  name: string;
  address: string | null;
  city: string | null;
  postcode: string | null;
  telephone: string | null;
  hero_heading: string | null;
  hours: Record<string, string | null>;
};

export const services = servicesRaw as Service[];
export const categories = categoriesRaw as Category[];
export const staff = staffRaw as Staff[];
export const staffServices = staffServicesRaw as StaffService[];
export const schedules = schedulesRaw as Schedule[];
export const locations = locationsRaw as Location[];
export const team = teamRaw as TeamMember[];
export const clinics = clinicsRaw as Clinic[];

export const categoryName = (id: number) =>
  categories.find((c) => c.id === id)?.name ?? "Other";

export const servicesByCategory = () => {
  const map = new Map<number, Service[]>();
  for (const s of services) {
    if (!map.has(s.category_id)) map.set(s.category_id, []);
    map.get(s.category_id)!.push(s);
  }
  return Array.from(map.entries()).map(([cid, items]) => ({
    id: cid,
    name: categoryName(cid),
    items,
  }));
};

// Site-wide contact info (from the live UK site)
export const CONTACT = {
  email: "info@acuproclinic.co.uk",
  whatsapp: "+44 7521 808887",
  phone: "+44 (0)20 3239 7888",
  whatsappUrl: "https://wa.me/447521808887",
};
