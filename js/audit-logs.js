import { auth, db } from "./firebase-config.js";
import { getUserProfileSnapshot } from "./user-profile.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import { collection, getDocs } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

const auditTable = document.getElementById("auditLogsTable");

function escapeHTML(value) {
  const element = document.createElement("div");
  element.textContent = String(value ?? "—");
  return element.innerHTML;
}

function getEventDate(data) {
  if (typeof data.createdAt?.toDate === "function") return data.createdAt.toDate();
  if (typeof data.timestamp?.toDate === "function") return data.timestamp.toDate();
  if (Number(data.createdAtMillis) > 0) return new Date(Number(data.createdAtMillis));
  if (typeof data.timestamp === "string") {
    const parsed = new Date(data.timestamp);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return null;
}

function formatDate(data) {
  const date = getEventDate(data);
  return date ? date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "—";
}

function formatActor(data) {
  const actor = data.performedBy;
  if (actor && typeof actor === "object") {
    return actor.email || actor.name || actor.displayName || actor.fullName ||
      formatDetailValue(actor.role, "role") || "System";
  }
  return data.actorName || data.userName || data.actorEmail || data.userEmail ||
    (typeof actor === "string" ? actor : null) || "System";
}

function formatTarget(data) {
  const target = data.target;
  if (target && typeof target === "object") {
    return [target.type, target.email || target.id].filter(Boolean).join(" · ") || "—";
  }
  return data.resource || target || data.collection || "—";
}

function formatAction(value) {
  return String(value || "Activity")
    .replace(/[_-]+/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatFieldName(value) {
  return String(value)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .toLowerCase();
}

function formatDetailValue(value, key = "") {
  if (value == null || value === "") return "";
  if (Array.isArray(value)) {
    return value.map((item) => formatDetailValue(item)).filter(Boolean).join(", ");
  }
  if (typeof value === "object") {
    return Object.entries(value)
      .map(([childKey, childValue]) => {
        const formattedValue = formatDetailValue(childValue, childKey);
        return formattedValue
          ? `${formatFieldName(childKey)}: ${formattedValue}`
          : "";
      })
      .filter(Boolean)
      .join(", ");
  }

  const text = String(value);
  if (key.toLowerCase().includes("role")) {
    const roleLabels = {
      admin: "Administrator",
      staff: "Staff",
      vet: "Veterinarian",
      veterinarian: "Veterinarian",
      superadmin: "IT Administrator",
      petowner: "Pet Owner"
    };
    return roleLabels[text.toLowerCase()] || text;
  }
  return text;
}

function formatDetails(data) {
  const details = data.details ?? data.message ?? data.description;
  if (details == null || details === "") return "—";
  if (typeof details === "string") return details;
  if (typeof details !== "object" || Array.isArray(details)) {
    return formatDetailValue(details) || "—";
  }

  if (data.action === "SECURITY_SETTINGS_UPDATED" && Array.isArray(details.changed)) {
    const settingLabels = {
      requireRecentLogin: "Require recent sign-in",
      roleNotifications: "Role change notifications",
      adminPasswordResets: "Admin password-reset action"
    };
    return details.changed
      .map(({ key, enabled }) => (
        settingLabels[key]
          ? `${settingLabels[key]} ${enabled ? "enabled" : "disabled"}`
          : ""
      ))
      .filter(Boolean)
      .join(", ") || "—";
  }

  if (data.action === "ROLE_PERMISSIONS_UPDATED" && details.permissions) {
    const permissionLabels = {
      dashboard: "Dashboard",
      petRecords: "Pet records",
      petOwners: "Pet owners",
      scanRecords: "Scan records",
      appointments: "Appointments",
      consultations: "Consultations",
      smsLogs: "SMS logs",
      users: "Users",
      roles: "Roles & permissions",
      auditLogs: "Audit logs",
      securitySettings: "Security settings",
      settings: "Settings"
    };
    const updates = Object.entries(details.permissions)
      .filter(([, enabled]) => typeof enabled === "boolean")
      .map(([key, enabled]) => `${permissionLabels[key] || formatFieldName(key)} ${enabled ? "enabled" : "disabled"}`);
    return `Updated permissions for ${details.role || "role"}${updates.length ? `: ${updates.join(", ")}` : ""}`;
  }

  if (data.action === "USER_ACCOUNT_DELETED" && details.name) {
    const attributes = [
      details.role ? `role: ${formatDetailValue(details.role, "role")}` : "",
      details.status ? `status: ${details.status}` : ""
    ].filter(Boolean);
    return `Deleted account ${details.name}${attributes.length ? ` (${attributes.join(", ")})` : ""}`;
  }

  const preferredFields = [
    ["newName", "name"],
    ["newStatus", "status"],
    ["newRole", "role"]
  ];
  const formattedFields = preferredFields
    .filter(([key]) => Object.prototype.hasOwnProperty.call(details, key))
    .map(([key, label]) => {
      const value = formatDetailValue(details[key], key);
      return value ? `${label} to ${value}` : "";
    })
    .filter(Boolean);

  if (formattedFields.length) {
    return `Updated ${formattedFields.join(", ")}`;
  }

  const entries = Object.entries(details)
    .map(([key, value]) => {
      const formattedValue = formatDetailValue(value, key);
      return formattedValue
        ? `${formatFieldName(key)}: ${formattedValue}`
        : "";
    })
    .filter(Boolean);
  return entries.length ? entries.join(", ") : "—";
}

function renderAuditLogs(records) {
  if (!auditTable) return;
  if (!records.length) {
    auditTable.innerHTML = `<tr><td colspan="5" class="text-center text-muted audit-empty">No audit events have been recorded yet.</td></tr>`;
    return;
  }
  auditTable.innerHTML = records.map(({ data }) => `
    <tr>
      <td>${escapeHTML(formatDate(data))}</td>
      <td>${escapeHTML(formatActor(data))}</td>
      <td class="audit-action">${escapeHTML(formatAction(data.action || data.event))}</td>
      <td>${escapeHTML(formatTarget(data))}</td>
      <td>${escapeHTML(formatDetails(data))}</td>
    </tr>
  `).join("");
}

async function loadAuditLogs() {
  auditTable.innerHTML = `<tr><td colspan="5" class="text-center text-muted py-4">Loading audit logs...</td></tr>`;
  try {
    const snapshot = await getDocs(collection(db, "audit_logs"));
    const records = snapshot.docs.map((item) => ({ id: item.id, data: item.data() }));
    records.sort((left, right) => (getEventDate(right.data)?.getTime() || 0) - (getEventDate(left.data)?.getTime() || 0));
    renderAuditLogs(records);
  } catch (error) {
    console.error("Could not load audit logs:", error);
    auditTable.innerHTML = `<tr><td colspan="5" class="text-center text-muted audit-empty">Could not load audit logs. Check Firestore access and try again.</td></tr>`;
  }
}

onAuthStateChanged(auth, async (user) => {
  if (!user) { window.location.href = "login.html"; return; }
  try {
    const profile = await getUserProfileSnapshot(user);
    const role = String(profile.data()?.role || "").toLowerCase().trim();
    const status = String(profile.data()?.status || "active").toLowerCase().trim();
    if (!profile.exists() || role !== "superadmin" || status !== "active") {
      window.alert("Access denied. IT Administrator access only.");
      window.location.href = "users.html";
      return;
    }
    await loadAuditLogs();
  } catch (error) {
    console.error("Could not verify audit log access:", error);
    window.location.href = "users.html";
  }
});

document.getElementById("refreshAuditLogs")?.addEventListener("click", loadAuditLogs);
