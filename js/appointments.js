
import { auth, db } from "./firebase-config.js";
import { watchActiveStaffPage } from "./page-auth.js";
import { getUserProfileSnapshot } from "./user-profile.js";
import {
  appointmentStatusKey as statusKey,
  parseDateOnly,
  parseTime
} from "./appointment-utils.mjs";

import {
  collection,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  orderBy,
  runTransaction,
  writeBatch,
  serverTimestamp,
  increment,
  Timestamp,
  where
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

/* ------------------------------------------------------------------
   CONFIG
------------------------------------------------------------------ */

// Appointment requests are stored in the collection used by the owner app.
const APPOINTMENTS_COLLECTION = "consultations";

// Reminders are written here. The Android app can listen for notifications
// where userId matches the signed-in owner.
const NOTIFICATIONS_COLLECTION = "notifications";

const table = document.getElementById("appointmentsTable");
const searchInput = document.getElementById("appointmentSearch");
const footer = document.getElementById("appointmentFooter");
const showMoreButton = document.getElementById("appointmentsShowMore");
const chips = document.querySelectorAll(".cs-chip");
const appointmentDateFilterToggle = document.getElementById("appointmentDateFilterToggle");
const appointmentDateFilterPanel = document.getElementById("appointmentDateFilterPanel");
const appointmentDateFromInput = document.getElementById("appointmentDateFrom");
const appointmentDateToInput = document.getElementById("appointmentDateTo");
const appointmentDateResetButton = document.getElementById("appointmentDateReset");

const statPending = document.getElementById("statPending");
const statTomorrow = document.getElementById("statTomorrow");
const statReminders = document.getElementById("statReminders");
const bulkBtn = document.getElementById("bulkRemindBtn");
const bulkCount = document.getElementById("bulkCount");
const adminControls = document.getElementById("appointmentAdminControls");
let appointmentSelectionControls = null;
const vetQuestionsToggle = document.getElementById("vetQuestionsToggle");
const vetQuestionsCount = document.getElementById("vetQuestionsCount");
const vetQuestionsDrawer = document.getElementById("vetQuestionsDrawer");
const vetQuestionsBackdrop = document.getElementById("vetQuestionsBackdrop");
const vetQuestionsClose = document.getElementById("vetQuestionsClose");

const cancelModalEl = document.getElementById("cancelAppointmentModal");
const cancelForm = document.getElementById("cancelAppointmentForm");
const cancelReasonInput = document.getElementById("cancelReason");
const cancelSubmitBtn = document.getElementById("cancelAppointmentSubmit");
const rescheduleModalEl = document.getElementById("rescheduleAppointmentModal");
const rescheduleForm = document.getElementById("rescheduleAppointmentForm");
const rescheduleSubmitBtn = document.getElementById("rescheduleAppointmentSubmit");
const rescheduleDateInput = document.getElementById("rescheduleDate");
const rescheduleTimeInput = document.getElementById("rescheduleTime");
const modalEl = document.getElementById("reminderModal");
const modalSubtitle = document.getElementById("reminderSubtitle");
const messageInput = document.getElementById("reminderMessage");
const previewEl = document.getElementById("reminderPreview");
const errorEl = document.getElementById("reminderError");
const sendBtn = document.getElementById("reminderSendBtn");

let unsubscribe = null;
let allAppointments = [];
let activeFilter = "all";
let showAllAppointments = false;
const APPOINTMENTS_PAGE_SIZE = 15;
const expandedAppointmentOwners = new Set();
let dateFrom = "";
let dateTo = "";
let currentReminder = null;
let currentCancellation = null;
let currentRescheduling = null;
let cancelModalTrigger = null;
let rescheduleModalTrigger = null;
let currentRole = "";
let currentUser = null;
let unsubscribeVetQuestions = null;
let vetQuestionsTrigger = null;
let selectionMode = false;
let selectedAppointmentIds = new Set();
let isDeletingAppointments = false;
let requestedAppointmentId =
  new URLSearchParams(window.location.search).get("appointmentId");

/* ------------------------------------------------------------------
   AUTH
------------------------------------------------------------------ */

watchActiveStaffPage(({ user, profile, role }) => {
  currentUser = user;
  currentRole = role;

  const displayName =
    profile.fullName ||
    profile.displayName ||
    user.displayName ||
    "User";

  const userName = document.getElementById("userName");
  const userEmail = document.getElementById("userEmail");
  const userInitial = document.getElementById("userInitial");

  if (userName) userName.textContent = displayName;
  if (userEmail) userEmail.textContent = user.email || "";
  if (userInitial) {
    userInitial.textContent = displayName.charAt(0).toUpperCase();
  }

  if (["admin", "staff"].includes(currentRole)) {
    createAppointmentAdminControls();
  }

  if (["vet", "veterinarian"].includes(currentRole)) {
    setupVetQuestionsDrawer();
    listenForVetQuestions(user.uid);
  }

  loadAppointments();
}, (error) => {
  console.error("Could not verify web access:", error);
  showError("Unable to verify your account. Please log in again.");
});

function listenForVetQuestions(vetId) {
  const open = document.getElementById("vetQuestionsOpen");
  const answered = document.getElementById("vetQuestionsAnswered");
  if (!open || !answered) return;
  unsubscribeVetQuestions?.();
  unsubscribeVetQuestions = onSnapshot(
    query(collection(db, "vet_questions"), where("vetId", "==", vetId)),
    (snapshot) => {
      const questions = snapshot.docs
        .map((item) => ({ id: item.id, ...item.data() }))
        .sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));
      const openQuestions = questions.filter((item) => !item.answer);
      const answeredQuestions = questions.filter((item) => item.answer);
      updateVetQuestionsCount(openQuestions.length);
      open.replaceChildren(...(openQuestions.length ? openQuestions.map((item) => renderVetQuestion(item, false)) : [questionEmpty("No open questions. You're all caught up.")]));
      answered.replaceChildren(...(answeredQuestions.length ? answeredQuestions.map((item) => renderVetQuestion(item, true)) : [questionEmpty("No answered questions yet.")]));
    },
    (error) => {
      console.error("Could not load staff questions:", error);
      updateVetQuestionsCount(0);
      open.replaceChildren(questionEmpty("Could not load staff questions."));
    }
  );
}

function setupVetQuestionsDrawer() {
  if (!vetQuestionsToggle || !vetQuestionsDrawer || !vetQuestionsBackdrop) return;

  vetQuestionsTrigger = document.activeElement;
  vetQuestionsToggle.hidden = false;
  vetQuestionsToggle.addEventListener("click", openVetQuestionsDrawer);
  vetQuestionsClose?.addEventListener("click", closeVetQuestionsDrawer);
  vetQuestionsBackdrop.addEventListener("click", closeVetQuestionsDrawer);
  document.addEventListener("keydown", handleVetQuestionsDrawerKeydown);
}

function updateVetQuestionsCount(count) {
  if (!vetQuestionsCount) return;
  vetQuestionsCount.textContent = count > 99 ? "99+" : String(count);
  vetQuestionsCount.hidden = count === 0;
  vetQuestionsToggle?.setAttribute("aria-label", count
    ? `Staff questions, ${count} unanswered`
    : "Staff questions");
}

function openVetQuestionsDrawer() {
  if (!vetQuestionsDrawer || !vetQuestionsBackdrop || !vetQuestionsToggle) return;

  vetQuestionsTrigger = vetQuestionsToggle;
  vetQuestionsDrawer.inert = false;
  vetQuestionsDrawer.setAttribute("aria-hidden", "false");
  vetQuestionsBackdrop.hidden = false;
  requestAnimationFrame(() => {
    vetQuestionsBackdrop.classList.add("is-open");
    vetQuestionsDrawer.classList.add("is-open");
  });
  vetQuestionsToggle.setAttribute("aria-expanded", "true");
  document.body.classList.add("vet-questions-drawer-open");
  vetQuestionsClose?.focus();
}

function closeVetQuestionsDrawer() {
  if (!vetQuestionsDrawer || !vetQuestionsBackdrop) return;

  vetQuestionsDrawer.classList.remove("is-open");
  vetQuestionsDrawer.setAttribute("aria-hidden", "true");
  vetQuestionsDrawer.inert = true;
  vetQuestionsBackdrop.classList.remove("is-open");
  window.setTimeout(() => {
    if (!vetQuestionsDrawer.classList.contains("is-open")) {
      vetQuestionsBackdrop.hidden = true;
    }
  }, 250);
  vetQuestionsToggle?.setAttribute("aria-expanded", "false");
  document.body.classList.remove("vet-questions-drawer-open");
  vetQuestionsTrigger?.focus();
}

function handleVetQuestionsDrawerKeydown(event) {
  if (!vetQuestionsDrawer?.classList.contains("is-open")) return;
  if (event.key === "Escape") {
    closeVetQuestionsDrawer();
    return;
  }
  if (event.key !== "Tab") return;

  const focusable = vetQuestionsDrawer.querySelectorAll(
    'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
  );
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (!first || !last) {
    event.preventDefault();
    vetQuestionsClose?.focus();
  } else if (!vetQuestionsDrawer.contains(document.activeElement)) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  } else if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function questionEmpty(text) {
  const element = document.createElement("p");
  element.className = "cs-message";
  element.textContent = text;
  return element;
}

function renderVetQuestion(question, isAnswered) {
  const card = document.createElement("article");
  card.className = `vet-question${isAnswered ? " is-answered" : ""}`;
  const top = document.createElement("div");
  top.className = "vet-question-top";
  top.textContent = `${question.ownerName || "Pet owner"} · Pet: ${question.petName || "Unknown pet"}`;
  const askedBy = document.createElement("span");
  askedBy.textContent = `from ${question.askedByName || "staff"}`;
  top.appendChild(askedBy);
  const text = document.createElement("div");
  text.className = "vet-question-text";
  text.textContent = question.question || "";
  card.append(top, text);
  if (question.fileUrl && question.fileName) {
    let attachmentUrl;
    try {
      attachmentUrl = new URL(question.fileUrl);
    } catch (error) {
      console.error("Could not display vet question attachment URL:", error);
    }
    if (attachmentUrl?.protocol === "https:") {
      const attachment = document.createElement("a");
      attachment.href = attachmentUrl.href;
      attachment.target = "_blank";
      attachment.rel = "noopener noreferrer";
      attachment.textContent = `View attachment: ${question.fileName}`;
      card.appendChild(attachment);
    }
  }
  if (isAnswered) {
    const answer = document.createElement("div");
    answer.className = "vet-question-text";
    answer.textContent = `Your answer: ${question.answer}`;
    card.appendChild(answer);
  } else {
    const row = document.createElement("div");
    row.className = "vet-question-answer";
    const input = document.createElement("textarea");
    input.placeholder = "Type your answer...";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "btn btn-primary";
    button.textContent = "Send answer";
    button.addEventListener("click", async () => {
      const answer = input.value.trim();
      if (!answer) return;
      button.disabled = true;
      try {
        const profile = await getUserProfileSnapshot(currentUser);
        const profileData = profile.exists() ? profile.data() : {};
        const messageRef = doc(collection(db, "chatRooms", question.conversationId, "messages"));
        const batch = writeBatch(db);
        batch.update(doc(db, "vet_questions", question.id), { answer, answeredAt: serverTimestamp(), answeredBy: currentUser.uid });
        batch.set(messageRef, {
          senderId: currentUser.uid,
          senderName: profileData.fullName || profileData.displayName || currentUser.displayName || "Veterinarian",
          senderRole: "veterinarian",
          sender_role: "vet",
          sender_type: "clinic",
          type: "internal_note",
          kind: "note",
          internalOnly: true,
          text: answer,
          body: answer,
          questionId: question.id,
          createdAt: serverTimestamp(),
          read: false
        });
        await batch.commit();
      } catch (error) {
        console.error("Could not answer staff question:", error);
        window.alert("Could not send the answer. Check your permissions.");
        button.disabled = false;
      }
    });
    row.append(input, button);
    card.appendChild(row);
  }
  return card;
}

/* ------------------------------------------------------------------
   DATA
------------------------------------------------------------------ */

function loadAppointments() {
  if (!table) return;

  unsubscribe?.();

  // Do not orderBy("createdAt") here: older documents may not have that
  // field. Sorting below also supports documents with createdAtMillis.
  unsubscribe = onSnapshot(
    collection(db, APPOINTMENTS_COLLECTION),
    (snapshot) => {
      allAppointments = snapshot.docs.map((d) => {
        const data = d.data();

        // Normalize field names used by the Android app and web dashboard.
        return {
          ...data,
          id: d.id,
          ownerName:
            data.ownerName ||
            data.petOwnerName ||
            data.userName ||
            "",
          ownerPhone:
            data.ownerPhone ||
            data.phone ||
            "",
          userId:
            data.userId ||
            data.ownerId ||
            data.petOwnerId ||
            "",
          petName:
            data.petName ||
            data.pet ||
            "",
          concern:
            data.concern ||
            data.concerns ||
            data.notes ||
            "",
          preferredDate:
            data.preferredDate ||
            data.date ||
            "",
          preferredTime:
            data.preferredTime ||
            data.time ||
            "",
          status: data.status || "Pending"
        };
      });

      allAppointments.sort((a, b) => {
        const aDate = toDateSafe(a.createdAt);
        const bDate = toDateSafe(b.createdAt);

        const aTime = aDate
          ? aDate.getTime()
          : Number(a.createdAtMillis || 0);

        const bTime = bDate
          ? bDate.getTime()
          : Number(b.createdAtMillis || 0);

        return bTime - aTime;
      });

      render();
    },
    (error) => {
      console.error("Could not load appointments:", error);
      showError(
        "Could not load appointments. Contact your IT Administrator."
      );
    }
  );
}

/* ------------------------------------------------------------------
   HELPERS
------------------------------------------------------------------ */

function escapeHTML(value) {
  const div = document.createElement("div");
  div.textContent = String(value ?? "");
  return div.innerHTML;
}

const STATUS_LABEL = {
  pending: "Pending",
  approved: "Confirmed",
  completed: "Completed",
  cancelled: "Cancelled"
};

function toDateSafe(value) {
  if (!value) return null;

  let date;

  if (typeof value.toDate === "function") {
    date = value.toDate();
  } else if (typeof value === "number") {
    date = new Date(value);
  } else {
    date = new Date(value);
  }

  return Number.isNaN(date.getTime()) ? null : date;
}

function localDateInputValue(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function matchesAppointmentDateRange(appointment) {
  if (!dateFrom && !dateTo) return true;

  const appointmentDate = parseDateOnly(appointment.preferredDate);
  if (!appointmentDate) return false;

  const date = localDateInputValue(appointmentDate);
  return (!dateFrom || date >= dateFrom) && (!dateTo || date <= dateTo);
}

function startOfToday() {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date;
}

function formatTime(value) {
  const parsed = parseTime(value);
  if (!parsed) return value || "";

  const date = new Date();
  date.setHours(parsed.hours, parsed.minutes, 0, 0);

  return date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit"
  });
}

function formatShortDate(date) {
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric"
  });
}

function dayDiff(date) {
  return Math.round((date - startOfToday()) / 86400000);
}

function dayLabel(date) {
  const diff = dayDiff(date);

  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff === -1) return "Yesterday";

  return date.toLocaleDateString("en-US", {
    weekday: "short"
  });
}

function isTomorrow(c) {
  const date = parseDateOnly(c.preferredDate);
  return !!date && dayDiff(date) === 1;
}

function getAppointment(c) {
  const date = parseDateOnly(c.preferredDate);
  const time = parseTime(c.preferredTime);

  if (!date || !time) return null;

  const when = new Date(date);
  when.setHours(time.hours, time.minutes, 0, 0);

  return when;
}

function getInitials(name) {
  return String(name || "?").trim().slice(0, 2).toUpperCase() || "?";
}

function avatarIndex(id) {
  let hash = 0;

  for (const ch of String(id)) {
    hash = (hash * 31 + ch.charCodeAt(0)) % 5;
  }

  return hash;
}

function hasBeenReminded(c) {
  return !!c.lastReminderAt;
}

function remindableTomorrow() {
  return allAppointments.filter(
    (c) =>
      statusKey(c) === "approved" &&
      isTomorrow(c) &&
      !hasBeenReminded(c)
  );
}

function createAppointmentAdminControls() {
  if (!adminControls || adminControls.childElementCount) return;
  const bar = adminControls.closest(".cs-bar");
  if (!bar) return;

  const editButton = document.createElement("button");
  editButton.type = "button";
  editButton.className = "btn btn-sm btn-outline-danger";
  editButton.title = "Select appointments to delete";
  editButton.setAttribute("aria-label", "Enter appointment selection mode");
  editButton.innerHTML = '<i class="bi bi-pencil" aria-hidden="true"></i> Edit';

  const selectAllLabel = document.createElement("label");
  selectAllLabel.className = "cs-select-all";
  selectAllLabel.innerHTML = '<input type="checkbox" class="form-check-input m-0" aria-label="Select all visible appointments">Select all';
  const selectAllCheckbox = selectAllLabel.querySelector("input");

  const selectedCount = document.createElement("span");
  selectedCount.className = "cs-selection-count";

  const deleteButton = document.createElement("button");
  deleteButton.type = "button";
  deleteButton.className = "btn btn-sm btn-outline-danger";
  deleteButton.innerHTML = '<i class="bi bi-trash" aria-hidden="true"></i> Delete Selected';

  const cancelButton = document.createElement("button");
  cancelButton.type = "button";
  cancelButton.className = "btn btn-sm btn-outline-secondary";
  cancelButton.textContent = "Cancel";

  const updateControls = () => {
    editButton.hidden = selectionMode;
    appointmentSelectionControls.hidden = !selectionMode;
    selectedCount.textContent = `${selectedAppointmentIds.size} selected`;
    deleteButton.disabled = !selectedAppointmentIds.size || isDeletingAppointments;
    cancelButton.disabled = isDeletingAppointments;
    editButton.disabled = isDeletingAppointments;

    const visibleIds = [...table.querySelectorAll("tr[data-id]")]
      .map((row) => row.dataset.id);
    const selectedVisible = visibleIds.filter((id) => selectedAppointmentIds.has(id));
    selectAllCheckbox.checked = visibleIds.length > 0 && selectedVisible.length === visibleIds.length;
    selectAllCheckbox.indeterminate = selectedVisible.length > 0 && selectedVisible.length < visibleIds.length;
  };

  editButton.addEventListener("click", () => {
    if (isDeletingAppointments) return;
    selectionMode = !selectionMode;
    selectedAppointmentIds.clear();
    render();
  });

  selectAllCheckbox.addEventListener("change", () => {
    if (!selectionMode || isDeletingAppointments) return;
    table.querySelectorAll("tr[data-id]").forEach((row) => {
      if (selectAllCheckbox.checked) selectedAppointmentIds.add(row.dataset.id);
      else selectedAppointmentIds.delete(row.dataset.id);
    });
    render();
  });

  deleteButton.addEventListener("click", deleteSelectedAppointments);
  cancelButton.addEventListener("click", () => {
    if (isDeletingAppointments) return;
    selectionMode = false;
    selectedAppointmentIds.clear();
    render();
  });

  adminControls.append(editButton);
  appointmentSelectionControls = document.createElement("div");
  appointmentSelectionControls.className = "cs-selection-controls";
  appointmentSelectionControls.setAttribute("role", "group");
  appointmentSelectionControls.setAttribute("aria-label", "Appointment selection actions");
  appointmentSelectionControls.hidden = true;
  appointmentSelectionControls.append(
    selectAllLabel,
    selectedCount,
    deleteButton,
    cancelButton
  );
  bar.insertAdjacentElement("afterend", appointmentSelectionControls);
  adminControls.updateControls = updateControls;
  updateControls();
}

/* ------------------------------------------------------------------
   RENDER
------------------------------------------------------------------ */

function renderActions(c) {
  const status = statusKey(c);

  if (status === "pending") {
    return `
      <div class="cs-actions">
        <details class="cs-action-menu">
          <summary class="cs-action-trigger" aria-label="Appointment actions" title="Appointment actions">
            <i class="bi bi-three-dots-vertical" aria-hidden="true"></i>
          </summary>
          <div class="cs-action-menu-items" role="group" aria-label="Appointment actions">
            <button type="button" class="cs-sm cs-sm-ok" data-action="approve">
              <i class="bi bi-check-lg"></i> Confirm
            </button>
            <button type="button" class="cs-sm" data-action="cancel">
              <i class="bi bi-x-lg"></i> Cancel
            </button>
          </div>
        </details>
      </div>`;
  }

  if (status === "approved") {
    let reminderStatus = "";
    let reminderAction;

    if (hasBeenReminded(c)) {
      const sentAt = toDateSafe(c.lastReminderAt) || new Date();

      reminderStatus = `
        <span class="cs-reminded">
          <i class="bi bi-check2-circle"></i>
          Reminded ${escapeHTML(formatShortDate(sentAt))}
        </span>`;
      reminderAction = `
        <button type="button" class="cs-sm cs-sm-icon" data-action="remind"
          title="Send again" aria-label="Send reminder again">
          <i class="bi bi-bell"></i> Send again
        </button>`;
    } else if (c.reminderScheduledAt) {
      const when = toDateSafe(c.reminderScheduledAt);
      const label = when
        ? `${formatShortDate(when)}, ${when.toLocaleTimeString("en-US", {
            hour: "numeric",
            minute: "2-digit"
          })}`
        : "";

      reminderStatus = `
        <span class="cs-scheduled">
          <i class="bi bi-clock"></i>
          Scheduled ${escapeHTML(label)}
        </span>`;
      reminderAction = `
        <button type="button" class="cs-sm cs-sm-icon" data-action="remind"
          title="Send now or reschedule"
          aria-label="Send or reschedule reminder">
          <i class="bi bi-bell"></i> Reminder
        </button>`;
    } else {
      reminderAction = `
        <button type="button" class="cs-sm" data-action="remind">
          <i class="bi bi-bell"></i> Remind
        </button>`;
    }

    return `
      <div class="cs-actions">
        ${reminderStatus}
        <details class="cs-action-menu">
          <summary class="cs-action-trigger" aria-label="Appointment actions" title="Appointment actions">
            <i class="bi bi-three-dots-vertical" aria-hidden="true"></i>
          </summary>
          <div class="cs-action-menu-items" role="group" aria-label="Appointment actions">
            ${reminderAction}
            <button type="button" class="cs-sm cs-sm-ok" data-action="complete">
              <i class="bi bi-check-lg"></i> Done
            </button>
            <button type="button" class="cs-sm" data-action="reschedule">
              <i class="bi bi-calendar2-week"></i> Reschedule
            </button>
            <button type="button" class="cs-sm" data-action="cancel">
              <i class="bi bi-x-lg"></i> Cancel
            </button>
          </div>
        </details>
      </div>`;
  }

  return `<span class="cs-dash">-</span>`;
}

function renderRow(c) {
  const status = statusKey(c);
  const date = parseDateOnly(c.preferredDate);
  const time = formatTime(c.preferredTime);

  const scheduleTop = date ? dayLabel(date) : "-";
  const scheduleBottom = [
    date ? formatShortDate(date) : "",
    time
  ].filter(Boolean).join(", ");
  const selectionCheckbox = selectionMode
    ? `<input type="checkbox" class="form-check-input m-0 cs-selection-checkbox"
        data-appointment-id="${escapeHTML(c.id)}"
        ${selectedAppointmentIds.has(c.id) ? "checked" : ""}
        aria-label="Select appointment for deletion">`
    : "";

  return `
    <tr data-id="${escapeHTML(c.id)}">
      <td>
        <div class="cs-pet">
          ${selectionCheckbox}
          <span class="cs-avatar cs-av-${avatarIndex(c.id)}">
            ${escapeHTML(getInitials(c.petName))}
          </span>
          <div class="cs-text">
            <strong>${escapeHTML(c.petName || "-")}</strong>
            <span>${escapeHTML(c.ownerName || "-")}</span>
          </div>
        </div>
      </td>
      <td>${escapeHTML(c.concern || "-")}</td>
      <td>
        <div class="cs-text">
          <strong>${escapeHTML(scheduleTop)}</strong>
          <span>${escapeHTML(scheduleBottom || "-")}</span>
        </div>
      </td>
      <td>
        <span class="cs-badge cs-badge-${escapeHTML(status)}">
          ${escapeHTML(STATUS_LABEL[status] || c.status || "Pending")}
        </span>
      </td>
      <td>${renderActions(c)}</td>
    </tr>`;
}

function appointmentOwnerKey(appointment) {
  const ownerId =
    appointment.userId ||
    appointment.ownerId ||
    appointment.petOwnerId ||
    appointment.ownerUid ||
    appointment.owner_uid;

  if (ownerId) return `owner:${ownerId}`;

  const ownerName = String(
    appointment.ownerName ||
    appointment.petOwnerName ||
    appointment.userName ||
    ""
  ).trim().toLowerCase();

  return ownerName
    ? `name:${ownerName}`
    : `appointment:${appointment.id}`;
}

function renderOwnerGroup(group) {
  const isExpanded =
    selectionMode || expandedAppointmentOwners.has(group.key);
  const toggleLabel = `${isExpanded ? "Collapse" : "Expand"} appointments for ${group.name}`;
  const groupRow = `
    <tr class="cs-owner-group-row">
      <td colspan="5">
        <button
          type="button"
          class="cs-owner-group-toggle"
          data-owner-group="${escapeHTML(group.key)}"
          aria-expanded="${isExpanded}"
          aria-label="${escapeHTML(toggleLabel)}"
        >
          <i class="bi ${isExpanded ? "bi-chevron-down" : "bi-chevron-right"}" aria-hidden="true"></i>
          <span class="cs-owner-group-name">${escapeHTML(group.name)}</span>
          <span class="cs-owner-group-count">${group.appointments.length} appointment${group.appointments.length === 1 ? "" : "s"}</span>
        </button>
      </td>
    </tr>`;

  return groupRow + (
    isExpanded
      ? group.appointments.map(renderRow).join("")
      : ""
  );
}

function render() {
  if (!table) return;

  const pending = allAppointments.filter(
    (c) => statusKey(c) === "pending"
  ).length;

  const tomorrow = allAppointments.filter((c) => {
    const status = statusKey(c);
    return (
      (status === "pending" || status === "approved") &&
      isTomorrow(c)
    );
  }).length;

  const weekAgo = Date.now() - 7 * 86400000;

  const remindersThisWeek = allAppointments.filter((c) => {
    const sent = toDateSafe(c.lastReminderAt);
    return sent && sent.getTime() >= weekAgo;
  }).length;

  if (statPending) statPending.textContent = String(pending);
  if (statTomorrow) statTomorrow.textContent = String(tomorrow);
  if (statReminders) statReminders.textContent = String(remindersThisWeek);
  if (bulkCount) bulkCount.textContent = String(remindableTomorrow().length);

  const term = (searchInput?.value || "").trim().toLowerCase();

  const filtered = allAppointments.filter((c) => {
    if (activeFilter !== "all" && statusKey(c) !== activeFilter) {
      return false;
    }

    if (!matchesAppointmentDateRange(c)) return false;

    return `${c.petName || ""} ${c.ownerName || ""} ${c.concern || ""}`
      .toLowerCase()
      .includes(term);
  });

  if (filtered.length === 0) {
    showMoreButton?.setAttribute("hidden", "");
    if (footer) {
      footer.textContent =
        `Showing 0 of ${allAppointments.length} appointments`;
    }
    table.innerHTML = `
      <tr>
        <td colspan="5" class="cs-message">
          ${allAppointments.length === 0
            ? "No appointment requests yet."
            : "No appointments match your filters."}
        </td>
      </tr>`;
    return;
  }

  const ownerGroups = new Map();
  filtered.forEach((appointment) => {
    const key = appointmentOwnerKey(appointment);
    let group = ownerGroups.get(key);
    if (!group) {
      group = {
        key,
        name:
          appointment.ownerName ||
          appointment.petOwnerName ||
          appointment.userName ||
          "Unknown pet owner",
        appointments: []
      };
      ownerGroups.set(key, group);
    }
    group.appointments.push(appointment);
  });

  const groups = [...ownerGroups.values()];
  const isShowingAll = showAllAppointments || selectionMode;
  const visibleGroups = isShowingAll
    ? groups
    : groups.slice(0, APPOINTMENTS_PAGE_SIZE);

  if (requestedAppointmentId) {
    const requestedAppointment = filtered.find(
      (appointment) => appointment.id === requestedAppointmentId
    );
    if (requestedAppointment) {
      const requestedOwnerKey = appointmentOwnerKey(requestedAppointment);
      expandedAppointmentOwners.add(requestedOwnerKey);
      if (!visibleGroups.some((group) => group.key === requestedOwnerKey)) {
        visibleGroups.push(ownerGroups.get(requestedOwnerKey));
      }
    }
  }

  table.innerHTML = visibleGroups.map(renderOwnerGroup).join("");
  const visibleAppointmentCount = visibleGroups.reduce(
    (count, group) => count + group.appointments.length,
    0
  );

  if (showMoreButton) {
    const hasMore = groups.length > APPOINTMENTS_PAGE_SIZE && !selectionMode;
    showMoreButton.hidden = !hasMore;
    showMoreButton.textContent = isShowingAll
      ? "Show fewer pet owners"
      : `Show remaining pet owners (${groups.length - visibleGroups.length})`;
  }
  if (footer) {
    footer.textContent =
      `Showing ${visibleGroups.length} of ${groups.length} pet owners · ${visibleAppointmentCount} appointments`;
  }

  adminControls?.updateControls?.();

  if (requestedAppointmentId) {
    const targetRow = Array.from(
      table.querySelectorAll("tr[data-id]")
    ).find((row) => row.dataset.id === requestedAppointmentId);

    if (targetRow) {
      targetRow.classList.add("cs-row-highlight");
      targetRow.scrollIntoView({ behavior: "smooth", block: "center" });
      requestedAppointmentId = null;
    }
  }
}

function showError(message) {
  if (!table) return;

  table.innerHTML = `
    <tr>
      <td colspan="5" class="cs-message cs-error-text">
        ${escapeHTML(message)}
      </td>
    </tr>`;
}

/* ------------------------------------------------------------------
   STATUS ACTIONS
------------------------------------------------------------------ */

async function setStatus(appointment, status, reason = "", reschedule = null) {
  const appointmentRef = doc(db, APPOINTMENTS_COLLECTION, appointment.id);
  const nextStatus = status.toLowerCase();
  const isReschedule = nextStatus === "cancelled" && Boolean(reschedule);
  const cancellationReason = String(reason).trim().replace(/\s*\n\s*/g, " ") ||
    (isReschedule ? "Rescheduled by clinic" : "");
  const rescheduledDate = String(reschedule?.date || "").trim();
  const rescheduledTime = String(reschedule?.time || "").trim();

  if (nextStatus === "cancelled" && !isReschedule && !cancellationReason) {
    alert("Please provide a reason for cancelling this appointment.");
    return false;
  }

  if (isReschedule) {
    const dateParts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(rescheduledDate);
    const timeParts = /^(\d{2}):(\d{2})$/.exec(rescheduledTime);
    const newSchedule = new Date(`${rescheduledDate}T${rescheduledTime}:00`);
    const validDate = dateParts &&
      localDateInputValue(new Date(
        Number(dateParts[1]),
        Number(dateParts[2]) - 1,
        Number(dateParts[3])
      )) === rescheduledDate;
    const validTime = timeParts &&
      Number(timeParts[1]) < 24 &&
      Number(timeParts[2]) < 60;

    if (
      !validDate ||
      !validTime ||
      Number.isNaN(newSchedule.getTime()) ||
      newSchedule <= new Date()
    ) {
      alert("Choose a valid future date and time for the replacement appointment.");
      return false;
    }

    const currentDate = parseDateOnly(
      appointment.preferredDate || appointment.date
    );
    const currentTime = parseTime(
      appointment.preferredTime || appointment.time
    );
    if (
      currentDate &&
      currentTime &&
      localDateInputValue(currentDate) === rescheduledDate &&
      currentTime.hours === Number(timeParts[1]) &&
      currentTime.minutes === Number(timeParts[2])
    ) {
      alert("Choose a different date or time to reschedule this appointment.");
      return false;
    }
  }

  const replacementAppointmentRef = isReschedule
    ? doc(collection(db, APPOINTMENTS_COLLECTION))
    : null;
  const rescheduledSlotId = isReschedule
    ? `${rescheduledDate}_${rescheduledTime}`
    : "";
  const rescheduledSlotRef = isReschedule
    ? doc(db, "bookedSlots", rescheduledSlotId)
    : null;
  const isVeterinarian = ["vet", "veterinarian"].includes(currentRole);
  let veterinarianRoomData = null;
  if (isVeterinarian && appointment.sourceRoomId) {
    try {
      const roomSnapshot = await getDoc(
        doc(db, "chatRooms", appointment.sourceRoomId)
      );
      if (roomSnapshot.exists()) {
        veterinarianRoomData = roomSnapshot.data();
      }
    } catch (error) {
      console.warn("Could not check veterinarian chat access:", error);
    }
  }

  try {
    const [
      slotsOnRescheduledDate,
      consultationsOnPreferredDate,
      consultationsOnLegacyDate
    ] = isReschedule
      ? await Promise.all([
          getDocs(query(
            collection(db, "bookedSlots"),
            where("date", "==", rescheduledDate)
          )),
          getDocs(query(
            collection(db, APPOINTMENTS_COLLECTION),
            where("preferredDate", "==", rescheduledDate)
          )),
          getDocs(query(
            collection(db, APPOINTMENTS_COLLECTION),
            where("date", "==", rescheduledDate)
          ))
        ])
      : [null, null, null];

    const result = await runTransaction(db, async (transaction) => {
      const appointmentSnapshot = await transaction.get(appointmentRef);
      if (!appointmentSnapshot.exists()) {
        throw new Error("This appointment no longer exists.");
      }

      const currentAppointment = appointmentSnapshot.data();
      const currentStatus = statusKey(currentAppointment);
      const ownerId =
        currentAppointment.userId ||
        currentAppointment.ownerId ||
        currentAppointment.petOwnerId ||
        appointment.userId ||
        "";
      const shouldNotifyOwner =
        (nextStatus === "approved" || nextStatus === "cancelled") &&
        (currentStatus === "pending" || currentStatus === "approved") &&
        Boolean(ownerId);
      const roomId =
        currentAppointment.sourceRoomId ||
        appointment.sourceRoomId ||
        "";
      const roomRef = roomId ? doc(db, "chatRooms", roomId) : null;
      const veterinarianCanWriteRoom =
        veterinarianRoomData?.chat_status === "ESCALATED" &&
        veterinarianRoomData.escalatedVetId === auth.currentUser?.uid;
      const shouldCheckRoom =
        ["admin", "staff"].includes(currentRole) ||
        (isVeterinarian && veterinarianCanWriteRoom);
      const roomSnapshot = roomRef && shouldCheckRoom
        ? await transaction.get(roomRef)
        : null;
      const roomData = roomSnapshot?.exists()
        ? roomSnapshot.data()
        : null;
      const canWriteChatEvent = Boolean(roomData) &&
        (
          ["admin", "staff"].includes(currentRole) ||
          (
            isVeterinarian &&
            roomData.chat_status === "ESCALATED" &&
            roomData.escalatedVetId === auth.currentUser?.uid &&
            String(roomData.status || "").toLowerCase() !== "resolved"
          )
        );
      const isStatusEventTransition =
        (nextStatus === "approved" || nextStatus === "cancelled") &&
        (currentStatus === "pending" || currentStatus === "approved");
      const isCompletionEventTransition = nextStatus === "completed";
      const chatEventExpected =
        isStatusEventTransition || isCompletionEventTransition;
      const shouldCreateStatusEvent =
        isStatusEventTransition && canWriteChatEvent;
      const statusMessageRef = shouldCreateStatusEvent
        ? doc(
            db,
            "chatRooms",
            roomId,
            "messages",
            `appointment_status_${appointment.id}_${nextStatus}`
          )
        : null;
      const completionEventRef = isCompletionEventTransition &&
        canWriteChatEvent
        ? doc(
            db,
            "chatRooms",
            roomId,
            "messages",
            `appointment_completed_${appointment.id}`
          )
        : null;
      const isAllowedTransition =
        (currentStatus === "pending" &&
          (nextStatus === "approved" || nextStatus === "cancelled")) ||
        (currentStatus === "approved" &&
          (nextStatus === "approved" ||
            nextStatus === "completed" ||
            nextStatus === "cancelled"));
      const notificationRef = shouldNotifyOwner
        ? doc(
            db,
            NOTIFICATIONS_COLLECTION,
            `appointment_status_${appointment.id}_${nextStatus}`
          )
        : null;
      const existingNotification = notificationRef
        ? await transaction.get(notificationRef)
        : null;
      const existingStatusMessage = statusMessageRef
        ? await transaction.get(statusMessageRef)
        : null;
      const existingCompletionEvent = completionEventRef
        ? await transaction.get(completionEventRef)
        : null;
      const replacementSnapshot = replacementAppointmentRef
        ? await transaction.get(replacementAppointmentRef)
        : null;
      const rescheduledSlotSnapshot = rescheduledSlotRef
        ? await transaction.get(rescheduledSlotRef)
        : null;

      if (!isAllowedTransition) {
        return { updated: false, notifiedOwner: false };
      }
      if (replacementSnapshot?.exists()) {
        throw new Error("Could not create a unique replacement appointment. Please try again.");
      }
      const rescheduledTimeParts = parseTime(rescheduledTime);
      if (
        rescheduledSlotSnapshot?.exists() ||
        slotsOnRescheduledDate?.docs.some((slot) => {
          const slotTime = parseTime(slot.data().time);
          return slotTime?.hours === rescheduledTimeParts?.hours &&
            slotTime?.minutes === rescheduledTimeParts?.minutes;
        })
      ) {
        throw new Error("That appointment time is already booked. Choose another date or time.");
      }
      const hasConfirmedAppointmentAtTime = [
        ...(consultationsOnPreferredDate?.docs || []),
        ...(consultationsOnLegacyDate?.docs || [])
      ].some((consultation) => {
        if (consultation.id === appointment.id) return false;
        const data = consultation.data();
        const scheduledTime = parseTime(
          data.preferredTime || data.time
        );
        return statusKey(data) === "approved" &&
          scheduledTime?.hours === rescheduledTimeParts?.hours &&
          scheduledTime?.minutes === rescheduledTimeParts?.minutes;
      });
      if (hasConfirmedAppointmentAtTime) {
        throw new Error("That appointment time is already booked. Choose another date or time.");
      }

      transaction.update(appointmentRef, {
        status,
        statusLower: nextStatus,
        ...(nextStatus === "cancelled" ? { cancellationReason } : {}),
        updatedAt: serverTimestamp()
      });

      const slotId = currentAppointment.slotId;
      if (
        nextStatus === "cancelled" &&
        typeof slotId === "string" &&
        slotId.trim()
      ) {
        transaction.delete(doc(db, "bookedSlots", slotId));
      }

      if (replacementAppointmentRef) {
        const replacementData = { ...currentAppointment };
        [
          "slotId",
          "lastReminderAt",
          "reminderCount",
          "reminderScheduledAt",
          "cancellationReason",
          "cancelledAt",
          "cancelledBy"
        ].forEach((key) => delete replacementData[key]);

        transaction.set(replacementAppointmentRef, {
          ...replacementData,
          userId: ownerId,
          ownerName:
            currentAppointment.ownerName ||
            currentAppointment.petOwnerName ||
            currentAppointment.userName ||
            "",
          petName:
            currentAppointment.petName ||
            currentAppointment.pet ||
            "",
          preferredDate: rescheduledDate,
          preferredTime: rescheduledTime,
          date: rescheduledDate,
          time: rescheduledTime,
          slotId: rescheduledSlotId,
          status: "Approved",
          statusLower: "approved",
          source: "web_reschedule",
          rescheduledFrom: appointment.id,
          rescheduledBy: auth.currentUser?.uid || "",
          rescheduledAt: serverTimestamp(),
          createdAt: serverTimestamp(),
          createdAtMillis: Date.now(),
          updatedAt: serverTimestamp()
        });
        transaction.set(rescheduledSlotRef, {
          ownerId,
          appointmentId: replacementAppointmentRef.id,
          consultationId: replacementAppointmentRef.id,
          date: rescheduledDate,
          time: rescheduledTime,
          source: "web_reschedule",
          createdBy: auth.currentUser?.uid || "",
          createdAt: serverTimestamp()
        });
      }

      if (completionEventRef && !existingCompletionEvent.exists()) {
        const petName =
          currentAppointment.petName ||
          currentAppointment.pet ||
          appointment.petName ||
          "your pet";
        const completedAt = new Date();
        const completionMessage =
          `Appointment for ${petName} was completed on ${completedAt.toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
            year: "numeric"
          })}.`;

        transaction.set(completionEventRef, {
          senderId: auth.currentUser?.uid || "",
          senderName: "SkinPawsible Clinic",
          senderRole: "Clinic",
          sender_role: "clinic",
          sender_type: "clinic",
          type: "appointment_event",
          kind: "appointment_event",
          internalOnly: false,
          text: completionMessage,
          body: completionMessage,
          appointmentId: appointment.id,
          petName,
          event: "completed",
          timestamp: completedAt.getTime(),
          createdAt: serverTimestamp(),
          read: false
        });

        if (roomRef && canWriteChatEvent) {
          transaction.update(roomRef, {
            lastMessage: completionMessage,
            lastMessageAt: serverTimestamp(),
            lastMessageInternal: false
          });
        }
      }

      if (notificationRef || statusMessageRef) {
        const petName =
          currentAppointment.petName ||
          currentAppointment.pet ||
          appointment.petName ||
          "your pet";
        const date =
          currentAppointment.preferredDate ||
          currentAppointment.date ||
          appointment.preferredDate ||
          "";
        const time =
          currentAppointment.preferredTime ||
          currentAppointment.time ||
          appointment.preferredTime ||
          "";
        const appointmentDate = parseDateOnly(date);
        const formattedDate = appointmentDate
          ? appointmentDate.toLocaleDateString("en-US", {
              month: "short",
              day: "numeric",
              year: "numeric"
            })
          : "Not specified";
        const parsedTime = parseTime(time);
        let formattedTime = "";
        if (parsedTime) {
          const appointmentTime = new Date();
          appointmentTime.setHours(
            parsedTime.hours,
            parsedTime.minutes,
            0,
            0
          );
          formattedTime = appointmentTime
            .toLocaleTimeString("en-US", {
              hour: "2-digit",
              minute: "2-digit",
              hour12: true
            })
            .toLowerCase();
        }
        const structuredPreviousDate = appointmentDate
          ? localDateInputValue(appointmentDate)
          : String(date || "");
        const structuredPreviousTime = parsedTime
          ? `${String(parsedTime.hours).padStart(2, "0")}:${String(parsedTime.minutes).padStart(2, "0")}`
          : String(time || "");
        const replacementDate = parseDateOnly(rescheduledDate);
        const formattedReplacementDate = replacementDate
          ? replacementDate.toLocaleDateString("en-US", {
              month: "short",
              day: "numeric",
              year: "numeric"
            })
          : "";
        const parsedReplacementTime = parseTime(rescheduledTime);
        let formattedReplacementTime = "";
        if (parsedReplacementTime) {
          const replacementTime = new Date();
          replacementTime.setHours(
            parsedReplacementTime.hours,
            parsedReplacementTime.minutes,
            0,
            0
          );
          formattedReplacementTime = replacementTime
            .toLocaleTimeString("en-US", {
              hour: "2-digit",
              minute: "2-digit",
              hour12: true
            })
            .toLowerCase();
        }
        const eventName = nextStatus === "approved"
          ? "appointment_approved"
          : isReschedule
            ? "appointment_rescheduled"
            : "appointment_cancelled";
        const statusMessage = nextStatus === "approved"
          ? `Your appointment request for ${petName} on ${formattedDate}${formattedTime ? ` at ${formattedTime}` : ""} has been approved.`
          : isReschedule
            ? `Your appointment for ${petName} on ${formattedDate}${formattedTime ? ` at ${formattedTime}` : ""} has been rescheduled and confirmed for ${formattedReplacementDate} at ${formattedReplacementTime}.`
            : `Your appointment for ${petName} on ${formattedDate}${formattedTime ? ` at ${formattedTime}` : ""} was cancelled. Reason: ${cancellationReason}.`;
        let chatLastMessage = "";

        if (
          statusMessageRef &&
          (!existingStatusMessage.exists() || nextStatus === "cancelled")
        ) {
          transaction.set(statusMessageRef, {
            senderId: auth.currentUser?.uid || "",
            senderName: "SkinPawsible Clinic",
            senderRole: "Clinic",
            sender_role: "clinic",
            senderType: "clinic",
            sender_type: "clinic",
            type: "appointment_event",
            kind: "appointment_event",
            schemaVersion: 1,
            event: eventName,
            internalOnly: false,
            text: statusMessage,
            body: statusMessage,
            appointmentId: replacementAppointmentRef?.id || appointment.id,
            consultationId: replacementAppointmentRef?.id || appointment.id,
            originalAppointmentId: appointment.id,
            sourceRoomId: roomId,
            petName,
            status: isReschedule ? "approved" : nextStatus,
            previousDate: structuredPreviousDate,
            previousTime: structuredPreviousTime,
            ...(isReschedule && {
              newDate: rescheduledDate,
              newTime: rescheduledTime,
              rescheduledFrom: appointment.id
            }),
            ...(nextStatus === "cancelled" && !isReschedule && {
              cancellationReason,
              cancel_reason: cancellationReason
            }),
            timestamp: Date.now(),
            createdAt: serverTimestamp(),
            read: false
          });
          chatLastMessage = statusMessage;
        }

        if (chatLastMessage && roomRef && canWriteChatEvent) {
          transaction.update(roomRef, {
            lastMessage: chatLastMessage,
            lastMessageAt: serverTimestamp(),
            lastMessageInternal: false
          });
        }

        if (notificationRef && !existingNotification.exists()) {
          transaction.set(notificationRef, {
            userId: ownerId,
            type: "APPOINTMENT_STATUS",
            schemaVersion: 1,
            event: eventName,
            targetScreen: "CONSULTATIONS",
            targetId: roomId,
            roomId,
            appointmentId: replacementAppointmentRef?.id || appointment.id,
            consultationId: replacementAppointmentRef?.id || appointment.id,
            ...(roomId && { sourceRoomId: roomId }),
            ...(isReschedule && {
              originalAppointmentId: appointment.id,
              cancelledAppointmentId: appointment.id,
              rescheduledFrom: appointment.id,
              previousDate: structuredPreviousDate,
              previousTime: structuredPreviousTime,
              newDate: rescheduledDate,
              newTime: rescheduledTime
            }),
            ...(!isReschedule && nextStatus === "cancelled" && {
              cancellationReason
            }),
            petName,
            title: nextStatus === "approved"
              ? "Appointment approved"
              : isReschedule
                ? "Appointment rescheduled"
                : "Appointment cancelled",
            message: statusMessage,
            isRead: false,
            read: false,
            sentBy: auth.currentUser?.uid || "",
            createdAtMillis: Date.now(),
            timestamp: new Date().toLocaleString(),
            createdAt: serverTimestamp()
          });
        }
      }

      return {
        updated: true,
        notifiedOwner: Boolean(notificationRef),
        replacementAppointmentId: replacementAppointmentRef?.id || "",
        chatEventAvailable:
          !chatEventExpected || Boolean(canWriteChatEvent)
      };
    });

    if (!result.updated) {
      alert("This appointment has already changed. Refresh the page to see its current status.");
    } else if (!result.chatEventAvailable) {
      alert(
        "The appointment was updated, but no chat event was posted. " +
        "Check that the appointment is linked to a chat room and, for veterinarians, " +
        "that you are assigned to its escalated conversation."
      );
    } else if (
      (nextStatus === "approved" || nextStatus === "cancelled") &&
      !result.notifiedOwner
    ) {
      alert(
        isReschedule
          ? "The replacement schedule was created, but this request has no linked owner account to notify."
          : "The appointment status was updated, but this request has no linked owner account to notify."
      );
    }
    return result.updated;
  } catch (error) {
    console.error("Could not update appointment:", error);
    alert("Could not update this appointment: " + error.message);
    return false;
  }
}

/* ------------------------------------------------------------------
   DELETE APPOINTMENT
------------------------------------------------------------------ */

async function deleteSelectedAppointments() {
  if (!["admin", "staff"].includes(currentRole) || isDeletingAppointments) return;

  const selected = allAppointments.filter((appointment) =>
    selectedAppointmentIds.has(appointment.id)
  );
  if (!selected.length) return;

  const confirmed = await window.SkinPawsibleDialogs.confirm(
    `Are you sure you want to delete ${selected.length} selected appointment(s)? This action cannot be undone.`,
    { title: "Delete appointments?", confirmText: "Delete", tone: "danger" }
  );
  if (!confirmed) return;

  isDeletingAppointments = true;
  adminControls?.updateControls?.();

  try {
    for (const appointment of selected) {
      await runTransaction(db, async (transaction) => {
        const appointmentRef = doc(db, APPOINTMENTS_COLLECTION, appointment.id);
        const appointmentSnapshot = await transaction.get(appointmentRef);
        if (!appointmentSnapshot.exists()) return;

        const appointmentData = appointmentSnapshot.data();
        const sourceRoomId = appointmentData.sourceRoomId;
        const sourceMessageId = appointmentSnapshot.data().sourceMessageId;
        const sourceMessageRef = sourceRoomId && sourceMessageId
          ? doc(
              db,
              "chatRooms",
              sourceRoomId,
              "messages",
              sourceMessageId
            )
          : null;
        const sourceMessageSnapshot = sourceMessageRef
          ? await transaction.get(sourceMessageRef)
          : null;

        transaction.delete(appointmentRef);
        const slotId = appointmentData.slotId;
        if (typeof slotId === "string" && slotId.trim()) {
          transaction.delete(doc(db, "bookedSlots", slotId));
        }
        if (sourceMessageRef && sourceMessageSnapshot?.exists()) {
          transaction.update(sourceMessageRef, {
            appointmentDeleted: true,
            appointmentDeletedAt: serverTimestamp()
          });
        }
      });
    }

    selectedAppointmentIds.clear();
    selectionMode = false;
  } catch (error) {
    console.error("Could not delete appointments:", error);
    alert(`Could not delete the selected appointments: ${error.message}`);
  } finally {
    isDeletingAppointments = false;
    render();
  }
}

/* ------------------------------------------------------------------
   REMINDERS
------------------------------------------------------------------ */

function defaultMessage(c) {
  const pet = c.petName || "your pet";
  const date = parseDateOnly(c.preferredDate);
  const time = formatTime(c.preferredTime);

  let when = "soon";

  if (date) {
    const diff = dayDiff(date);
    const short = formatShortDate(date);

    when =
      diff === 0 ? "today" :
      diff === 1 ? `tomorrow, ${short}` :
      `on ${short}`;
  }

  return `${pet}'s appointment is ${when}${time ? ` at ${time}` : ""}. Arrive 10 min early.`;
}

function previewText(c) {
  const pet = c.petName || "your pet";
  const date = parseDateOnly(c.preferredDate);
  const time = formatTime(c.preferredTime);

  let when = "";

  if (date) {
    const diff = dayDiff(date);
    when = diff === 0
      ? "today"
      : diff === 1
        ? "tomorrow"
        : formatShortDate(date);
  }

  return `Appointment reminder: ${pet}${when ? `, ${when}` : ""}${time ? ` at ${time}` : ""}`;
}

function openReminder(c) {
  if (!modalEl || !modalSubtitle || !messageInput || !previewEl || !errorEl) {
    alert("The reminder modal is missing required HTML elements.");
    return;
  }

  currentReminder = c;

  modalSubtitle.textContent =
    `For ${c.petName || "this pet"}, owner ${c.ownerName || "-"}.`;

  messageInput.value = defaultMessage(c);
  previewEl.textContent = previewText(c);
  errorEl.hidden = true;
  errorEl.textContent = "";

  const nowOption = modalEl.querySelector(
    'input[name="reminderWhen"][value="now"]'
  );

  if (nowOption) nowOption.checked = true;

  bootstrap.Modal.getOrCreateInstance(modalEl).show();
}

function writeReminder(batch, c, message, sendAt) {
  const notificationRef = doc(collection(db, NOTIFICATIONS_COLLECTION));
  const appointmentRef = doc(db, APPOINTMENTS_COLLECTION, c.id);
  const sendNow = !sendAt;

  batch.set(notificationRef, {
    userId: c.userId || "",
    type: "consultation_reminder",
    consultationId: c.id,
    appointmentId: c.id,
    petName: c.petName || "",
    title: "Appointment reminder",
    message,
    status: sendNow ? "sent" : "scheduled",
    sendAt: sendNow
      ? serverTimestamp()
      : Timestamp.fromDate(sendAt),
    read: false,
    sentBy: auth.currentUser?.uid || "",
    createdAt: serverTimestamp()
  });

  if (sendNow) {
    batch.update(appointmentRef, {
      lastReminderAt: serverTimestamp(),
      reminderCount: increment(1)
    });
  } else {
    batch.update(appointmentRef, {
      reminderScheduledAt: Timestamp.fromDate(sendAt)
    });
  }
}

async function submitReminder() {
  if (!currentReminder) return;

  const c = currentReminder;
  const message = messageInput.value.trim();
  const when =
    modalEl.querySelector('input[name="reminderWhen"]:checked')?.value ||
    "now";

  const fail = (text) => {
    errorEl.textContent = text;
    errorEl.hidden = false;
  };

  errorEl.hidden = true;

  if (!message) {
    fail("Enter a message for the owner.");
    return;
  }

  if (!c.userId) {
    fail("This request has no linked owner account, so the app can't receive it.");
    return;
  }

  let sendAt = null;

  if (when !== "now") {
    const appointment = getAppointment(c);

    if (!appointment) {
      fail("This request has no readable date and time. Choose Send now instead.");
      return;
    }

    const offset = when === "day"
      ? 24 * 3600000
      : 3600000;

    sendAt = new Date(appointment.getTime() - offset);

    if (sendAt <= new Date()) {
      fail("That time has already passed. Choose Send now instead.");
      return;
    }
  }

  sendBtn.disabled = true;

  try {
    const batch = writeBatch(db);
    writeReminder(batch, c, message, sendAt);
    await batch.commit();

    bootstrap.Modal.getOrCreateInstance(modalEl).hide();
    currentReminder = null;
  } catch (error) {
    console.error("Could not send reminders:", error);
    fail("Couldn't send the reminder. " + error.message);
  } finally {
    sendBtn.disabled = false;
  }
}

async function remindTomorrow() {
  const targets = remindableTomorrow();

  if (targets.length === 0) {
    alert(
      "No reminders to send. Everyone confirmed for tomorrow has already been reminded."
    );
    return;
  }

  const ok = await window.SkinPawsibleDialogs.confirm(
    `Send a reminder to ${targets.length} owner${targets.length === 1 ? "" : "s"} with a confirmed visit tomorrow?`,
    { title: "Send reminders?", confirmText: "Send" }
  );

  if (!ok) return;

  bulkBtn.disabled = true;

  let sent = 0;
  let skipped = 0;

  try {
    for (const c of targets) {
      if (!c.userId) {
        skipped++;
        continue;
      }

      const batch = writeBatch(db);
      writeReminder(batch, c, defaultMessage(c), null);
      await batch.commit();
      sent++;
    }

    if (skipped > 0) {
      alert(
        `Sent ${sent} reminder${sent === 1 ? "" : "s"}. Skipped ${skipped} with no linked owner account.`
      );
    }
  } catch (error) {
    console.error("Could not send reminders:", error);
    alert(
      `Sent ${sent} reminder${sent === 1 ? "" : "s"} before an error: ${error.message}`
    );
  } finally {
    bulkBtn.disabled = false;
  }
}

/* ------------------------------------------------------------------
   EVENTS
------------------------------------------------------------------ */

searchInput?.addEventListener("input", () => {
  showAllAppointments = false;
  render();
});

showMoreButton?.addEventListener("click", () => {
  showAllAppointments = !showAllAppointments;
  render();
});

appointmentDateFilterToggle?.addEventListener("click", () => {
  const isExpanded =
    appointmentDateFilterToggle.getAttribute("aria-expanded") === "true";
  appointmentDateFilterToggle.setAttribute("aria-expanded", String(!isExpanded));
  appointmentDateFilterPanel.hidden = isExpanded;
});

document.addEventListener("click", (event) => {
  if (
    appointmentDateFilterPanel &&
    appointmentDateFilterToggle &&
    !appointmentDateFilterPanel.hidden &&
    !appointmentDateFilterPanel.contains(event.target) &&
    !appointmentDateFilterToggle.contains(event.target)
  ) {
    appointmentDateFilterPanel.hidden = true;
    appointmentDateFilterToggle.setAttribute("aria-expanded", "false");
  }
});

document.addEventListener("keydown", (event) => {
  if (
    event.key === "Escape" &&
    appointmentDateFilterPanel &&
    !appointmentDateFilterPanel.hidden
  ) {
    appointmentDateFilterPanel.hidden = true;
    appointmentDateFilterToggle?.setAttribute("aria-expanded", "false");
    appointmentDateFilterToggle?.focus();
  }
});

appointmentDateFromInput?.addEventListener("change", () => {
  dateFrom = appointmentDateFromInput.value;
  showAllAppointments = false;
  appointmentDateFilterToggle?.classList.toggle(
    "has-date-filter",
    Boolean(dateFrom || dateTo)
  );
  render();
});

appointmentDateToInput?.addEventListener("change", () => {
  dateTo = appointmentDateToInput.value;
  showAllAppointments = false;
  appointmentDateFilterToggle?.classList.toggle(
    "has-date-filter",
    Boolean(dateFrom || dateTo)
  );
  render();
});

appointmentDateResetButton?.addEventListener("click", () => {
  dateFrom = "";
  dateTo = "";
  showAllAppointments = false;
  if (appointmentDateFromInput) appointmentDateFromInput.value = "";
  if (appointmentDateToInput) appointmentDateToInput.value = "";
  appointmentDateFilterToggle?.classList.remove("has-date-filter");
  render();
});

chips.forEach((chip) => {
  chip.addEventListener("click", () => {
    chips.forEach((item) => {
      const isActive = item === chip;
      item.classList.toggle("active", isActive);
      item.setAttribute("aria-pressed", String(isActive));
    });
    activeFilter = chip.dataset.filter || "all";
    showAllAppointments = false;
    render();
  });
});

table?.addEventListener("click", (event) => {
  const groupToggle = event.target.closest("[data-owner-group]");
  if (groupToggle) {
    const ownerKey = groupToggle.dataset.ownerGroup;
    if (expandedAppointmentOwners.has(ownerKey)) {
      expandedAppointmentOwners.delete(ownerKey);
    } else {
      expandedAppointmentOwners.add(ownerKey);
    }
    render();
    return;
  }

  const button = event.target.closest("[data-action]");
  if (!button) return;

  button.closest(".cs-action-menu")?.removeAttribute("open");
  const id = button.closest("tr")?.dataset.id;
  const appointment = allAppointments.find((c) => c.id === id);

  if (!appointment) return;

  switch (button.dataset.action) {
    case "approve":
      setStatus(appointment, "Approved");
      break;

    case "cancel":
      currentCancellation = appointment;
      cancelModalTrigger = button;
      cancelForm?.reset();
      bootstrap.Modal.getOrCreateInstance(cancelModalEl).show();
      break;

    case "reschedule":
      currentRescheduling = appointment;
      rescheduleModalTrigger = button;
      rescheduleForm?.reset();
      if (rescheduleDateInput) {
        rescheduleDateInput.min = localDateInputValue(new Date());
      }
      bootstrap.Modal.getOrCreateInstance(rescheduleModalEl).show();
      break;

    case "complete":
      setStatus(appointment, "Completed");
      break;

    case "remind":
      openReminder(appointment);
      break;

  }
});

table?.addEventListener("toggle", (event) => {
  const menu = event.target;
  if (!menu.matches(".cs-action-menu") || !menu.open) return;

  const items = menu.querySelector(".cs-action-menu-items");
  const tableViewport = menu.closest(".table-responsive");
  if (!items || !tableViewport) return;

  requestAnimationFrame(() => {
    const viewportBottom = tableViewport.getBoundingClientRect().bottom;
    const menuBottom = items.getBoundingClientRect().bottom;
    items.classList.toggle("is-above", menuBottom > viewportBottom);
  });
}, true);

table?.addEventListener("change", (event) => {
  const checkbox = event.target.closest(".cs-selection-checkbox");
  if (!checkbox) return;

  const id = checkbox.dataset.appointmentId;
  if (checkbox.checked) selectedAppointmentIds.add(id);
  else selectedAppointmentIds.delete(id);
  adminControls?.updateControls?.();
});

bulkBtn?.addEventListener("click", remindTomorrow);
sendBtn?.addEventListener("click", submitReminder);
cancelForm?.addEventListener("submit", async (event) => {
  event.preventDefault();

  if (!currentCancellation || !cancelForm.reportValidity()) return;

  const reason = cancelReasonInput.value.trim();
  if (!reason) {
    cancelReasonInput.setCustomValidity("Please enter a cancellation reason.");
    cancelReasonInput.reportValidity();
    return;
  }

  cancelReasonInput.setCustomValidity("");
  cancelSubmitBtn.disabled = true;

  try {
    const updated = await setStatus(currentCancellation, "Cancelled", reason);
    if (updated) {
      bootstrap.Modal.getOrCreateInstance(cancelModalEl).hide();
      currentCancellation = null;
    }
  } finally {
    cancelSubmitBtn.disabled = false;
  }
});
rescheduleForm?.addEventListener("submit", async (event) => {
  event.preventDefault();

  if (!currentRescheduling || !rescheduleForm.reportValidity()) return;

  rescheduleSubmitBtn.disabled = true;
  try {
    const updated = await setStatus(
      currentRescheduling,
      "Cancelled",
      "Rescheduled by clinic",
      {
        date: rescheduleDateInput.value,
        time: rescheduleTimeInput.value
      }
    );
    if (updated) {
      bootstrap.Modal.getOrCreateInstance(rescheduleModalEl).hide();
      currentRescheduling = null;
    }
  } finally {
    rescheduleSubmitBtn.disabled = false;
  }
});
cancelReasonInput?.addEventListener("input", () => {
  cancelReasonInput.setCustomValidity("");
});
cancelModalEl?.addEventListener("hidden.bs.modal", () => {
  currentCancellation = null;
  cancelForm?.reset();
  cancelModalTrigger?.focus();
  cancelModalTrigger = null;
});
rescheduleModalEl?.addEventListener("hidden.bs.modal", () => {
  currentRescheduling = null;
  rescheduleForm?.reset();
  rescheduleModalTrigger?.focus();
  rescheduleModalTrigger = null;
});

window.addEventListener("beforeunload", () => {
  unsubscribe?.();
});
