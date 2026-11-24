import test from "node:test";
import assert from "node:assert/strict";

import {
  appointmentStatusKey,
  parseDateOnly,
  parseTime
} from "../../js/appointment-utils.mjs";

test("appointmentStatusKey normalizes legacy and current statuses", () => {
  assert.equal(appointmentStatusKey({ status: "Confirmed" }), "approved");
  assert.equal(appointmentStatusKey({ status: " PENDING " }), "pending");
  assert.equal(appointmentStatusKey({ status: "Cancelled" }), "cancelled");
  assert.equal(appointmentStatusKey({}), "pending");
  assert.equal(appointmentStatusKey(null), "pending");
});

test("parseDateOnly parses calendar dates without shifting local day", () => {
  const date = parseDateOnly("2026-11-10");

  assert.ok(date instanceof Date);
  assert.equal(date.getFullYear(), 2026);
  assert.equal(date.getMonth(), 10);
  assert.equal(date.getDate(), 10);
  assert.equal(date.getHours(), 0);
});

test("parseDateOnly accepts Firestore-like timestamps and rejects invalid input", () => {
  const timestamp = {
    toDate: () => new Date(2026, 10, 10, 18, 30)
  };
  const date = parseDateOnly(timestamp);

  assert.equal(date.getFullYear(), 2026);
  assert.equal(date.getMonth(), 10);
  assert.equal(date.getDate(), 10);
  assert.equal(date.getHours(), 0);
  assert.equal(parseDateOnly("not a date"), null);
  assert.equal(parseDateOnly(""), null);
});

test("parseTime normalizes 12-hour and 24-hour times", () => {
  assert.deepEqual(parseTime("12:00 AM"), { hours: 0, minutes: 0 });
  assert.deepEqual(parseTime("12:30 PM"), { hours: 12, minutes: 30 });
  assert.deepEqual(parseTime("9:05 pm"), { hours: 21, minutes: 5 });
  assert.deepEqual(parseTime("23:59:30"), { hours: 23, minutes: 59 });
});

test("parseTime rejects invalid time values", () => {
  assert.equal(parseTime("24:00"), null);
  assert.equal(parseTime("10:60"), null);
  assert.equal(parseTime("noon"), null);
  assert.equal(parseTime(""), null);
});
