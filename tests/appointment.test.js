import test from "node:test";
import assert from "node:assert/strict";

const { buildCalendarLinks, buildIcs } = await import("../src/services/appointment.service.js");

const appointment = {
  id: "11111111-1111-4111-8111-111111111111",
  title: "Consultation",
  starts_at: "2026-10-01T10:00:00.000Z",
  ends_at: "2026-10-01T10:30:00.000Z",
  notes: "Customer consultation",
};

test("builds Google and Outlook calendar links", () => {
  const links = buildCalendarLinks(appointment);
  assert.match(links.google, /^https:\/\/calendar\.google\.com\/calendar\/render/);
  assert.match(links.outlook, /^https:\/\/outlook\.live\.com\/calendar\/0\/deeplink\/compose/);
  assert.match(links.google, /Consultation/);
  assert.match(links.outlook, /Consultation/);
});

test("builds a valid basic ICS event", () => {
  const ics = buildIcs(appointment);
  assert.match(ics, /BEGIN:VCALENDAR/);
  assert.match(ics, /BEGIN:VEVENT/);
  assert.match(ics, /UID:11111111-1111-4111-8111-111111111111@nova-ai/);
  assert.match(ics, /DTSTART:20261001T100000Z/);
  assert.match(ics, /DTEND:20261001T103000Z/);
  assert.match(ics, /SUMMARY:Consultation/);
  assert.match(ics, /END:VEVENT/);
  assert.match(ics, /END:VCALENDAR/);
});

test("escapes ICS text delimiters and newlines", () => {
  const ics = buildIcs({ ...appointment, title: "A,B;C", notes: "line 1\nline 2" });
  assert.match(ics, /SUMMARY:A\\,B\\;C/);
  assert.match(ics, /DESCRIPTION:line 1\\nline 2/);
});

test("escapes lone carriage returns so appointment notes cannot inject ICS properties", () => {
  const notes = "legitimate note\\rX-ATTACH:https://attacker.example/payload\\nSUMMARY:Injected";
  const ics = buildIcs({ ...appointment, notes });
  const lines = ics.split("\\r\\n");

  assert.ok(
    lines.includes("DESCRIPTION:legitimate note\\\\nX-ATTACH:https://attacker.example/payload\\\\nSUMMARY:Injected"),
    "CR and LF in text must become escaped iCalendar newline sequences",
  );
  assert.equal(lines.filter((line) => line.startsWith("X-ATTACH:")).length, 0);
  assert.equal(lines.filter((line) => line === "BEGIN:VEVENT").length, 1);
  assert.equal(lines.filter((line) => line.startsWith("SUMMARY:")).length, 1);
});
