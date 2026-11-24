export function appointmentStatusKey(appointment) {
  const status = String(appointment?.status || "pending")
    .toLowerCase()
    .trim();

  return status === "confirmed" ? "approved" : status;
}

export function parseDateOnly(value) {
  if (!value) return null;

  if (typeof value.toDate === "function") {
    const date = value.toDate();
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
  }

  const text = String(value).trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);

  if (match) {
    return new Date(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3])
    );
  }

  const fallback = new Date(text);
  if (Number.isNaN(fallback.getTime())) return null;

  return new Date(
    fallback.getFullYear(),
    fallback.getMonth(),
    fallback.getDate()
  );
}

export function parseTime(value) {
  if (!value) return null;

  const match =
    /^(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)?$/i.exec(
      String(value).trim()
    );

  if (!match) return null;

  let hours = Number(match[1]);
  const minutes = Number(match[2]);
  const meridiem = (match[3] || "").toUpperCase();

  if (hours > 23 || minutes > 59) return null;

  if (meridiem === "PM" && hours < 12) hours += 12;
  if (meridiem === "AM" && hours === 12) hours = 0;

  return { hours, minutes };
}
