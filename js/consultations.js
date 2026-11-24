import { db, storage } from "./firebase-config.js";

import {
  onAuthStateChangedWithRole,
  redirectSuperadminFromSensitivePage
} from "./auth-state.js";

import { getUserProfileSnapshot } from "./user-profile.js";

import {
  collection,
  onSnapshot,
  query,
  orderBy,
  where,
  serverTimestamp,
  doc,
  updateDoc,
  getDoc,
  getDocs,
  writeBatch,
  runTransaction,
  deleteDoc,
  setDoc
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { getAuthUserRole } from "./auth-state.js";

import {
  deleteObject,
  ref
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-storage.js";

// ========================================
// STATE + ELEMENTS
// ========================================

let currentUser = null;
let currentRole = "";
let currentRoomId = null;
let currentRoomOwnerId = null;
let currentRoom = null;
let requestedRoomId = new URLSearchParams(
  window.location.search
).get("roomId");

let unsubscribeMessages = null;
let unsubscribeRooms = null;
let unsubscribeAppointmentStatuses = null;
let unsubscribePresence = null;
let presenceTimer = null;

let pendingRoom = null;
let allRooms = [];
const unsubscribeUnreadMessages = new Map();
const unreadRoomMessages = new Map();
const appointmentStatuses = new Map();

const ownerNameCache = new Map();
const ownerNameRequests = new Map();
const ownerNameSearchAttempts = new Set();
const roomPetNameCache = new Map();

let selectionMode = false;
let selectedMessageIds = new Set();
let currentMessages = new Map();

let messageAdminToolbar = null;
let editMessagesButton = null;
let selectedMessagesCount = null;
let deleteSelectedMessagesButton = null;
let cancelMessageSelectionButton = null;
let isDeletingMessages = false;
let messageSendInProgress = false;
let conversationFilter = "open";
let roomUnsubscribers = [];

const $ = (id) => document.getElementById(id);

const wrapper = $("chatWrapper");
const usersList = $("chatUsersList");
const chatBox = $("chatMessages");
const messageInput = $("messageInput");
const sendButton = $("sendMessageBtn");
const photoButton = $("sendPhotoBtn");
const fileButton = $("sendFileBtn");
const photoInput = $("chatPhotoInput");
const fileInput = $("chatFileInput");
const attachmentStatus = $("chatAttachmentStatus");
const searchInput = $("chatSearch");
const backButton = $("chatBackBtn");
const headerName = $("chatPetName");
const headerSub = $("chatOwnerName");
const headerActions = $("chatHeaderActions");
const chatFilterButtons = document.querySelectorAll("[data-chat-filter]");
const resolvedFilterButton = document.querySelector('[data-chat-filter="resolved"]');
const resolvedUnreadIndicator = $("resolvedUnreadIndicator");
const composeLegend = $("chatComposeLegend");
const newChatButton = $("newChatBtn");
const escalationVetModal = $("escalateVetModal");
const escalationVetSelect = $("escalationVetSelect");
const escalationVetError = $("escalationVetError");
const escalationVetConfirm = $("escalateVetConfirm");

const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024;
const CLOUDINARY_CLOUD_NAME = "vgzc5f3c";
const CLOUDINARY_UPLOAD_PRESET = "chatattachments";
const APPOINTMENT_REQUEST_PATTERN =
  /^\s*(?:📅\s*)?(?:\[Appointment Request\]|Appointment Request)\s*\|\s*Pet:\s*(.+?)\s*\|\s*Date:\s*(.+?)\s*$/i;
const APPOINTMENT_STATUS_CARD_PATTERN =
  /^\s*\[Appointment (Approved|Cancelled)\]\s*\|\s*Pet:\s*(.+?)\s*\|\s*Date:\s*(.+?)\s*$/i;

const ATTACHMENT_MIME_TYPES = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  csv: "text/csv",
  txt: "text/plain"
};

const ALLOWED_ATTACHMENT_TYPES = new Set(
  Object.values(ATTACHMENT_MIME_TYPES)
);

// ========================================
// IMAGE PREVIEW: ZOOM + PAN
// ========================================

const previewModal = $("chatImagePreviewModal");
const previewImg = $("chatImagePreview");
const previewTitle = $("chatImagePreviewTitle");
const previewBody = document.querySelector(".chat-image-preview-body");
const previewStage = document.querySelector(".chat-image-stage");
const zoomLevel = $("chatImageZoomLevel");

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 3;
const ZOOM_STEP = 0.25;

let zoom = 1;
let panX = 0;
let panY = 0;
let panPointer = null;
let lastX = 0;
let lastY = 0;

function applyTransform() {
  if (previewImg) {
    previewImg.style.transform =
      `translate(${panX}px, ${panY}px) scale(${zoom})`;
  }
}

function constrainPan() {
  if (!previewImg || !previewStage) return;

  const maxX = Math.max(
    0,
    (previewImg.offsetWidth * zoom - previewStage.clientWidth) / 2
  );

  const maxY = Math.max(
    0,
    (previewImg.offsetHeight * zoom - previewStage.clientHeight) / 2
  );

  panX = Math.max(-maxX, Math.min(maxX, panX));
  panY = Math.max(-maxY, Math.min(maxY, panY));
}

function setZoom(value) {
  zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));

  if (zoom <= 1) {
    panX = 0;
    panY = 0;
  } else {
    constrainPan();
  }

  applyTransform();
  previewStage?.classList.toggle("is-zoomed", zoom > 1);

  if (zoomLevel) {
    zoomLevel.textContent = `${Math.round(zoom * 100)}%`;
  }
}

function resetZoom() {
  panX = 0;
  panY = 0;
  setZoom(1);
}

$("chatImageZoomIn")?.addEventListener("click", () => {
  setZoom(zoom + ZOOM_STEP);
});

$("chatImageZoomOut")?.addEventListener("click", () => {
  setZoom(zoom - ZOOM_STEP);
});

$("chatImageZoomReset")?.addEventListener("click", resetZoom);

previewStage?.addEventListener("pointerdown", (event) => {
  if (zoom <= 1 || event.button !== 0) return;

  panPointer = event.pointerId;
  lastX = event.clientX;
  lastY = event.clientY;

  previewStage.classList.add("is-dragging");
  previewStage.setPointerCapture(event.pointerId);

  event.preventDefault();
});

previewStage?.addEventListener("pointermove", (event) => {
  if (event.pointerId !== panPointer) return;

  panX += event.clientX - lastX;
  panY += event.clientY - lastY;

  lastX = event.clientX;
  lastY = event.clientY;

  constrainPan();
  applyTransform();
});

function stopPan(event) {
  if (event.pointerId !== panPointer) return;

  if (previewStage.hasPointerCapture(event.pointerId)) {
    previewStage.releasePointerCapture(event.pointerId);
  }

  panPointer = null;
  previewStage.classList.remove("is-dragging");
}

previewStage?.addEventListener("pointerup", stopPan);
previewStage?.addEventListener("pointercancel", stopPan);

previewBody?.addEventListener(
  "wheel",
  (event) => {
    if (!previewModal?.classList.contains("show")) return;

    event.preventDefault();

    setZoom(
      zoom + (event.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP)
    );
  },
  { passive: false }
);

previewModal?.addEventListener("hidden.bs.modal", resetZoom);

// ========================================
// HELPERS
// ========================================

function getRoomName(room) {
  return (
    room.ownerName ||
    room.petOwnerName ||
    room.ownerFullName ||
    room.ownerEmail ||
    room.petName ||
    "Pet owner"
  );
}

function getRoomOwnerId(room) {
  return room.petOwnerId || room.owner_id || room.ownerId || room.ownerUid || room.owner_uid || room.userId || null;
}

function getRoomPetName(room, roomId) {
  return room.petName || room.pet || roomPetNameCache.get(roomId) || "Unknown";
}

function getMessagePetName(message) {
  const appointment = message.appointment && typeof message.appointment === "object"
    ? message.appointment
    : {};
  const name =
    message.petName ||
    message.pet_name ||
    appointment.petName ||
    appointment.pet_name ||
    appointment.pet ||
    parseAppointmentRequest(message.text)?.petName;
  return typeof name === "string" ? name.trim() : "";
}

function initialOf(name) {
  return (name || "?").trim().charAt(0).toUpperCase() || "?";
}

function firstNameOf(name) {
  return String(name || "").trim().split(/\s+/)[0] || "Pet owner";
}

function getMessagePreview(message) {
  if (!message) return "No messages yet";

  const appointment = String(message).match(/\[Appointment\s+(Approved|Requested|Cancelled|Request)\]\s*\|\s*Pet:\s*([^|]+)/i);
  if (appointment) {
    const state = appointment[1].toLowerCase() === "request" ? "Requested" : appointment[1];
    return `[Appointment ${state}] Pet: ${appointment[2].trim()}`;
  }

  if (/\[Photo\s+Attachment\]/i.test(message)) {
    return "Photo attachment";
  }

  if (/\[Scan\s+Attachment\]/i.test(message)) {
    return "Scan attachment";
  }

  if (/\[(Attached\s+)?Document(\s+Attachment)?\]/i.test(message)) {
    return "Document attachment";
  }

  return message;
}

// Normalize legacy and newer message payloads into the prototype's display model.
// Alignment is deliberately based on role/type, never on the logged-in user's id.
function mapMessageForDisplay(message) {
  const rawType = String(
    message.sender_type ?? message.senderType ?? message.author_type ?? message.authorType ?? message.from_type ?? message.fromType ?? ""
  ).trim().toLowerCase();
  const rawRole = String(
    message.sender_role ?? message.senderRole ?? message.author_role ?? message.authorRole ?? message.role ?? message.from_role ?? message.fromRole ?? message.from ?? message.sender ?? ""
  ).trim().toLowerCase();
  const compactType = rawType.replace(/[\s_-]/g, "");
  const compactRole = rawRole.replace(/[\s_-]/g, "");
  const ownerAliases = ["owner", "petowner", "customer", "user", "petparent", "petparentuser"];
  const clinicAliases = ["clinic", "staff", "admin", "vet", "veterinarian", "webstaff", "webadmin"];
  const ownerId = currentRoomOwnerId || getRoomOwnerId(currentRoom || {});
  const explicitOwner = ownerAliases.includes(compactType) || ownerAliases.includes(compactRole);
  const explicitClinic = clinicAliases.includes(compactType) || clinicAliases.includes(compactRole);
  const senderId = message.senderId || message.sender_id || message.authorId || message.author_id;
  const isOwner = explicitOwner || (!explicitClinic && senderId === ownerId);
  const rawKind = String(message.kind ?? message.type ?? message.k ?? "").trim().toLowerCase();
  const isAppointmentEvent = [
    "appointment_event",
    "appointment_status"
  ].includes(rawKind);
  const isEvent = [
    "appointment_event",
    "appointment_status",
    "chat_status_event"
  ].includes(rawKind);
  const isNote = ["n", "note", "internal_note", "internal-note", "staff_note"].includes(rawKind) ||
    message.internalOnly === true ||
    message.internalNote === true || message.isInternal === true;
  const isAppointment = !isEvent && (["a", "appointment", "appointment_card", "appointment_request", "appointment_status", "consultation"].includes(rawKind) ||
    Boolean(message.appointmentRequest || message.appointment || message.appointmentId) ||
    /\[Appointment (?:Request|Approved|Cancelled)\]/i.test(message.text || ""));

  return {
    ...message,
    isAppointmentEvent,
    isEvent,
    k: isNote ? "n" : isAppointment ? "a" : isOwner ? "o" : "c",
    senderRole: isOwner ? "owner" : "clinic"
  };
}

const ATTACH_LINE =
  /\[(?:Photo|Scan|Document)\s+Attachment\]|\[Attached\s+Document\]|^\W*Attached Scan Record\W*$|^\s*\W*\[Appointment (?:Request|Approved|Cancelled)\].*$|^\s*Appointment\s+(?:Request|Approved|Cancelled)\b.*$/i;

function stripAttachmentLines(text) {
  return (text || "")
    .split("\n")
    .filter((line) => {
      const trimmedLine = line.trim();
      return (
        !ATTACH_LINE.test(trimmedLine) &&
        !APPOINTMENT_REQUEST_PATTERN.test(trimmedLine) &&
        !APPOINTMENT_STATUS_CARD_PATTERN.test(trimmedLine)
      );
    })
    .join("\n")
    .trim();
}

function stripAppointmentLines(text) {
  return (text || "")
    .split("\n")
    .filter((line) =>
      !ATTACH_LINE.test(line.trim()) &&
      !/\bAppointment\s+(?:Request|Approved|Cancelled)\b/i.test(line) &&
      !/^\s*(?:Pet(?:\s+Name|_name)?|Animal|(?:Requested|Preferred|Appointment)\s+Date(?:\s+(?:and|&)\s+Time)?|Date(?:\s+(?:and|&)\s+Time)?|Time|Schedule)\s*[:=-]/i.test(line)
    )
    .join("\n")
    .trim();
}

function parseScanText(text) {
  const match = (text || "").match(
    /Pet:\s*([^|\n]+?)\s*\|\s*([^\n(]+?)\s*(?:\((\d+(?:\.\d+)?)%\))?\s*(?:\n|$)/
  );

  return match
    ? {
        pet: match[1].trim(),
        condition: match[2].trim(),
        confidence: match[3] || ""
      }
    : {};
}

function toMillis(timestamp) {
  if (typeof timestamp?.toMillis === "function") {
    return timestamp.toMillis();
  }
  if (typeof timestamp?.toDate === "function") {
    return timestamp.toDate().getTime();
  }
  if (timestamp instanceof Date) return timestamp.getTime();
  if (typeof timestamp === "number") return timestamp;
  if (typeof timestamp === "string") {
    const parsed = Date.parse(timestamp);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  if (Number.isFinite(timestamp?.seconds)) {
    return timestamp.seconds * 1000;
  }
  return 0;
}

function sameDay(a, b) {
  return a.toDateString() === b.toDateString();
}

function formatDay(date) {
  const today = new Date();
  const yesterday = new Date();

  yesterday.setDate(today.getDate() - 1);

  if (sameDay(date, today)) return "Today";
  if (sameDay(date, yesterday)) return "Yesterday";

  return date.toLocaleDateString([], {
    month: "short",
    day: "numeric",
    year: "numeric"
  });
}

function formatListTime(timestamp) {
  const millis = toMillis(timestamp);
  if (!millis) return "";
  const date = new Date(millis);

  return sameDay(date, new Date())
    ? date.toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
        hour12: true
      })
    : date.toLocaleDateString([], {
        month: "short",
        day: "numeric"
      });
}

function roomStatus(room) {
  return String(room.status || room.state || "open").trim().toLowerCase() === "resolved"
    ? "resolved"
    : "open";
}

function medicalChatStatus(room) {
  const status = String(room.chat_status || "STANDARD").trim().toUpperCase();
  return ["STANDARD", "ESCALATED", "RESOLVED"].includes(status)
    ? status
    : "STANDARD";
}

function isVeterinarian() {
  return ["vet", "veterinarian"].includes(currentRole);
}

function canWriteCurrentChat(room = currentRoom) {
  if (!room || roomStatus(room) === "resolved") return false;
  if (["admin", "staff"].includes(currentRole)) return true;
  return isVeterinarian() &&
    medicalChatStatus(room) === "ESCALATED" &&
    room.escalatedVetId === currentUser?.uid;
}

function handlerIdOf(room) {
  return room.handlerId || room.handler_id || room.assignedTo || room.assignedToId || null;
}

function stableSenderColor(idOrName) {
  const colors = ["#6b3fa0", "#c2410c", "#0f766e", "#2563eb", "#a21caf", "#b45309"];
  const value = String(idOrName || "clinic");
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) hash = ((hash << 5) - hash) + value.charCodeAt(index);
  return colors[Math.abs(hash) % colors.length];
}

function roleLabel(role) {
  return { admin: "Administrator", staff: "Staff", vet: "Veterinarian", veterinarian: "Veterinarian" }[role] || "Clinic";
}

function senderRoleLabel(name, role) {
  return name === "SkinPawsible Clinic" ? "" : roleLabel(role);
}

async function getClinicSender(message) {
  const name = message.senderName || message.sender_name;
  const role = String(message.sender_role || message.senderRole || "clinic").toLowerCase();
  if (name) return { name, role: senderRoleLabel(name, role), color: stableSenderColor(message.senderId || name) };
  if (message.senderId && ownerNameCache.has(`sender:${message.senderId}`)) return ownerNameCache.get(`sender:${message.senderId}`);
  if (message.senderId) {
    try {
      const snapshot = await getDoc(doc(db, "users", message.senderId));
      const data = snapshot.exists() ? snapshot.data() : {};
      const senderName = data.fullName || data.displayName || data.name || "Clinic";
      const sender = { name: senderName, role: senderRoleLabel(senderName, data.role || role), color: stableSenderColor(message.senderId) };
      ownerNameCache.set(`sender:${message.senderId}`, sender);
      return sender;
    } catch (error) { console.warn("Could not load message sender:", error); }
  }
  return { name: "Clinic", role: senderRoleLabel("Clinic", role), color: stableSenderColor(message.senderId || role) };
}

function emptyState(icon, text) {
  const wrap = document.createElement("div");
  wrap.className = "empty-chat";

  const iconElement = document.createElement("i");
  iconElement.className = `bi ${icon}`;
  iconElement.setAttribute("aria-hidden", "true");

  const paragraph = document.createElement("p");
  paragraph.className = "mb-0";
  paragraph.textContent = text;

  wrap.append(iconElement, paragraph);

  return wrap;
}

function showMessage(text, icon = "bi-chat-square-text") {
  if (!chatBox) return;

  chatBox.replaceChildren(emptyState(icon, text));
}

function setComposerEnabled(enabled) {
  const disabled = !enabled || messageSendInProgress;

  if (messageInput) messageInput.disabled = disabled;
  if (sendButton) sendButton.disabled = disabled;
  if (photoButton) photoButton.disabled = disabled;
  if (fileButton) fileButton.disabled = disabled;

  if (messageInput && !disabled) updateComposeMode();
  else if (messageInput) messageInput.placeholder = "Select a conversation to write a message";
}

function autosizeInput() {
  if (!messageInput) return;

  messageInput.style.height = "auto";
  messageInput.style.height =
    `${Math.min(messageInput.scrollHeight, 140)}px`;
}

async function getOwnerName(room) {
  const existing =
    room.ownerName ||
    room.petOwnerName ||
    room.ownerFullName;

  if (existing) return existing;

  const ownerId = getRoomOwnerId(room);

  if (!ownerId) return room.petName || "Pet owner";

  if (ownerNameCache.has(ownerId)) {
    return ownerNameCache.get(ownerId);
  }

  if (!ownerNameRequests.has(ownerId)) {
    const request = (async () => {
      try {
        const snapshot = await getDoc(doc(db, "users", ownerId));

        if (snapshot.exists()) {
          const data = snapshot.data();

          const name =
            data.fullName ||
            data.name ||
            data.displayName ||
            data.email ||
            "Pet owner";

          ownerNameCache.set(ownerId, name);

          return name;
        }
      } catch (error) {
        console.error("Could not retrieve owner profile:", error);
      }

      return room.petName || "Pet owner";
    })();
    ownerNameRequests.set(ownerId, request);
    request.then(
      () => ownerNameRequests.delete(ownerId),
      () => ownerNameRequests.delete(ownerId)
    );
  }

  return ownerNameRequests.get(ownerId);
}

function parseAppointmentRequest(text) {
  const match = APPOINTMENT_REQUEST_PATTERN.exec(String(text || ""));
  if (!match) return null;

  const petName = match[1].trim();
  const dateMatch =
    /^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})\s+at\s+(\d{1,2}):(\d{2})\s*(AM|PM)$/i
      .exec(match[2].trim());

  if (!petName || !dateMatch) return null;

  const monthNames = [
    "jan", "feb", "mar", "apr", "may", "jun",
    "jul", "aug", "sep", "oct", "nov", "dec"
  ];
  const month = monthNames.indexOf(dateMatch[1].slice(0, 3).toLowerCase());
  const day = Number(dateMatch[2]);
  const year = Number(dateMatch[3]);
  let hours = Number(dateMatch[4]);
  const minutes = Number(dateMatch[5]);
  const meridiem = dateMatch[6].toUpperCase();

  if (
    month < 0 ||
    day < 1 ||
    day > 31 ||
    hours < 1 ||
    hours > 12 ||
    minutes > 59
  ) {
    return null;
  }

  if (meridiem === "PM" && hours < 12) hours += 12;
  if (meridiem === "AM" && hours === 12) hours = 0;

  const date = new Date(year, month, day);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month ||
    date.getDate() !== day
  ) {
    return null;
  }

  return {
    petName,
    preferredDate: `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    preferredTime: `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`
  };
}

function appointmentDateKey(value) {
  if (!value) return "";
  if (typeof value.toDate === "function") {
    const date = value.toDate();
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  }

  const text = String(value).trim();
  const isoDate = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (isoDate) return `${isoDate[1]}-${isoDate[2]}-${isoDate[3]}`;

  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function appointmentTimeKey(value) {
  const match =
    /^(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)?$/i.exec(
      String(value || "").trim()
    );
  if (!match) return "";

  let hours = Number(match[1]);
  const minutes = Number(match[2]);
  const meridiem = (match[3] || "").toUpperCase();
  if (hours > 23 || minutes > 59) return "";
  if (meridiem === "PM" && hours < 12) hours += 12;
  if (meridiem === "AM" && hours === 12) hours = 0;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function formatAppointmentStatusSchedule(dateValue, timeValue) {
  const dateTextValue = String(dateValue || "").trim();
  const isoDate = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateTextValue);
  let date = dateValue?.toDate
    ? dateValue.toDate()
    : dateValue instanceof Date
      ? dateValue
      : isoDate
        ? new Date(Number(isoDate[1]), Number(isoDate[2]) - 1, Number(isoDate[3]))
        : new Date(dateTextValue);
  let time = timeValue;

  if (Number.isNaN(date.getTime())) {
    return [String(dateValue || "").trim(), String(timeValue || "").trim()]
      .filter(Boolean)
      .join(" at ");
  }

  const dateText = date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric"
  });
  if (time?.toDate) {
    time = time.toDate();
  }
  if (time instanceof Date) {
    time = time.toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: true
    });
  }

  const timeMatch = /^(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)?$/i.exec(
    String(time || "").trim()
  );
  if (!timeMatch) return dateText;

  let hours = Number(timeMatch[1]);
  const minutes = Number(timeMatch[2]);
  const meridiem = (timeMatch[3] || "").toUpperCase();
  if (hours > 23 || minutes > 59) return dateText;
  if (meridiem === "PM" && hours < 12) hours += 12;
  if (meridiem === "AM" && hours === 12) hours = 0;

  const timeText = new Date(2000, 0, 1, hours, minutes).toLocaleTimeString(
    "en-US",
    { hour: "2-digit", minute: "2-digit", hour12: true }
  ).toLowerCase();
  return `${dateText} at ${timeText}`;
}

async function importAppointmentRequest(
  roomId,
  room,
  ownerName,
  messageId,
  message,
  existingAppointments
) {
  if (message.appointmentDeleted === true) return null;

  if (
    !getRoomOwnerId(room) ||
    message.senderId !== getRoomOwnerId(room)
  ) {
    return null;
  }

  const request = parseAppointmentRequest(message.text);
  if (!request) return null;

  const existingAppointment = existingAppointments.find((appointment) => {
    const ownerId =
      appointment.userId ||
      appointment.ownerId ||
      appointment.petOwnerId ||
      "";
    const petName = appointment.petName || appointment.pet || "";
    const date = appointment.preferredDate || appointment.date;
    const time = appointment.preferredTime || appointment.time;

    return ownerId === getRoomOwnerId(room) &&
      String(petName).trim().toLowerCase() === request.petName.toLowerCase() &&
      appointmentDateKey(date) === request.preferredDate &&
      appointmentTimeKey(time) === request.preferredTime;
  });
  const appointmentId =
    message.appointmentId ||
    existingAppointment?.id ||
    `chat_${roomId}_${messageId}`;
  const appointmentRef = doc(db, "consultations", appointmentId);
  const notificationRef = doc(
    db,
    "notifications",
    `appointment_${appointmentId}`
  );
  const createdAtDate = message.createdAt?.toDate
    ? message.createdAt.toDate()
    : new Date();

  await runTransaction(db, async (transaction) => {
    const existing = await transaction.get(appointmentRef);
    const status = existing.exists()
      ? String(existing.data().status || "Pending").toLowerCase().trim()
      : "pending";
    const notification = await transaction.get(notificationRef);

    if (existing.exists()) {
      if (
        existing.data().sourceRoomId !== roomId ||
        existing.data().sourceMessageId !== messageId
      ) {
        transaction.update(appointmentRef, {
          sourceRoomId: roomId,
          sourceMessageId: messageId
        });
      }

      if (status !== "pending" || notification.exists()) return;
    } else {
      transaction.set(appointmentRef, {
        userId: getRoomOwnerId(room),
        ownerName,
        petName: request.petName,
        preferredDate: request.preferredDate,
        preferredTime: request.preferredTime,
        status: "Pending",
        statusLower: "pending",
        source: "consultations_chat",
        sourceRoomId: roomId,
        sourceMessageId: messageId,
        createdAt: message.createdAt || serverTimestamp(),
        createdAtMillis: createdAtDate.getTime()
      });
    }

    transaction.set(notificationRef, {
      title: `New appointment request from ${ownerName}`,
      message: `New appointment request for ${request.petName} · ${request.preferredDate} at ${request.preferredTime}`,
      type: "APPOINTMENT",
      targetScreen: "APPOINTMENTS",
      targetId: appointmentId,
      sourceAppointmentId: appointmentId,
      sourceRoomId: roomId,
      sourceMessageId: messageId,
      recipientRole: "webStaff",
      isRead: false,
      readBy: [],
      dismissedBy: [],
      deletedBy: [],
      timestamp: new Date().toLocaleString(),
      createdAtMillis: Date.now(),
      createdAt: serverTimestamp()
    });
  });

  return appointmentId;
}

function setHeader(name) {
  if (headerName) headerName.textContent = firstNameOf(name);
}

function handlerDisplay(room) {
  const id = handlerIdOf(room);
  return id ? (room.handlerName || (id === currentUser?.uid ? "You" : "Clinic staff")) : "Unassigned";
}

function renderRoomActions(room) {
  if (!headerActions) return;
  headerActions.querySelector(".chat-room-actions")?.remove();
  const actions = document.createElement("div");
  actions.className = "chat-room-actions";
  const addAction = (label, action, primary = false) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `chat-room-action${primary ? " primary" : ""}`;
    button.textContent = label;
    button.addEventListener("click", () => void handleRoomAction(action));
    actions.appendChild(button);
  };

  if (["admin", "staff"].includes(currentRole)) {
    const handler = handlerIdOf(room);
    if (roomStatus(room) === "resolved") {
      addAction("Reopen", "reopen", true);
    } else {
      if (!handler) addAction("Assign to me", "assign", true);
      else if (handler === currentUser?.uid) addAction("Release", "release");
      else addAction("Take over", "take", true);
      addAction("Mark resolved", "resolve");
    }
  }

  if (roomStatus(room) !== "resolved") {
    const state = medicalChatStatus(room);
    const isAssignedVet = room.escalatedVetId === currentUser?.uid;
    if (["admin", "staff"].includes(currentRole) &&
      state !== "ESCALATED") {
      addAction("Escalate to Vet", "escalate", true);
    } else if (state === "ESCALATED" &&
      (["admin", "staff"].includes(currentRole) ||
        (isVeterinarian() && isAssignedVet))) {
      addAction("Transfer to Front Desk", "transfer-frontdesk");
      addAction("Resolve Medical Inquiry", "resolve-medical");
    }
  }

  if (actions.childElementCount) headerActions.prepend(actions);
}

async function persistRoomPatch(patch, action) {
  if (!currentRoomId || !currentUser) return;
  const roomRef = doc(db, "chatRooms", currentRoomId);
  const auditRef = doc(collection(db, "chatRooms", currentRoomId, "assignmentHistory"));
  const batch = writeBatch(db);
  batch.set(roomRef, patch, { merge: true });
  batch.set(auditRef, { action, actorId: currentUser.uid, actorRole: currentRole, createdAt: serverTimestamp(), ...patch });
  await batch.commit();
  currentRoom = { ...currentRoom, ...patch };
  allRooms = allRooms.map((entry) =>
    entry.id === currentRoomId
      ? { ...entry, room: { ...entry.room, ...patch } }
      : entry
  );
  updateResolvedAttentionIndicator();
  renderRoomActions(currentRoom);
  renderRooms();
  updateComposerForRoom();
}

async function handleRoomAction(action) {
  if (!currentRoom) return;
  try {
    if (action === "escalate") {
      await showEscalationVetPicker();
    } else if (action === "transfer-frontdesk") {
      await updateMedicalChatStatus("STANDARD");
    } else if (action === "resolve-medical") {
      await updateMedicalChatStatus("RESOLVED");
    } else if (action === "assign" || action === "take") {
      const profile = await getUserProfileSnapshot(currentUser);
      const data = profile.exists() ? profile.data() : {};
      await persistRoomPatch({ handlerId: currentUser.uid, handlerName: data.fullName || data.displayName || currentUser.displayName || "Clinic staff", handlerRole: currentRole, status: "open" }, action);
    } else if (action === "release") {
      await persistRoomPatch({ handlerId: null, handlerName: null, handlerRole: null }, action);
    } else if (action === "resolve") {
      await persistRoomPatch({ status: "resolved", resolvedAt: serverTimestamp(), resolvedBy: currentUser.uid }, action);
    } else if (action === "reopen") {
      await persistRoomPatch({
        status: "open",
        needsStaffAttention: false,
        reopenedAt: serverTimestamp(),
        reopenedBy: currentUser.uid
      }, action);
    }
  } catch (error) {
    console.error("Could not update conversation:", error);
    window.alert(
      `Could not update this conversation: ${error.message || "Check your permissions."}`
    );
  }
}

async function showEscalationVetPicker() {
  if (!escalationVetSelect || !escalationVetConfirm || !escalationVetModal) {
    throw new Error("The veterinarian selection dialog is unavailable.");
  }
  if (!window.bootstrap?.Modal) {
    throw new Error("The veterinarian selection dialog could not be opened.");
  }

  escalationVetError.hidden = true;
  escalationVetSelect.replaceChildren();
  escalationVetConfirm.disabled = true;
  escalationVetSelect.add(new Option("Loading active veterinarians...", ""));
  window.bootstrap.Modal.getOrCreateInstance(escalationVetModal).show();

  let vetsSnapshot;
  try {
    vetsSnapshot = await getDocs(
      query(
        collection(db, "users"),
        where("role", "in", ["vet", "veterinarian"])
      )
    );
  } catch (error) {
    console.error("Could not load active veterinarians:", error);
    escalationVetSelect.replaceChildren(
      new Option("Could not load veterinarians", "")
    );
    escalationVetError.textContent =
      "Could not load veterinarians. Check Firestore access and try again.";
    escalationVetError.hidden = false;
    return;
  }
  const vets = vetsSnapshot.docs
    .map((vetDoc) => ({ id: vetDoc.id, ...vetDoc.data() }))
    .filter((vet) => !vet.status || ["active", "Active"].includes(vet.status))
    .map((vet) => ({
      id: vet.id,
      name: vet.fullName || vet.displayName || vet.name || vet.email || "Veterinarian"
    }))
    .sort((first, second) => first.name.localeCompare(second.name));

  escalationVetSelect.replaceChildren();
  if (!vets.length) {
    escalationVetSelect.add(new Option("No active veterinarians found", ""));
    escalationVetError.textContent = "Activate a veterinarian account before escalating this chat.";
    escalationVetError.hidden = false;
    return;
  }

  escalationVetSelect.add(new Option("Choose a veterinarian", ""));
  vets.forEach((vet) => {
    escalationVetSelect.add(new Option(vet.name, vet.id));
  });
  escalationVetConfirm.disabled = false;

  escalationVetConfirm.onclick = async () => {
    const vet = vets.find((candidate) =>
      candidate.id === escalationVetSelect.value
    );
    if (!vet) {
      escalationVetError.textContent = "Choose a veterinarian.";
      escalationVetError.hidden = false;
      return;
    }

    escalationVetConfirm.disabled = true;
    escalationVetError.hidden = true;
    try {
      await updateMedicalChatStatus("ESCALATED", vet);
      window.bootstrap.Modal.getOrCreateInstance(escalationVetModal).hide();
    } catch (error) {
      console.error("Could not escalate conversation:", error);
      escalationVetError.textContent = error.message ||
        "Could not escalate this conversation. Please try again.";
      escalationVetError.hidden = false;
    } finally {
      escalationVetConfirm.disabled = false;
    }
  };
}

async function updateMedicalChatStatus(nextStatus, vet = null) {
  if (!currentUser || !currentRoomId || !currentRoom) {
    throw new Error("Select a conversation before changing its medical status.");
  }

  if (
    !["admin", "staff"].includes(currentRole) &&
    !(isVeterinarian() &&
      currentRoom.escalatedVetId === currentUser.uid &&
      medicalChatStatus(currentRoom) === "ESCALATED")
  ) {
    throw new Error("You are not allowed to change this conversation's medical status.");
  }
  if (nextStatus === "ESCALATED" && !vet) {
    throw new Error("Choose an active veterinarian.");
  }

  const roomId = currentRoomId;
  const roomRef = doc(db, "chatRooms", roomId);
  const eventRef = doc(collection(db, "chatRooms", roomId, "messages"));
  const notificationRef = nextStatus === "ESCALATED"
    ? doc(collection(db, "notifications"))
    : null;
  const actorProfile = await getUserProfileSnapshot(currentUser);
  const actorData = actorProfile.exists() ? actorProfile.data() : {};
  const actorName = actorData.fullName || actorData.displayName ||
    currentUser.displayName || "Clinic staff";

  await runTransaction(db, async (transaction) => {
    const roomSnapshot = await transaction.get(roomRef);
    if (!roomSnapshot.exists()) {
      throw new Error("This conversation no longer exists.");
    }

    const room = roomSnapshot.data();
    const oldStatus = medicalChatStatus(room);
    if (oldStatus === nextStatus) {
      throw new Error("This conversation already has that medical status.");
    }
    if (nextStatus === "ESCALATED" &&
      !["STANDARD", "RESOLVED"].includes(oldStatus)) {
      throw new Error("Only standard or resolved conversations can be escalated.");
    }
    if (nextStatus !== "ESCALATED" && oldStatus !== "ESCALATED") {
      throw new Error("Only escalated conversations can be transferred or resolved.");
    }

    const doctorName = vet && /^dr\.?\s/i.test(vet.name)
      ? vet.name
      : vet
        ? `Dr. ${vet.name}`
        : "";
    const eventText = nextStatus === "ESCALATED"
      ? `Your chat has been flagged for a Veterinarian. ${doctorName} has been notified and will reply as soon as they complete their current patient exam.`
      : nextStatus === "STANDARD"
        ? "This conversation has been transferred back to the front desk. You can continue chatting with clinic staff."
        : "The medical inquiry has been resolved. You can continue chatting with clinic staff.";
    const timestamp = serverTimestamp();

    transaction.update(roomRef, {
      chat_status: nextStatus,
      chatStatusUpdatedAt: timestamp,
      chatStatusUpdatedBy: currentUser.uid,
      lastMessage: eventText,
      lastMessageAt: timestamp,
      lastMessageInternal: false,
      ...(vet && {
        escalatedVetId: vet.id,
        escalatedVetName: vet.name
      })
    });
    transaction.set(eventRef, {
      senderId: currentUser.uid,
      senderName: actorName,
      senderRole: currentRole,
      sender_role: currentRole,
      sender_type: "clinic",
      type: "text",
      kind: "chat_status_event",
      event: nextStatus,
      text: eventText,
      body: eventText,
      createdAt: timestamp,
      read: false
    });

    if (notificationRef && vet) {
      transaction.set(notificationRef, {
        userId: vet.id,
        title: "Veterinarian consultation requested",
        message: `A conversation has been escalated to you by ${actorName}.`,
        type: "VET_CHAT_ESCALATION",
        targetScreen: "CHAT",
        targetId: roomId,
        sourceMessageId: eventRef.id,
        isRead: false,
        createdAtMillis: Date.now(),
        timestamp: new Date().toLocaleString(),
        createdAt: timestamp
      });
    }
  });

  currentRoom = {
    ...currentRoom,
    chat_status: nextStatus,
    chatStatusUpdatedBy: currentUser.uid,
    ...(vet && {
      escalatedVetId: vet.id,
      escalatedVetName: vet.name
    })
  };
  renderRoomActions(currentRoom);
  updateComposerForRoom();
  renderRooms();
  updateEscalatedChatCount();
}

function updateComposerForRoom() {
  const resolved = roomStatus(currentRoom || {}) === "resolved";
  const canWrite = canWriteCurrentChat();
  const area = document.querySelector(".chat-input-area");
  if (!area) return;
  area.hidden = resolved || (isVeterinarian() && !canWrite);
  document.querySelector(".chat-resolved-notice")?.remove();
  if (resolved || (isVeterinarian() && !canWrite && currentRoom)) {
    const notice = document.createElement("div");
    notice.className = "chat-resolved-notice";
    notice.textContent = resolved
      ? "This conversation is resolved."
      : medicalChatStatus(currentRoom) === "RESOLVED"
        ? "The medical inquiry is resolved. You can still review this conversation."
        : "This conversation is read-only for veterinarians until it is escalated.";
    area.parentElement?.appendChild(notice);
  }
  setComposerEnabled(!resolved && canWrite && Boolean(currentRoomOwnerId));
}

function beginPresence(roomId) {
  unsubscribePresence?.();
  unsubscribePresence = null;
  if (presenceTimer) clearInterval(presenceTimer);
  presenceTimer = null;
  document.querySelector(".chat-presence")?.remove();
  if (isVeterinarian()) return;

  const presenceRef = doc(db, "chatRooms", roomId, "presence", currentUser.uid);
  const heartbeat = () => setDoc(presenceRef, { userId: currentUser.uid, name: currentUser.displayName || "Clinic staff", role: currentRole, lastSeen: serverTimestamp() }, { merge: true }).catch(() => {});
  heartbeat();
  presenceTimer = setInterval(heartbeat, 30000);
  unsubscribePresence = onSnapshot(collection(db, "chatRooms", roomId, "presence"), (snapshot) => {
    const viewer = snapshot.docs.map((item) => item.data()).find((item) => item.userId !== currentUser.uid);
    document.querySelector(".chat-presence")?.remove();
    if (!viewer || !chatBox?.parentElement) return;
    const bar = document.createElement("div");
    bar.className = "chat-presence";
    bar.textContent = `${viewer.name || "Another staff member"} is viewing this conversation`;
    chatBox.parentElement.insertBefore(bar, chatBox);
  });
}

// ========================================
// MESSAGE SELECTION CONTROLS
// ========================================

function canManageMessages() {
  return ["admin", "staff"].includes(currentRole);
}

function createMessageAdminControls() {
  if (
    !canManageMessages() ||
    !chatBox ||
    messageAdminToolbar
  ) {
    return;
  }

  messageAdminToolbar = document.createElement("div");
  messageAdminToolbar.className = "chat-admin-message-controls";

  Object.assign(messageAdminToolbar.style, {
    display: "none",
    alignItems: "center",
    gap: "8px",
  });

  function makeAdminButton(iconName, label, title, color) {
    const button = document.createElement("button");

    button.type = "button";
    button.title = title;
    button.setAttribute("aria-label", title);

    Object.assign(button.style, {
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      gap: "6px",
      padding: "7px 11px",
      border: `1px solid ${color}`,
      borderRadius: "6px",
      background: "#fff",
      color,
      fontSize: "13px",
      cursor: "pointer"
    });

    const icon = document.createElement("i");
    icon.className = `bi ${iconName}`;
    icon.setAttribute("aria-hidden", "true");

    button.appendChild(icon);

    if (label) {
      button.appendChild(
        document.createTextNode(` ${label}`)
      );
    }

    return button;
  }

  // Pen button toggles message selection mode.
  editMessagesButton = makeAdminButton(
    "bi-pencil-square",
    "",
    "Select messages to delete",
    "#dc3545"
  );
  editMessagesButton.className = "chat-edit-messages";
  editMessagesButton.style.cssText = "";
  headerActions?.appendChild(editMessagesButton);

  editMessagesButton.addEventListener("click", () => {
    if (isDeletingMessages) return;

    selectionMode = !selectionMode;
    selectedMessageIds.clear();

    renderMessageSelectionControls();
  });

  selectedMessagesCount = document.createElement("span");
  selectedMessagesCount.className = "chat-selected-count";

  deleteSelectedMessagesButton = makeAdminButton(
    "bi-trash",
    "Delete",
    "Delete selected messages",
    "#dc3545"
  );
  deleteSelectedMessagesButton.className = "chat-selection-delete";
  deleteSelectedMessagesButton.style.cssText = "";

  deleteSelectedMessagesButton.addEventListener(
    "click",
    deleteSelectedMessages
  );

  cancelMessageSelectionButton = makeAdminButton(
    "bi-x-lg",
    "Cancel",
    "Cancel message selection",
    "#6b7280"
  );
  cancelMessageSelectionButton.className = "chat-selection-cancel";
  cancelMessageSelectionButton.style.cssText = "";

  cancelMessageSelectionButton.addEventListener("click", () => {
    if (isDeletingMessages) return;

    selectionMode = false;
    selectedMessageIds.clear();

    renderMessageSelectionControls();
  });

  messageAdminToolbar.append(
    selectedMessagesCount,
    cancelMessageSelectionButton,
    deleteSelectedMessagesButton
  );

  headerActions?.appendChild(messageAdminToolbar);

  updateMessageAdminControls();
}

function renderMessageSelectionControls() {
  if (!canManageMessages()) return;

  chatBox?.classList.toggle(
    "message-selection-mode",
    selectionMode
  );

  renderCurrentMessageCheckboxes();
  updateMessageAdminControls();
}

function renderCurrentMessageCheckboxes() {
  if (!chatBox || !canManageMessages()) return;

  chatBox
    .querySelectorAll(".message-select-checkbox")
    .forEach((checkbox) => checkbox.remove());

  if (!selectionMode) return;

  chatBox
    .querySelectorAll(".message-row[data-message-id]")
    .forEach((row) => {
      const messageId = row.dataset.messageId;

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.className = "message-select-checkbox";
      checkbox.checked = selectedMessageIds.has(messageId);
      checkbox.disabled = isDeletingMessages;

      checkbox.setAttribute(
        "aria-label",
        "Select message"
      );

      row.classList.toggle("is-selected", checkbox.checked);

      checkbox.addEventListener("change", () => {
        row.classList.toggle("is-selected", checkbox.checked);

        if (checkbox.checked) {
          selectedMessageIds.add(messageId);
        } else {
          selectedMessageIds.delete(messageId);
        }

        updateMessageAdminControls();
      });

      row.insertBefore(checkbox, row.firstChild);
    });
}

function updateMessageAdminControls() {
  if (
    !messageAdminToolbar ||
    !canManageMessages()
  ) {
    return;
  }

  // Only count IDs that still exist in the current conversation.
  for (const id of selectedMessageIds) {
    if (!currentMessages.has(id)) {
      selectedMessageIds.delete(id);
    }
  }

  messageAdminToolbar.style.display = selectionMode ? "flex" : "none";
  editMessagesButton.style.display = selectionMode ? "none" : "inline-grid";
  selectedMessagesCount.style.display =
    selectionMode ? "inline" : "none";

  selectedMessagesCount.textContent =
    `${selectedMessageIds.size} selected`;

  editMessagesButton.disabled = isDeletingMessages;

  deleteSelectedMessagesButton.disabled =
    isDeletingMessages || selectedMessageIds.size === 0;

  cancelMessageSelectionButton.disabled = isDeletingMessages;

  deleteSelectedMessagesButton.style.opacity =
    deleteSelectedMessagesButton.disabled ? "0.55" : "1";
}

// ========================================
// DELETE SELECTED MESSAGES: ADMIN AND STAFF
// ========================================

async function deleteSelectedMessages() {
  if (
    !canManageMessages() ||
    !currentUser ||
    !currentRoomId ||
    isDeletingMessages
  ) {
    return;
  }

  const roomId = currentRoomId;

  const ids = [...selectedMessageIds].filter((id) =>
    currentMessages.has(id)
  );

  if (!ids.length) {
    window.alert("Select at least one message to delete.");
    return;
  }

  const confirmed = await window.SkinPawsibleDialogs.confirm(
    `Are you sure you want to delete ${ids.length} selected message(s)? This cannot be undone.`,
    { title: "Delete messages?", confirmText: "Delete", tone: "danger" }
  );

  if (!confirmed) return;

  isDeletingMessages = true;
  updateMessageAdminControls();

  try {
    // Recheck the management role before deleting anything.
    const profileSnapshot = await getDoc(
      doc(db, "users", currentUser.uid)
    );

    const profile = profileSnapshot.exists()
      ? profileSnapshot.data()
      : {};

    const verifiedRole = String(profile.role || "")
      .trim()
      .toLowerCase();

    if (!["admin", "staff"].includes(verifiedRole)) {
      currentRole = "";
      throw new Error(
        "Admin or staff permission is required to delete messages."
      );
    }

    // Delete associated Firebase Storage files when possible.
    for (const id of ids) {
      const message = currentMessages.get(id);

      if (
        message?.fileUrl &&
        message.fileUrl.includes("firebasestorage.googleapis.com")
      ) {
        try {
          await deleteObject(
            ref(storage, message.fileUrl)
          );
        } catch (error) {
          // Continue deleting the Firestore message if the file
          // is already missing or Storage denies deletion.
          console.warn(
            `Could not delete attachment for message ${id}:`,
            error
          );
        }
      }
    }

    // Firestore batches allow up to 500 writes.
    for (let index = 0; index < ids.length; index += 450) {
      const batch = writeBatch(db);

      ids.slice(index, index + 450).forEach((id) => {
        batch.delete(
          doc(db, "chatRooms", roomId, "messages", id)
        );
      });

      await batch.commit();
    }

    // Remove deleted IDs from the local selection.
    ids.forEach((id) => selectedMessageIds.delete(id));

    // Update the conversation preview based on remaining messages.
    const remainingSnapshot = await getDocs(
      query(
        collection(db, "chatRooms", roomId, "messages"),
        orderBy("createdAt", "desc")
      )
    );

    const roomRef = doc(db, "chatRooms", roomId);

    const latestPublicMessage = remainingSnapshot.docs.find(
      (messageDocument) =>
        mapMessageForDisplay(messageDocument.data()).k !== "n"
    );

    if (!latestPublicMessage) {
      await updateDoc(roomRef, {
        lastMessage: "",
        lastMessageAt: null,
        lastMessageInternal: false
      });
    } else {
      const latestMessage = latestPublicMessage.data();

      await updateDoc(roomRef, {
        lastMessage: latestMessage.text || "",
        lastMessageAt: latestMessage.createdAt || null,
        lastMessageInternal: false
      });
    }

    selectionMode = false;
    selectedMessageIds.clear();

  } catch (error) {
    console.error(
      "Failed to delete selected messages:",
      error
    );

    window.alert(
      error.message ||
      "Could not delete the selected messages. Contact your IT Administrator."
    );
  } finally {
    isDeletingMessages = false;

    if (currentRoomId === roomId) {
      renderMessageSelectionControls();
    }
  }
}

// ========================================
// AUTH
// ========================================

onAuthStateChangedWithRole(async (user) => {
  if (!user) {
    window.location.href = "login.html";
    return;
  }

  currentUser = user;

  const userName = $("userName");
  const userEmail = $("userEmail");
  const userInitial = $("userInitial");

  if (userName) {
    userName.textContent = user.displayName || "User";
  }

  if (userEmail) {
    userEmail.textContent = user.email || "";
  }

  if (userInitial) {
    userInitial.textContent = initialOf(
      user.displayName || user.email || "U"
    );
  }

  try {
    // The login flow and auth provider attach this role before navigation.
    // Only fall back to Firestore for sessions created before the cache.
    currentRole = getAuthUserRole(user);

    if (!currentRole) {
      const profileSnapshot = await getDoc(doc(db, "users", user.uid));
      const profile = profileSnapshot.exists()
        ? profileSnapshot.data()
        : {};
      currentRole = String(profile.role || "").trim().toLowerCase();
    }

    if (!["admin", "staff", "vet", "veterinarian"].includes(currentRole)) {
      window.location.replace("users.html");
      return;
    }

    if (redirectSuperadminFromSensitivePage(user, currentRole)) return;
    configureRoleControls();

    if (canManageMessages()) {
      createMessageAdminControls();
    }

    listenForAppointmentStatuses();
    listenForRooms();

  } catch (error) {
    console.error(
      "Could not verify account role:",
      error
    );

    // Fail closed: do not display admin controls.
    currentRole = "";

    window.location.replace("dashboard.html");
  }
});

function listenForAppointmentStatuses() {
  unsubscribeAppointmentStatuses?.();

  unsubscribeAppointmentStatuses = onSnapshot(
    collection(db, "consultations"),
    (snapshot) => {
      appointmentStatuses.clear();

      snapshot.forEach((appointmentDoc) => {
        const appointment = appointmentDoc.data();
        const sourceRoomId = appointment.sourceRoomId;
        const petName = appointment.petName || appointment.pet || "";
        if (sourceRoomId && petName && !roomPetNameCache.has(sourceRoomId)) {
          roomPetNameCache.set(sourceRoomId, petName);
        }
        const ownerId =
          appointment.userId ||
          appointment.ownerId ||
          appointment.petOwnerId ||
          "";
        const preferredDate =
          appointment.preferredDate ||
          appointment.date ||
          "";
        const preferredTime =
          appointment.preferredTime ||
          appointment.time ||
          "";
        const key = appointmentStatusKey(
          ownerId,
          petName,
          preferredDate,
          preferredTime
        );

        if (key) {
          appointmentStatuses.set(
            key,
            String(appointment.status || "Pending")
          );
        }
      });

      updateVisibleAppointmentStatuses();
      renderRooms();
      if (currentRoom && headerSub) {
        headerSub.textContent = `Pet owner · Pet: ${getRoomPetName(currentRoom, currentRoomId)} · Handled by ${handlerDisplay(currentRoom)}`;
      }
    },
    (error) => {
      console.error("Could not load appointment statuses for chat:", error);
    }
  );
}

function appointmentStatusKey(ownerId, petName, dateValue, timeValue) {
  if (!ownerId || !petName || !dateValue) return "";

  let date = dateValue;
  let time = timeValue;

  if (!time) {
    const dateAndTime = String(dateValue).match(
      /^(.+?)\s+at\s+(.+)$/i
    );
    if (dateAndTime) {
      date = dateAndTime[1];
      time = dateAndTime[2];
    }
  }

  const dateKey = appointmentDateKey(date);
  if (!dateKey) return "";

  return [
    String(ownerId).trim(),
    String(petName).trim().toLowerCase(),
    dateKey,
    appointmentTimeKey(time)
  ].join("|");
}

function updateVisibleAppointmentStatuses() {
  chatBox?.querySelectorAll(".appointment-card[data-appointment-key], .appointment-message[data-appointment-key]")
    .forEach((card) => {
      const status = card.querySelector(".appointment-card-status");
      const value = appointmentStatuses.get(card.dataset.appointmentKey);
      if (card.dataset.appointmentSender === "clinic" && value && ["approved", "confirmed", "cancelled", "canceled"].includes(String(value).toLowerCase())) {
        convertAppointmentCardToMessage(card, value);
      } else if (status && value) {
        setAppointmentStatusLabel(status, value);
        const title = card.querySelector(".appointment-card-title");
        if (title?.firstChild && card.dataset.appointmentSender === "clinic") {
          const normalized = String(value).toLowerCase();
          title.firstChild.textContent = normalized.includes("cancel")
            ? "Appointment Cancelled"
            : normalized.includes("approv") || normalized.includes("confirm")
              ? "Appointment Approved"
              : "Appointment Request";
        }
      }
    });
}

function convertAppointmentCardToMessage(card, statusValue) {
  const values = [...card.querySelectorAll(".appointment-card-value")];
  const petName = card.dataset.appointmentPet || values[0]?.textContent?.trim() || "your pet";
  const schedule = card.dataset.appointmentStatusSchedule ||
    card.dataset.appointmentSchedule ||
    values[1]?.textContent?.trim() ||
    "the requested time";
  const reason = card.dataset.cancelReason || card.querySelector(".appointment-cancel-reason")?.textContent?.replace(/^Reason for cancellation\s*/i, "").trim() || "";
  const normalized = String(statusValue).toLowerCase();
  const cancelled = normalized.includes("cancel");
  card.classList.remove("appointment-card");
  card.classList.add("appointment-message");
  card.dataset.appointmentState = cancelled ? "cancelled" : "approved";
  card.dataset.appointmentPet = petName;
  card.dataset.appointmentSchedule = schedule;
  card.dataset.cancelReason = reason;
  card.replaceChildren();
  const sentence = document.createElement("div");
  sentence.className = "appointment-message-text";
  sentence.textContent = `Your appointment request for ${petName} on ${schedule} has been ${cancelled ? (reason ? `cancelled due to ${reason}` : "cancelled") : "approved"}.`;
  card.appendChild(sentence);
  card.closest(".message-bubble")?.classList.remove("is-appointment");
}

function setAppointmentStatusLabel(element, value) {
  const rawStatus = String(value || "Pending").trim();
  const normalizedStatus = rawStatus.toLowerCase();
  const statusValue = {
    approved: "Approved",
    confirmed: "Approved",
    pending: "Pending",
    completed: "Completed",
    cancelled: "Cancelled",
    canceled: "Cancelled"
  }[normalizedStatus] || rawStatus;
  element.className =
    "appointment-card-status " +
    `is-${statusValue.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  element.textContent = statusValue;
}

// ========================================
// CONVERSATION LIST
// ========================================

function listenForRooms() {
  if (!usersList) return;

  unsubscribeRooms?.();
  const snapshots = new Map();
  const roomQueries = isVeterinarian()
    ? [
      ["standard", query(
        collection(db, "chatRooms"),
        where("chat_status", "==", "STANDARD")
      )],
      ["escalated", query(
        collection(db, "chatRooms"),
        where("chat_status", "==", "ESCALATED"),
        where("escalatedVetId", "==", currentUser.uid)
      )],
      ["medical-resolved", query(
        collection(db, "chatRooms"),
        where("chat_status", "==", "RESOLVED"),
        where("escalatedVetId", "==", currentUser.uid)
      )]
    ]
    : [["all", collection(db, "chatRooms")]];

  unsubscribeRooms = () => {
    roomUnsubscribers.forEach((unsubscribe) => unsubscribe());
    roomUnsubscribers = [];
  };

  roomUnsubscribers = roomQueries.map(([key, roomQuery]) =>
    onSnapshot(
      roomQuery,
      (snapshot) => {
        snapshots.set(key, new Map(
          snapshot.docs.map((document) => [
            document.id,
            { id: document.id, room: document.data() }
          ])
        ));
        const roomsById = new Map();
        snapshots.forEach((group) => group.forEach((room, id) => {
          roomsById.set(id, room);
        }));
        allRooms = [...roomsById.values()].sort(compareRoomActivity);
        syncUnreadMessageListeners();
        updateResolvedAttentionIndicator();

        const liveRoom = allRooms.find(({ id }) => id === currentRoomId);
        if (liveRoom) {
          currentRoom = liveRoom.room;
          renderRoomActions(currentRoom);
          updateComposerForRoom();
          if (headerSub) headerSub.textContent = `Pet owner · Pet: ${getRoomPetName(currentRoom, currentRoomId)} · Handled by ${handlerDisplay(currentRoom)}`;
        }

        renderRooms();
        updateEscalatedChatCount();
        openRequestedRoom();
      },
      (error) => {
        console.error(`Could not load ${key} conversations:`, error);
        usersList.replaceChildren(
          statusEl("Could not load conversations. Check Firestore permissions.")
        );
      }
    )
  );
}

function updateEscalatedChatCount() {
  const tab = document.querySelector('[data-chat-filter="escalated"]');
  if (!tab) return;
  const count = allRooms.filter(({ room }) =>
    medicalChatStatus(room) === "ESCALATED" &&
    room.escalatedVetId === currentUser?.uid
  ).length;
  tab.textContent = `Escalated to me${count ? ` (${count})` : ""}`;
}

function updateResolvedAttentionIndicator() {
  if (!resolvedFilterButton || !resolvedUnreadIndicator) return;

  const hasResolvedRoomNeedingAttention = allRooms.some(({ room }) =>
    roomStatus(room) === "resolved" && room.needsStaffAttention === true
  );
  resolvedUnreadIndicator.hidden = !hasResolvedRoomNeedingAttention;
  resolvedFilterButton.title = hasResolvedRoomNeedingAttention
    ? "Resolved conversations need staff attention"
    : "Resolved conversations";
  resolvedFilterButton.setAttribute(
    "aria-label",
    hasResolvedRoomNeedingAttention
      ? "Resolved conversations, includes conversations needing staff attention"
      : "Resolved conversations"
  );
}

function getRoomActivityMillis(roomId, room) {
  const roomActivity = Math.max(
    toMillis(room.lastMessageAt),
    toMillis(room.lastUpdatedAt),
    toMillis(room.updatedAt)
  );
  return Math.max(roomActivity, unreadRoomMessages.get(roomId) || 0);
}

function compareRoomActivity(first, second) {
  return getRoomActivityMillis(second.id, second.room) -
    getRoomActivityMillis(first.id, first.room);
}

function isOwnerAuthoredMessage(message, room) {
  const ownerAliases = new Set(["owner", "petowner", "customer", "user", "petparent", "petparentuser"]);
  const clinicAliases = new Set(["admin", "clinic", "staff", "vet", "veterinarian", "webadmin", "webstaff"]);
  const senderValues = [
    message.sender_type,
    message.senderType,
    message.sender_role,
    message.senderRole,
    message.author_type,
    message.authorType,
    message.author_role,
    message.authorRole,
    message.from_type,
    message.fromType,
    message.from_role,
    message.fromRole
  ].filter((value) => typeof value === "string")
    .map((value) => value.trim().toLowerCase().replace(/[^a-z0-9]/g, ""));

  if (senderValues.some((value) => ownerAliases.has(value))) return true;
  if (senderValues.some((value) => clinicAliases.has(value))) return false;

  const senderId = message.senderId || message.sender_id ||
    message.authorId || message.author_id;
  const ownerId = getRoomOwnerId(room || {});
  return Boolean(senderId && ownerId && senderId === ownerId);
}

function syncUnreadMessageListeners() {
  const activeRoomIds = new Set(allRooms.map(({ id }) => id));

  unsubscribeUnreadMessages.forEach((unsubscribe, roomId) => {
    if (activeRoomIds.has(roomId)) return;
    unsubscribe();
    unsubscribeUnreadMessages.delete(roomId);
    unreadRoomMessages.delete(roomId);
  });

  allRooms.forEach(({ id, room }) => {
    if (unsubscribeUnreadMessages.has(id)) return;

    const unreadQuery = query(
      collection(db, "chatRooms", id, "messages"),
      where("read", "==", false)
    );
    const unsubscribe = onSnapshot(
      unreadQuery,
      (snapshot) => {
        let latestUnreadTime = 0;
        let hasUnreadOwnerMessage = false;
        snapshot.docs.forEach((messageDocument) => {
          const message = messageDocument.data();
          const currentRoom = allRooms.find((entry) => entry.id === id)?.room ||
            room;
          if (!isOwnerAuthoredMessage(message, currentRoom)) return;
          hasUnreadOwnerMessage = true;
          latestUnreadTime = Math.max(
            latestUnreadTime,
            toMillis(
              message.createdAt || message.timestamp || message.createdAtMillis
            )
          );
        });

        if (hasUnreadOwnerMessage) {
          unreadRoomMessages.set(id, latestUnreadTime);
        } else {
          unreadRoomMessages.delete(id);
        }

        allRooms.sort(compareRoomActivity);
        updateResolvedAttentionIndicator();
        renderRooms();
      },
      (error) => {
        console.error(
          `Could not load unread messages for consultation ${id}:`,
          error
        );
      }
    );
    unsubscribeUnreadMessages.set(id, unsubscribe);
  });
}

function statusEl(text) {
  const div = document.createElement("div");
  div.className = "chat-list-status";
  div.textContent = text;
  return div;
}

function renderRooms() {
  const term = (searchInput?.value || "")
    .trim()
    .toLowerCase();

  const started = allRooms.filter(
    ({ room }) => room.lastMessage
  );

  const rooms = started.filter(({ room }) => {
    const status = roomStatus(room);
    const handlerId = handlerIdOf(room);
    const medicalStatus = medicalChatStatus(room);
    if (isVeterinarian()) {
      if (conversationFilter === "escalated" &&
        (medicalStatus !== "ESCALATED" ||
          room.escalatedVetId !== currentUser?.uid)) return false;
      if (conversationFilter === "standard" &&
        medicalStatus !== "STANDARD") return false;
      if (conversationFilter === "medical-resolved" &&
        (medicalStatus !== "RESOLVED" ||
          room.escalatedVetId !== currentUser?.uid)) return false;
    } else {
      if (conversationFilter === "open" && status !== "open") return false;
      if (conversationFilter === "resolved" && status !== "resolved") return false;
      if (conversationFilter === "mine" && (status !== "open" || handlerId !== currentUser?.uid)) return false;
      if (conversationFilter === "unassigned" && (status !== "open" || handlerId)) return false;
    }
    if (!term) return true;

    const ownerId = getRoomOwnerId(room);
    const name = (
      ownerNameCache.get(ownerId) ||
      getRoomName(room)
    ).toLowerCase();

    const matches = (
      name.includes(term) ||
      (room.lastMessage || "").toLowerCase().includes(term)
    );

    if (
      !matches &&
      conversationFilter === "resolved" &&
      !room.ownerName &&
      !room.petOwnerName &&
      !room.ownerFullName &&
      ownerId &&
      !ownerNameSearchAttempts.has(ownerId)
    ) {
      ownerNameSearchAttempts.add(ownerId);
      getOwnerName(room).then(() => {
        if (
          conversationFilter === "resolved" &&
          (searchInput?.value || "").trim().toLowerCase() === term
        ) {
          renderRooms();
        }
      });
    }

    return matches;
  });

  if (!started.length) {
    usersList.replaceChildren(
      statusEl("No conversations yet.")
    );
    return;
  }

  if (!rooms.length) {
    usersList.replaceChildren(statusEl("No conversations here. Try another filter."));
    return;
  }

  const fragment = document.createDocumentFragment();

  rooms.forEach(({ id, room }) => {
    const item = document.createElement("button");

    item.type = "button";
    item.className =
      "chat-user" + (id === currentRoomId ? " active" : "");

    item.dataset.roomId = id;

    const initialName = firstNameOf(
      ownerNameCache.get(getRoomOwnerId(room)) ||
      getRoomName(room)
    );

    const avatar = document.createElement("div");
    avatar.className = "chat-avatar";
    avatar.textContent = initialOf(initialName);

    const body = document.createElement("div");
    body.className = "chat-user-body";

    const top = document.createElement("div");
    top.className = "chat-user-top";

    const name = document.createElement("div");
    name.className = "chat-user-name";
    name.textContent = initialName;

    const time = document.createElement("div");
    time.className = "chat-user-time";
    time.textContent = formatListTime(
      Math.max(
        toMillis(room.lastMessageAt),
        toMillis(room.lastUpdatedAt),
        toMillis(room.updatedAt),
        unreadRoomMessages.get(id) || 0
      )
    );

    const preview = document.createElement("div");
    preview.className = "chat-user-preview";
    preview.textContent = getMessagePreview(room.lastMessage);

    top.append(name, time);
    body.append(top, preview);
    const metadata = document.createElement("div");
    metadata.className = "chat-user-meta";
    const handler = handlerIdOf(room);
    const tag = document.createElement("span");
    tag.className = `chat-room-tag ${roomStatus(room) === "resolved" ? "resolved" : handler ? "assigned" : "unassigned"}`;
    tag.textContent = roomStatus(room) === "resolved"
      ? "Resolved"
      : handler
        ? (room.handlerName || "Assigned")
        : "Unassigned";
    metadata.append(tag);
    body.append(metadata);
    item.append(avatar, body);
    if (
      room.unread === true ||
      Number(room.unreadCount) > 0 ||
      unreadRoomMessages.has(id)
    ) {
      const dot = document.createElement("span");
      dot.className = "chat-unread-dot";
      dot.title = "Unread message needs attention";
      dot.setAttribute("aria-label", "Unread message needs attention");
      item.appendChild(dot);
    }

    item.addEventListener("click", () => {
      openChat(id, room);
    });

    fragment.appendChild(item);

    getOwnerName(room).then((ownerName) => {
      if (name.isConnected) {
        name.textContent = firstNameOf(ownerName);
      }

      if (avatar.isConnected) {
        avatar.textContent = initialOf(firstNameOf(ownerName));
      }

      if (currentRoomId === id) {
        setHeader(ownerName);
      }
    });
  });

  usersList.replaceChildren(fragment);
}

function updateComposeMode() {
  if (composeLegend) {
    composeLegend.textContent = currentUser
      ? `You'll send as ${currentUser.displayName || "Clinic staff"} · ${roleLabel(currentRole)}`
      : "You'll send as clinic staff";
  }
  if (messageInput) {
    messageInput.placeholder = currentRoomId
      ? "Type your message..."
      : "Select a conversation to write a message";
  }
}

chatFilterButtons.forEach((button) => {
  button.addEventListener("click", () => {
    conversationFilter = button.dataset.chatFilter || "all";
    chatFilterButtons.forEach((item) => {
      const active = item === button;
      item.classList.toggle("is-active", active);
      item.setAttribute("aria-selected", String(active));
    });
    renderRooms();
  });
});

function configureRoleControls() {
  const veterinarian = isVeterinarian();
  if (newChatButton) newChatButton.hidden = veterinarian;
  chatFilterButtons.forEach((button) => {
    const isVetFilter = ["escalated", "standard", "medical-resolved"]
      .includes(button.dataset.chatFilter);
    button.hidden = veterinarian ? !isVetFilter : isVetFilter;
  });
  if (veterinarian) {
    conversationFilter = "escalated";
    chatFilterButtons.forEach((button) => {
      const active = button.dataset.chatFilter === conversationFilter;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-selected", String(active));
    });
  }
}

function openRequestedRoom() {
  if (!requestedRoomId) return;

  const requestedRoom = allRooms.find(
    ({ id }) => id === requestedRoomId
  );

  if (!requestedRoom) return;

  requestedRoomId = null;
  openChat(requestedRoom.id, requestedRoom.room);
}

searchInput?.addEventListener("input", renderRooms);

// ========================================
// OPEN A CONVERSATION
// ========================================

async function openChat(roomId, room, isDraft = false) {
  currentRoomId = roomId;
  currentRoom = room;
  pendingRoom = isDraft ? room : null;
  currentRoomOwnerId = getRoomOwnerId(room);
  if (
    !isVeterinarian() &&
    (room.unread === true || Number(room.unreadCount) > 0)
  ) {
    updateDoc(doc(db, "chatRooms", roomId), { unread: false, unreadCount: 0 }).catch(() => {});
  }
  if (!isDraft && ["admin", "staff"].includes(currentRole) &&
    !Object.prototype.hasOwnProperty.call(room, "chat_status")) {
    const now = serverTimestamp();
    try {
      await updateDoc(doc(db, "chatRooms", roomId), {
        chat_status: "STANDARD",
        chatStatusUpdatedAt: now,
        chatStatusUpdatedBy: currentUser.uid
      });
    } catch (error) {
      console.error("Could not initialize conversation medical status:", error);
    }
    currentRoom = {
      ...room,
      chat_status: "STANDARD"
    };
  }
  updateComposeMode();

  selectionMode = false;
  selectedMessageIds.clear();
  currentMessages.clear();

  renderMessageSelectionControls();

  document.querySelectorAll(".chat-user").forEach((element) => {
    element.classList.toggle(
      "active",
      element.dataset.roomId === roomId
    );
  });

  wrapper?.classList.add("is-chat-open");

  setHeader(getRoomName(room));
  renderRoomActions(room);

  if (headerSub) {
    headerSub.textContent = `Pet owner · Pet: ${getRoomPetName(room, roomId)} · Handled by ${handlerDisplay(room)}`;
  }

  setComposerEnabled(canWriteCurrentChat() && !!currentRoomOwnerId);
  updateComposerForRoom();
  beginPresence(roomId);

  unsubscribeMessages?.();
  unsubscribeMessages = null;

  showMessage("Loading messages...", "bi-hourglass-split");

  const resolvedName = await getOwnerName(room);

  if (currentRoomId !== roomId) return;

  setHeader(resolvedName);
  if (headerSub) headerSub.textContent = `Pet owner · Pet: ${getRoomPetName(currentRoom, roomId)} · Handled by ${handlerDisplay(currentRoom)}`;

  const messagesQuery = query(
    collection(db, "chatRooms", roomId, "messages"),
    orderBy("createdAt", "asc")
  );
  const existingAppointmentsPromise = getDocs(
    collection(db, "consultations")
  ).then((snapshot) =>
    snapshot.docs.map((appointmentDocument) => ({
      id: appointmentDocument.id,
      ...appointmentDocument.data()
    }))
  ).catch((error) => {
    console.error("Could not check existing appointments:", error);
    return null;
  });

  unsubscribeMessages = onSnapshot(
    messagesQuery,
    (snapshot) => {
      if (!chatBox || currentRoomId !== roomId) return;

      if (!room.petName && !room.pet && !roomPetNameCache.has(roomId)) {
        for (const messageDocument of [...snapshot.docs].reverse()) {
          const petName = getMessagePetName(messageDocument.data());
          if (!petName) continue;
          roomPetNameCache.set(roomId, petName);
          if (currentRoomId === roomId && headerSub) {
            headerSub.textContent = `Pet owner · Pet: ${getRoomPetName(room, roomId)} · Handled by ${handlerDisplay(currentRoom)}`;
          }
          renderRooms();
          break;
        }
      }

      snapshot.docChanges().forEach((change) => {
        if (change.type !== "added") return;
        if (isVeterinarian() && !canWriteCurrentChat(room)) return;

        const message = change.doc.data();
        existingAppointmentsPromise.then((existingAppointments) => {
          if (!existingAppointments) {
            throw new Error("Existing appointments could not be checked.");
          }

          return importAppointmentRequest(
            roomId,
            room,
            resolvedName,
            change.doc.id,
            message,
            existingAppointments
          );
        }).catch((error) => {
          console.error(
            `Could not import appointment request from message ${change.doc.id}:`,
            error
          );
        });
      });

      const nearBottom =
        chatBox.scrollHeight -
          chatBox.scrollTop -
          chatBox.clientHeight < 120 ||
        !chatBox.querySelector(".message-row");

      // IMPORTANT: refresh the map with actual Firestore message IDs.
      currentMessages = new Map(
        snapshot.docs.map((messageDocument) => [
          messageDocument.id,
          messageDocument.data()
        ])
      );

      // Remove selections for messages that no longer exist.
      for (const id of selectedMessageIds) {
        if (!currentMessages.has(id)) {
          selectedMessageIds.delete(id);
        }
      }

      if (snapshot.empty) {
        showMessage(
          "No messages yet. Send a message to start chatting."
        );

        updateMessageAdminControls();
        return;
      }

      const fragment = document.createDocumentFragment();

      let lastDay = null;
      let lastSenderKey = null;

      snapshot.forEach((messageDocument) => {
        const message = messageDocument.data();
        const messageId = messageDocument.id;

        const displayMessage = mapMessageForDisplay(message);
        const isOwnerMessage = displayMessage.senderRole === "owner";

        const date = message.createdAt?.toDate
          ? message.createdAt.toDate()
          : null;

        if (
          date &&
          (!lastDay || !sameDay(lastDay, date))
        ) {
          const divider = document.createElement("div");
          divider.className = "day-divider";

          const label = document.createElement("span");
          label.textContent = formatDay(date);

          divider.appendChild(label);
          fragment.appendChild(divider);

          lastDay = date;
          lastSenderKey = null;
        }

        const row = document.createElement("div");

        row.className =
          "message-row " + (isOwnerMessage ? "received role-owner" : "sent role-clinic") +
          (displayMessage.k === "n" ? " is-note" : "") +
          (displayMessage.isEvent ? " is-event" : "") +
          (displayMessage.isAppointmentEvent ? " is-appointment-event" : "");

        // Keep a message's label and bubble together. In selection mode the
        // checkbox is inserted beside this group, rather than above it.
        const messageContent = document.createElement("div");
        messageContent.className = "message-content";

        // IMPORTANT: required by the selection checkbox feature.
        row.dataset.messageId = messageId;
        row.dataset.senderId = message.senderId || "";
        row._senderMessage = message;

        const senderKey = isOwnerMessage
          ? `owner:${message.senderId || currentRoomOwnerId || ""}`
          : `clinic:${message.senderId || message.senderName || message.sender_name || displayMessage.senderRole}`;
        const isNewSender =
          !displayMessage.isEvent && senderKey !== lastSenderKey;

        if (isNewSender) {
          row.classList.add("group-start");
        }

        if (!displayMessage.isEvent) {
          lastSenderKey = senderKey;
        }

        const bubble = document.createElement("div");
        bubble.className = "message-bubble";

        const sender = document.createElement("div");
        sender.className = "message-sender";
        const senderInfo = isOwnerMessage
          ? { name: firstNameOf(resolvedName), role: "" }
          : {
            name: firstNameOf(message.senderName || message.sender_name || "Clinic"),
            role: senderRoleLabel(
              message.senderName || message.sender_name || "Clinic",
              message.sender_role || message.senderRole
            )
          };
        sender.textContent = displayMessage.k === "n"
          ? `🔒 Internal note · ${senderInfo.name} · ${senderInfo.role}`
          : `${senderInfo.name}${senderInfo.role ? ` · ${senderInfo.role}` : ""}`;
        if (isNewSender) {
          messageContent.appendChild(sender);
        }

        const attachmentNode = displayMessage.isEvent
          ? null
          : buildAttachment(displayMessage);
        const appointmentRequest = displayMessage.isEvent
          ? null
          : parseAppointmentRequest(message.text);
        const appointmentId =
          message.appointmentId || `chat_${roomId}_${messageId}`;

        const openAppointment = async () => {
          if (!appointmentRequest) return;
          if (message.appointmentDeleted === true) {
            window.alert("This appointment was deleted and cannot be reopened.");
            return;
          }

          // Staff and veterinary users review requests from the Appointments
          // page. Keep the navigation explicit so clicking either the request
          // card or its review link uses the same destination.
          const canReviewAppointment = [
            "admin",
            "staff",
            "vet",
            "veterinarian"
          ].includes(currentRole);
          if (!canReviewAppointment) return;
          if (isVeterinarian() && !canWriteCurrentChat()) {
            window.alert(
              "Ask the front desk to import this appointment request before reviewing it."
            );
            return;
          }

          const openAppointmentsPage = (id) => {
            window.location.assign(
              `appointments.html?appointmentId=${encodeURIComponent(id)}`
            );
          };

          try {
            // Newer messages already carry their appointment ID, so navigate
            // directly. Older messages still use the existing import fallback.
            if (message.appointmentId) {
              openAppointmentsPage(appointmentId);
              return;
            }

            const existingAppointments =
              await existingAppointmentsPromise;
            if (!existingAppointments) {
              throw new Error("Existing appointments could not be checked.");
            }

            const importedAppointmentId = await importAppointmentRequest(
              roomId,
              room,
              resolvedName,
              messageId,
              message,
              existingAppointments
            );
            if (!importedAppointmentId) {
              throw new Error("This message is not a valid appointment request.");
            }

            openAppointmentsPage(importedAppointmentId);
          } catch (error) {
            console.error("Could not open appointment request:", error);
            window.alert(
              "Could not open this appointment. Please try again."
            );
          }
        };

        const bodyText = attachmentNode
          ? attachmentNode.classList.contains("appointment-card")
            ? stripAppointmentLines(message.text)
            : attachmentNode.classList.contains("appointment-message")
              ? ""
            : stripAttachmentLines(message.text)
          : message.text || "";

        if (bodyText) {
          const text = document.createElement("div");
          text.textContent = bodyText;
          bubble.appendChild(text);

        }

        if (appointmentRequest) {
          const appointmentLink = document.createElement("a");
          appointmentLink.className = "chat-appointment-link";
          appointmentLink.href =
            `appointments.html?appointmentId=${encodeURIComponent(
              appointmentId
            )}`;
          appointmentLink.textContent = "Review appointment";
          appointmentLink.addEventListener("click", (event) => {
            event.preventDefault();
            void openAppointment();
          });
          bubble.appendChild(appointmentLink);

          if (attachmentNode?.classList.contains("appointment-card")) {
            attachmentNode.classList.add("is-clickable");
            attachmentNode.setAttribute("role", "link");
            attachmentNode.setAttribute("tabindex", "0");
            attachmentNode.setAttribute(
              "aria-label",
              "Open appointment request"
            );
            attachmentNode.addEventListener("click", (event) => {
              if (event.target.closest("a, button")) return;
              void openAppointment();
            });
            attachmentNode.addEventListener("keydown", (event) => {
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              void openAppointment();
            });
          }
        }

        if (attachmentNode) {
          bubble.appendChild(attachmentNode);
        }

        if (
          attachmentNode?.classList.contains("scan-card")
        ) {
          bubble.classList.add("is-scan");
        }

        if (
          attachmentNode?.classList.contains("appointment-card") &&
          !attachmentNode.classList.contains("appointment-message")
        ) {
          bubble.classList.add("is-appointment");
        }

        if (
          attachmentNode?.classList.contains("chat-image-button")
        ) {
          bubble.classList.add("is-photo");
        }

        if (date) {
          const time = document.createElement("div");
          time.className = "message-time";

          time.textContent = date.toLocaleTimeString("en-US", {
            hour: "numeric",
            minute: "2-digit",
            hour12: true
          });

          bubble.appendChild(time);
        }

        messageContent.appendChild(bubble);
        row.appendChild(messageContent);
        fragment.appendChild(row);

        if (
          isOwnerMessage &&
          message.read !== true &&
          (!isVeterinarian() || canWriteCurrentChat())
        ) {
          updateDoc(
            doc(
              db,
              "chatRooms",
              roomId,
              "messages",
              messageId
            ),
            { read: true }
          ).catch((error) => {
            console.error(
              "Could not mark message as read:",
              error
            );
          });
        }
      });

      chatBox.replaceChildren(fragment);

      chatBox.querySelectorAll(".message-row.role-clinic").forEach((row) => {
        const message = row._senderMessage;
        if (!message) return;
        getClinicSender(message).then((senderInfo) => {
          const label = row.querySelector(".message-sender");
          if (!label) return;
          label.childNodes[0].textContent = displayMessageForLabel(message, senderInfo);
        });
      });

      // Add checkboxes after each snapshot render.
      renderCurrentMessageCheckboxes();
      updateMessageAdminControls();

      if (nearBottom) {
        chatBox.scrollTop = chatBox.scrollHeight;
      }
    },
    (error) => {
      console.error("Could not load messages:", error);

      showMessage(
        "Could not load messages. Check Firestore permissions.",
        "bi-exclamation-circle"
      );
    }
  );
}

function displayMessageForLabel(message, senderInfo) {
  const display = mapMessageForDisplay(message);
  const senderName = firstNameOf(senderInfo.name);
  return display.k === "n"
    ? `🔒 Internal note · ${senderName} · ${senderInfo.role}`
    : `${senderName}${senderInfo.role ? ` · ${senderInfo.role}` : ""}`;
}

// ========================================
// ATTACHMENT DISPLAY
// ========================================

function imageSourceOf(message) {
  const source = message.fileUrl || message.imageBase64;

  if (typeof source !== "string") return null;

  const src = source.trim();

  return /^https?:\/\//i.test(src) ||
    /^data:image\//i.test(src)
    ? src
    : null;
}

function openPreview(src, label) {
  if (
    !previewModal ||
    !previewImg ||
    !window.bootstrap?.Modal
  ) {
    console.error("Chat image preview is unavailable.");
    return;
  }

  previewImg.src = src;
  previewImg.alt = label;

  if (previewTitle) {
    previewTitle.textContent = label;
  }

  resetZoom();

  window.bootstrap.Modal
    .getOrCreateInstance(previewModal)
    .show();
}

function confidenceText(value) {
  if (value === undefined || value === null || value === "") {
    return "";
  }

  const number = Number(
    String(value).replace("%", "")
  );

  if (!Number.isFinite(number)) return "";

  return `${Math.round(number <= 1 ? number * 100 : number)}%`;
}

function buildScanCard(message, src) {
  const parsed = parseScanText(message.text);

  const pet =
    message.petName ||
    message.scanPetName ||
    parsed.pet ||
    "";

  const condition =
    message.condition ||
    message.diagnosis ||
    message.result ||
    message.scanResult ||
    message.prediction ||
    parsed.condition ||
    "";

  const confidence = confidenceText(
    message.confidence ??
    message.accuracy ??
    message.score ??
    parsed.confidence
  );

  if (!pet && !condition && !confidence) return null;

  const card = document.createElement("div");
  card.className = "scan-card";

  const title = document.createElement("div");
  title.className = "scan-card-title";
  title.innerHTML =
    '<i class="bi bi-file-earmark-medical" aria-hidden="true"></i>';

  title.append(
    document.createTextNode("Attached Scan Record")
  );

  const body = document.createElement("div");
  body.className = "scan-card-body";

  if (src) {
    const thumb = document.createElement("button");

    thumb.type = "button";
    thumb.className = "scan-thumb";
    thumb.setAttribute(
      "aria-label",
      "View scan image full size"
    );

    const image = document.createElement("img");
    image.src = src;
    image.alt = pet ? `Scan of ${pet}` : "Scan image";
    image.loading = "lazy";
    image.onerror = () => thumb.remove();

    thumb.appendChild(image);

    thumb.addEventListener("click", () => {
      openPreview(src, pet || "Scan record");
    });

    body.appendChild(thumb);
  }

  const info = document.createElement("div");
  info.className = "scan-info";

  [
    ["scan-pet", pet && `Pet: ${pet}`],
    ["scan-condition", condition],
    ["scan-confidence", confidence]
  ].forEach(([className, value]) => {
    if (!value) return;

    const element = document.createElement("div");
    element.className = className;
    element.textContent = value;

    info.appendChild(element);
  });

  body.appendChild(info);
  card.append(title, body);

  return card;
}

function buildAppointmentCard(message) {
  const text = message.text || "";
  const appointmentData =
    message.appointmentRequest ||
    message.appointment ||
    {};
  const petFromText = text.match(
    /\b(?:Pet(?:\s+Name|_name)?|Animal)\s*[:=-]\s*([^|\n]+)/i
  )?.[1]?.trim();
  const dateFromText = text.match(
    /\b(?:Requested\s+Date(?:\s+(?:and|&)\s+Time)?|Preferred\s+Date(?:\s+(?:and|&)\s+Time)?|Appointment\s+Date(?:\s+(?:and|&)\s+Time)?|Date(?:\s+(?:and|&)\s+Time)?|Schedule)\s*[:=-]\s*([^|\n]+)/i
  )?.[1]?.trim();
  const timeFromText = text.match(
    /\bTime\s*[:=-]\s*([^|\n]+)/i
  )?.[1]?.trim();
  const pet =
    appointmentData.petName ||
    appointmentData.pet_name ||
    appointmentData.pet ||
    message.petName ||
    message.pet_name ||
    message.pet ||
    petFromText;
  const requestedDate =
    appointmentData.preferredDate ||
    appointmentData.preferred_date ||
    appointmentData.appointmentDate ||
    appointmentData.appointment_date ||
    appointmentData.date ||
    message.preferredDate ||
    message.preferred_date ||
    dateFromText;
  const requestedTime =
    appointmentData.preferredTime ||
    appointmentData.preferred_time ||
    appointmentData.appointmentTime ||
    appointmentData.appointment_time ||
    appointmentData.time ||
    message.preferredTime ||
    message.preferred_time ||
    timeFromText;
  const messageType = String(message.type || "").toLowerCase();
  const hasStructuredAppointment =
    Object.keys(appointmentData).length > 0 && pet && requestedDate;
  const isAppointmentRequest =
    /\[Appointment Request\]/i.test(text) ||
    (/appointment.{0,20}request/i.test(text) && pet && requestedDate) ||
    (/(?:appointment|consultation)/.test(messageType) && pet && requestedDate) ||
    hasStructuredAppointment ||
    (petFromText && dateFromText);

  if (!isAppointmentRequest || !pet || !requestedDate) return null;
  const petName = String(pet).trim();
  const dateValue = requestedDate?.toDate
    ? requestedDate.toDate().toLocaleDateString()
    : requestedDate instanceof Date
      ? requestedDate.toLocaleDateString()
      : String(requestedDate).trim();
  const timeValue = requestedTime
    ? requestedTime?.toDate
      ? requestedTime.toDate().toLocaleTimeString([], {
          hour: "numeric",
          minute: "2-digit"
        })
      : requestedTime instanceof Date
        ? requestedTime.toLocaleTimeString([], {
            hour: "numeric",
            minute: "2-digit"
          })
        : String(requestedTime).trim()
    : "";
  const requestedSchedule = [dateValue, timeValue].filter(Boolean).join(", ");
  const requestMatch = APPOINTMENT_REQUEST_PATTERN.exec(text);
  const statusMatch = APPOINTMENT_STATUS_CARD_PATTERN.exec(text);
  if (!requestMatch && !statusMatch && !isAppointmentRequest) return null;

  const card = document.createElement("div");
  card.className = "appointment-card";
  const isClinicAppointment = mapMessageForDisplay(message).senderRole === "clinic";
  card.dataset.appointmentSender = isClinicAppointment ? "clinic" : "owner";
  card.dataset.appointmentStatusSchedule = formatAppointmentStatusSchedule(
    requestedDate,
    requestedTime
  );
  const statusKey = appointmentStatusKey(
    currentRoomOwnerId,
    petName,
    dateValue,
    timeValue
  );
  if (statusKey) card.dataset.appointmentKey = statusKey;

  const title = document.createElement("div");
  title.className = "appointment-card-title";
  title.innerHTML =
    '<i class="bi bi-calendar-check" aria-hidden="true"></i>';
  const status = document.createElement("span");
  const resolvedCardStatus = String(
    appointmentStatuses.get(statusKey) ||
    (statusMatch?.[1] === "Approved" ? "Approved" : statusMatch?.[1]) ||
    message.card_status || message.cardStatus || message.status || "Pending"
  );
  const normalizedCardStatus = resolvedCardStatus.toLowerCase();
  const cardTitle = !isClinicAppointment
    ? "Appointment Request"
    : normalizedCardStatus.includes("cancel")
    ? "Appointment Cancelled"
    : normalizedCardStatus.includes("approv") || normalizedCardStatus.includes("confirm")
      ? "Appointment Approved"
      : "Appointment Request";

  if (cardTitle !== "Appointment Request") {
    card.classList.remove("appointment-card");
    card.classList.add("appointment-message");
    card.dataset.appointmentState = cardTitle === "Appointment Approved" ? "approved" : "cancelled";
    card.dataset.appointmentPet = petName;
    card.dataset.appointmentSchedule = requestedSchedule;
    const cancellationReason = message.cancel_reason || message.cancelReason || message.cancellationReason || "";
    card.dataset.cancelReason = cancellationReason;

    const sentence = document.createElement("div");
    sentence.className = "appointment-message-text";
    const statusSchedule = card.dataset.appointmentStatusSchedule || requestedSchedule;
    sentence.textContent = `Your appointment request for ${petName} on ${statusSchedule} has been ${cardTitle === "Appointment Approved" ? "approved" : (cancellationReason ? `cancelled due to ${cancellationReason}` : "cancelled")}.`;
    card.appendChild(sentence);

    return card;
  }

  title.append(document.createTextNode(cardTitle));
  // A pet owner's request is the request itself, so do not echo its current
  // appointment state back in the message card. Status changes are conveyed
  // by the clinic's approved or cancelled response instead.
  if (isClinicAppointment) {
    setAppointmentStatusLabel(
      status,
      resolvedCardStatus
    );
    title.appendChild(status);
  }

  const details = document.createElement("div");
  details.className = "appointment-card-details";

  [
    ["Pet", petName],
    [cardTitle === "Appointment Request" ? "Requested date and time" : "Date and time", requestedSchedule]
  ].forEach(([label, value]) => {
    const item = document.createElement("div");
    item.className = "appointment-card-item";

    const itemLabel = document.createElement("span");
    itemLabel.className = "appointment-card-label";
    itemLabel.textContent = label;

    const itemValue = document.createElement("strong");
    itemValue.className = "appointment-card-value";
    itemValue.textContent = value;

    item.append(itemLabel, itemValue);
    details.appendChild(item);
  });

  const cancellationReason = message.cancel_reason || message.cancelReason || message.cancellationReason;
  if (cardTitle === "Appointment Cancelled" && cancellationReason) {
    const reason = document.createElement("div");
    reason.className = "appointment-cancel-reason";
    const reasonLabel = document.createElement("span");
    reasonLabel.textContent = "Reason for cancellation";
    reason.append(reasonLabel, document.createTextNode(cancellationReason));
    details.appendChild(reason);
  }

  card.append(title, details);
  return card;
}

function buildAttachment(message) {
  const appointmentCard = buildAppointmentCard(message);
  if (appointmentCard) return appointmentCard;

  const src = imageSourceOf(message);

  if (message.type === "scan") {
    const card = buildScanCard(message, src);

    if (card) return card;
  }

  if (
    (message.type === "photo" || message.type === "scan") &&
    src
  ) {
    const label =
      message.fileName ||
      (message.type === "scan"
        ? "Scan attachment"
        : "Photo attachment");

    const button = document.createElement("button");
    button.type = "button";
    button.className = "chat-image-button";

    button.setAttribute(
      "aria-label",
      `View ${label} full size`
    );

    const image = document.createElement("img");
    image.src = src;
    image.alt = label;
    image.loading = "lazy";
    image.onerror = () => button.remove();

    const zoomIcon = document.createElement("span");
    zoomIcon.className = "chat-image-zoom";
    zoomIcon.setAttribute("aria-hidden", "true");
    zoomIcon.innerHTML =
      '<i class="bi bi-zoom-in"></i>';

    button.append(image, zoomIcon);

    button.addEventListener("click", () => {
      openPreview(src, label);
    });

    return button;
  }

  const docName =
    message.fileName ||
    (
      (message.text || "").match(
        /\[Attached\s+Document\]\s*([^\n]+)/i
      ) || []
    )[1];

  if (message.type === "document" || docName) {
    const card = document.createElement(
      message.fileUrl ? "a" : "div"
    );

    card.className = "doc-card";

    if (message.fileUrl) {
      card.href = message.fileUrl;
      card.target = "_blank";
      card.rel = "noopener noreferrer";
    }

    const icon = document.createElement("div");
    icon.className = "doc-card-icon";
    icon.innerHTML =
      '<i class="bi bi-file-earmark-text" aria-hidden="true"></i>';

    const info = document.createElement("div");

    const name = document.createElement("div");
    name.className = "doc-card-name";
    name.textContent = (docName || "Document").trim();

    const hint = document.createElement("small");
    hint.textContent = message.fileUrl
      ? "Click to open"
      : "Document";

    info.append(name, hint);
    card.append(icon, info);

    return card;
  }

  return null;
}

// ========================================
// NEW CONVERSATION
// ========================================

const newChatModal = $("newChatModal");
const ownerPickList = $("ownerPickList");
const ownerSearch = $("ownerSearch");

let ownersCache = null;

async function loadOwners() {
  if (ownersCache) return ownersCache;

  const snapshot = await getDocs(
    query(
      collection(db, "users"),
      where("role", "==", "petowner")
    )
  );

  const people = snapshot.docs
    .filter((document) => document.id !== currentUser.uid)
    .map((document) => {
      const user = document.data();

      return {
        id: document.id,
        name:
          user.fullName ||
          user.name ||
          user.displayName ||
          user.email ||
          "Pet owner",
        email: user.email || "",
        role: String(
          user.role ||
          user.userRole ||
          user.accountType ||
          ""
        )
      };
    });

  ownersCache = people
    .filter(
      (person) =>
        person.role.trim().toLowerCase() === "petowner"
    )
    .sort((a, b) => a.name.localeCompare(b.name));

  console.log(
    `New conversation: ${ownersCache.length} of ${people.length} users listed`
  );

  return ownersCache;
}

function renderOwnerPicks() {
  const term = (ownerSearch?.value || "")
    .trim()
    .toLowerCase();

  const matches = (ownersCache || []).filter((owner) =>
    !term ||
    owner.name.toLowerCase().includes(term) ||
    owner.email.toLowerCase().includes(term)
  );

  if (!matches.length) {
    ownerPickList.replaceChildren(
      statusEl("No pet owners found.")
    );
    return;
  }

  const fragment = document.createDocumentFragment();

  matches.forEach((owner) => {
    const hasRoom = allRooms.some(
      ({ room }) =>
        getRoomOwnerId(room) === owner.id && room.lastMessage
    );

    const button = document.createElement("button");
    button.type = "button";
    button.className = "owner-pick";

    const avatar = document.createElement("div");
    avatar.className = "chat-avatar sm";
    avatar.textContent = initialOf(owner.name);

    const text = document.createElement("div");

    const name = document.createElement("div");
    name.className = "owner-pick-name";
    name.textContent = owner.name;

    const email = document.createElement("small");
    email.textContent = owner.email;

    text.append(name, email);
    button.append(avatar, text);

    if (hasRoom) {
      const tag = document.createElement("span");
      tag.className = "owner-pick-tag";
      tag.textContent = "Open chat";

      button.appendChild(tag);
    }

    button.addEventListener("click", () => {
      startChatWith(owner);
    });

    fragment.appendChild(button);
  });

  ownerPickList.replaceChildren(fragment);
}

async function startChatWith(owner) {
  const modal = window.bootstrap?.Modal.getOrCreateInstance(
    newChatModal
  );

  const existing = allRooms.find(
    ({ room }) => getRoomOwnerId(room) === owner.id
  );

  if (existing) {
    modal?.hide();
    openChat(existing.id, existing.room);
    return;
  }

  const roomId = `${currentUser.uid}_${owner.id}`;

  const room = {
    petOwnerId: owner.id,
    ownerName: owner.name,
    ownerEmail: owner.email,
    vetId: currentUser.uid,
    participants: [owner.id, currentUser.uid],
    chat_status: "STANDARD",
    lastMessage: "",
    lastMessageInternal: false
  };

  modal?.hide();

  openChat(roomId, room, true);
}

$("newChatBtn")?.addEventListener("click", async () => {
  if (!currentUser) return;

  ownerSearch.value = "";

  ownerPickList.replaceChildren(
    statusEl("Loading pet owners...")
  );

  window.bootstrap?.Modal
    .getOrCreateInstance(newChatModal)
    .show();

  try {
    await loadOwners();
    renderOwnerPicks();
  } catch (error) {
    console.error("Could not load users:", error);

    ownerPickList.replaceChildren(
      statusEl(
        "Could not load pet owners. Contact your IT Administrator."
      )
    );
  }
});

ownerSearch?.addEventListener("input", renderOwnerPicks);

newChatModal?.addEventListener("shown.bs.modal", () => {
  ownerSearch?.focus();
});

// ========================================
// SEND MESSAGE + ATTACHMENTS
// ========================================

function attachmentDetails(file) {
  const extension =
    file.name.split(".").pop()?.toLowerCase() || "";

  const contentType =
    (
      file.type && ALLOWED_ATTACHMENT_TYPES.has(file.type)
        ? file.type
        : ATTACHMENT_MIME_TYPES[extension]
    ) || "";

  if (!contentType) {
    throw new Error("Choose a supported photo or file.");
  }

  if (file.size === 0) {
    throw new Error("The selected file is empty.");
  }

  if (file.size > MAX_ATTACHMENT_SIZE) {
    throw new Error(
      "Attachments must be 10 MB or smaller."
    );
  }

  return {
    contentType,
    type: contentType.startsWith("image/")
      ? "photo"
      : "document"
  };
}

function uploadAttachment(file, messageId, roomId, ownerId) {
  attachmentDetails(file);

  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    const formData = new FormData();
    const safeFileName = file.name
      .replace(/[\\/:*?"<>|]+/g, "_")
      .replace(/[^\w.-]/g, "_")
      .slice(-120) || "attachment";

    formData.append(
      "file",
      file,
      `${messageId}_${safeFileName}`
    );
    formData.append("upload_preset", CLOUDINARY_UPLOAD_PRESET);
    formData.append(
      "asset_folder",
      `chat-attachments/${ownerId}/${roomId}`
    );

    request.open(
      "POST",
      `https://api.cloudinary.com/v1_1/${encodeURIComponent(CLOUDINARY_CLOUD_NAME)}/auto/upload`
    );
    request.timeout = 120000;

    request.upload.addEventListener("progress", (event) => {
      if (!event.lengthComputable || !attachmentStatus) return;

      const percent = Math.round(
        (event.loaded / event.total) * 100
      );
      attachmentStatus.textContent =
        `Uploading ${file.name} (${percent}%)`;
    });

    request.addEventListener("load", () => {
      let response = {};

      try {
        response = JSON.parse(request.responseText || "{}");
      } catch {
        reject(new Error("Cloudinary returned an unreadable response."));
        return;
      }

      if (request.status < 200 || request.status >= 300) {
        reject(
          new Error(
            response.error?.message ||
            `Upload failed with status ${request.status}.`
          )
        );
        return;
      }

      if (
        response.type !== "upload" ||
        !["image", "raw"].includes(response.resource_type) ||
        typeof response.secure_url !== "string" ||
        !response.secure_url.startsWith(
          `https://res.cloudinary.com/${CLOUDINARY_CLOUD_NAME}/`
        )
      ) {
        reject(
          new Error("Invalid URL. Contact your IT Administrator.")
        );
        return;
      }

      resolve(response.secure_url);
    });

    request.addEventListener("error", () => {
      reject(new Error("Network error while uploading"));
    });
    request.addEventListener("timeout", () => {
      reject(new Error("Check your connection."));
    });
    request.send(formData);
  });
}

async function sendMessage(
  attachmentFile = null,
  expectedAttachmentType = null
) {
  if (
    !currentUser ||
    !currentRoomId ||
    !currentRoomOwnerId ||
    !canWriteCurrentChat() ||
    messageSendInProgress
  ) {
    return;
  }

  const caption = messageInput?.value.trim() || "";

  if (!caption && !attachmentFile) return;

  if (caption.length > 10000) {
    window.alert(
      "Messages must be 10,000 characters or fewer."
    );
    return;
  }

  let attachment = null;

  if (attachmentFile) {
    try {
      attachment = {
        ...attachmentDetails(attachmentFile),
        fileName: attachmentFile.name
      };

      if (
        expectedAttachmentType &&
        attachment.type !== expectedAttachmentType
      ) {
        throw new Error(
          expectedAttachmentType === "photo"
            ? "Choose an image to send as a photo."
            : "Choose a supported document to send as a file."
        );
      }

      if (attachment.fileName.length > 255) {
        throw new Error(
          "File names must be 255 characters or fewer."
        );
      }
    } catch (error) {
      window.alert(error.message);
      return;
    }
  }

  const roomId = currentRoomId;
  const ownerId = currentRoomOwnerId;
  const draft = pendingRoom;

  messageSendInProgress = true;
  setComposerEnabled(true);

  try {
    const messageRef = doc(
      collection(db, "chatRooms", roomId, "messages")
    );

    let text = caption;

    if (attachment) {
      text ||= attachment.type === "photo"
        ? `[Photo Attachment] ${attachment.fileName}`
        : `[Attached Document] ${attachment.fileName}`;

      if (attachmentStatus) {
        attachmentStatus.textContent =
          `Uploading ${attachment.fileName}...`;
      }

      attachment.fileUrl = await uploadAttachment(
        attachmentFile,
        messageRef.id,
        roomId,
        ownerId
      );
    }

    if (attachmentStatus) {
      attachmentStatus.textContent = "Sending message...";
    }

    const notificationRef = doc(
      collection(db, "notifications")
    );
    const vetSnap = await getUserProfileSnapshot(currentUser);
    const vetData = vetSnap.exists() ? vetSnap.data() : {};
    const vetName = vetData.fullName || vetData.displayName ||
      currentUser.displayName || "your veterinarian";
    const senderRole = currentRole === "veterinarian"
      ? "vet"
      : ["vet", "staff", "admin"].includes(currentRole)
        ? currentRole
        : "vet";
    const senderName = vetData.fullName || vetData.displayName || currentUser.displayName || "Clinic staff";
    const appointmentRequest = parseAppointmentRequest(text);
    const messageType = appointmentRequest
      ? "appointment_request"
      : attachment?.type || "text";

    const batch = writeBatch(db);
    batch.set(messageRef, {
      senderName,
      senderId: currentUser.uid,
      senderRole,
      sender_role: senderRole,
      sender_type: "clinic",
      type: messageType,
      kind: appointmentRequest ? "appointment_card" : "text",
      internalOnly: false,
      text,
      body: text,

      ...(appointmentRequest && {
        appointmentId: `chat_${roomId}_${messageRef.id}`
      }),

      ...(attachment && {
        fileUrl: attachment.fileUrl,
        fileName: attachment.fileName,
        contentType: attachment.contentType,
        fileSize: attachmentFile.size
      }),

      createdAt: serverTimestamp(),
      read: false
    });

    batch.set(notificationRef, {
      userId: ownerId,
      title: `New message from ${vetName}`,
      message: text,
      type: "MESSAGE",
      targetScreen: "CHAT",
      targetId: roomId,
      isRead: false,
      createdAtMillis: Date.now(),
      timestamp: new Date().toLocaleString(),
      sourceMessageId: messageRef.id
    });

    const roomRef = doc(db, "chatRooms", roomId);

    if (draft) {
      batch.set(
        roomRef,
        {
          ...draft,
          owner_id: ownerId,
          handler_id: draft.handlerId || null,
          status: draft.status || "open",
          createdAt: serverTimestamp(),
          lastMessage: text,
          lastMessageAt: serverTimestamp(),
          lastMessageInternal: false
        },
        { merge: true }
      );
    } else {
      batch.update(roomRef, {
        lastMessage: text,
        lastMessageAt: serverTimestamp(),
        lastMessageInternal: false,
        ...(!handlerIdOf(currentRoom) && currentRole === "staff" ? {
          handlerId: currentUser.uid,
          handlerName: senderName,
          handlerRole: currentRole,
          status: "open"
        } : {})
      });
    }

    await batch.commit();

    if (draft && pendingRoom === draft) {
      pendingRoom = null;
    }

    if (messageInput) {
      messageInput.value = "";
      autosizeInput();
    }

    if (chatBox && currentRoomId === roomId) {
      chatBox.scrollTop = chatBox.scrollHeight;
    }

  } catch (error) {
    console.error("Failed to send message:", error);

    window.alert(
      attachmentFile
        ? `Attachment failed to send: ${error?.message || "Contact IT Administrator."}`
        : `Message failed to send: ${error?.message || "Contact IT Administrator."}`
    );

  } finally {
    messageSendInProgress = false;

    if (attachmentStatus) {
      attachmentStatus.textContent = "";
    }

    setComposerEnabled(canWriteCurrentChat() && !!currentRoomId);

    if (currentRoomId === roomId) {
      messageInput?.focus();
    }
  }
}

sendButton?.addEventListener("click", () => {
  void sendMessage();
});

photoButton?.addEventListener("click", () => {
  photoInput?.click();
});

fileButton?.addEventListener("click", () => {
  fileInput?.click();
});

photoInput?.addEventListener("change", () => {
  const [file] = photoInput.files || [];

  photoInput.value = "";

  if (file) {
    void sendMessage(file, "photo");
  }
});

fileInput?.addEventListener("change", () => {
  const [file] = fileInput.files || [];

  fileInput.value = "";

  if (file) {
    void sendMessage(file, "document");
  }
});

messageInput?.addEventListener("input", autosizeInput);

messageInput?.addEventListener("keydown", (event) => {
  if (
    event.key === "Enter" &&
    !event.shiftKey &&
    !event.isComposing
  ) {
    event.preventDefault();
    void sendMessage();
  }
});

// ========================================
// MOBILE BACK BUTTON
// ========================================

backButton?.addEventListener("click", () => {
  wrapper?.classList.remove("is-chat-open");
});

// ========================================
// CLEAN UP
// ========================================

window.addEventListener("beforeunload", () => {
  unsubscribeMessages?.();
  unsubscribeRooms?.();
  unsubscribeUnreadMessages.forEach((unsubscribe) => unsubscribe());
  unsubscribeUnreadMessages.clear();
  unsubscribeAppointmentStatuses?.();
  unsubscribePresence?.();
  if (presenceTimer) clearInterval(presenceTimer);
});
