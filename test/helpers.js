import { DEFAULTS } from "../src/config.js";
import { EMPTY } from "../src/store.js";

export const config = (over = {}) => ({ ...DEFAULTS, ...over });
export const store = () => EMPTY();

// Wednesday 2026-10-21, 10:00 AM in Woburn (EDT, UTC-4).
export const WED_10AM = new Date("2026-10-21T14:00:00Z");

export function lead(over = {}) {
  return {
    id: over.id || "L" + Math.random().toString(36).slice(2, 8),
    name: "Maria Gonzalez",
    firstName: "",
    phone: "+16175550101",
    vehicle: "RAV4 Hybrid",
    stage: "Working",
    receivedDate: null,
    followUpDate: null,
    appointmentDate: null,
    testDriveDate: null,
    showed: null,
    consent: true,
    ...over,
  };
}

export function add(s, l) {
  s.leads[l.id] = l;
  return l;
}

export function sent(s, { phone, leadId = null, template = "lead-followup", at, dueKey = null }) {
  const m = {
    id: "m" + Math.random().toString(36).slice(2, 8),
    key: `${leadId}:${template}:${dueKey}`,
    leadId,
    phone,
    template,
    dueKey,
    body: "x",
    status: "sent",
    createdAt: at,
    sentAt: at,
  };
  s.outbound.push(m);
  return m;
}
