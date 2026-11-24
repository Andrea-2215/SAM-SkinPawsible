// header-actions.js
// Builds the upper-right header group (date, chat, bell, profile menu) on every page.
// It fills <div id="header-actions"></div> or, if missing, the existing .topbar-actions.

import { auth, db } from "./firebase-config.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import {
  collection,
  doc,
  getDoc,
  onSnapshot,
  runTransaction,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { getUserProfileSnapshot } from "./user-profile.js";

function readCachedHeaderUser() {
  try {
    return {
      name: localStorage.getItem("userName") || "User",
      email: localStorage.getItem("userEmail") || "",
      role: localStorage.getItem("userRoleLabel") || "Clinic account"
    };
  } catch {
    return { name: "User", email: "", role: "Clinic account" };
  }
}

const state = {
  chat: 0,
  notifications: [],
  notificationFilter: 'all',
  notificationActions: {},
  appointments: [],
  appointmentsError: "",
  user: readCachedHeaderUser()
};

const calendar = {
  selectedDate: new Date(),
  viewedMonth: new Date(new Date().getFullYear(), new Date().getMonth(), 1)
};

let unsubscribeAppointments = null;
let appointmentUserId = null;
let hasInitialAppointmentSnapshot = false;
const staffProfileChecks = new Map();
const staffAppointmentNotificationAttempts = new Map();

const mount =
  document.getElementById('header-actions') ||
  document.querySelector('.topbar-actions');

function esc(text) {
  const div = document.createElement('div');
  div.textContent = text == null ? '' : String(text);
  return div.innerHTML;
}

function badge(count) {
  if (!count) return '';
  return `<span class="ha-badge">${count > 9 ? '9+' : count}</span>`;
}

function dateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function parseDate(value) {
  if (!value) return null;

  if (typeof value.toDate === 'function') {
    const date = value.toDate();
    return Number.isNaN(date.getTime())
      ? null
      : new Date(date.getFullYear(), date.getMonth(), date.getDate());
  }

  const text = String(value).trim();
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  const date = dateOnly
    ? new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]))
    : new Date(text);

  if (Number.isNaN(date.getTime())) return null;
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function parseTime(value) {
  if (!value) return null;

  const match = /^(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)?$/i.exec(
    String(value).trim()
  );
  if (!match) return null;

  let hours = Number(match[1]);
  const minutes = Number(match[2]);
  const meridiem = (match[3] || '').toUpperCase();
  if (hours > 23 || minutes > 59) return null;
  if (meridiem === 'PM' && hours < 12) hours += 12;
  if (meridiem === 'AM' && hours === 12) hours = 0;

  return { hours, minutes };
}

function formatAppointmentTime(value) {
  const time = parseTime(value);
  if (!time) return value ? esc(value) : 'Time not set';

  const date = new Date();
  date.setHours(time.hours, time.minutes, 0, 0);
  return date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit'
  });
}

function activeAppointments() {
  return state.appointments.filter((appointment) => {
    const status = String(
      appointment.status || appointment.statusLower || 'pending'
    ).toLowerCase().trim();
    return status === 'approved' || status === 'confirmed';
  });
}

function isPendingAppointment(appointment) {
  const status = String(appointment.status || 'pending').toLowerCase().trim();
  return status === 'pending';
}

function isActiveWebStaffProfile(profile) {
  const role = String(profile.role || '').toLowerCase().trim();
  const status = String(profile.status || 'active').toLowerCase().trim();
  return ['admin', 'staff', 'vet', 'veterinarian'].includes(role) &&
    status === 'active';
}

function canCreateStaffAppointmentNotification(userId) {
  if (!staffProfileChecks.has(userId)) {
    staffProfileChecks.set(userId, getDoc(doc(db, 'users', userId))
      .then((profileSnapshot) => profileSnapshot.exists() &&
        isActiveWebStaffProfile(profileSnapshot.data()))
      .catch(() => {
        return false;
      }));
  }

  return staffProfileChecks.get(userId);
}

async function createStaffAppointmentNotification(appointment, userId) {
  if (!isPendingAppointment(appointment)) return;

  const isActiveStaff = await canCreateStaffAppointmentNotification(userId);
  if (!isActiveStaff || auth.currentUser?.uid !== userId) return;

  const ownerName = appointment.ownerName ||
    appointment.petOwnerName ||
    appointment.userName ||
    'A pet owner';
  const petName = appointment.petName || appointment.pet || 'a pet';
  const appointmentDate = appointment.preferredDate || appointment.date || '';
  const appointmentTime = appointment.preferredTime || appointment.time || '';
  const concern = appointment.concern ||
    appointment.concerns ||
    appointment.notes ||
    '';
  const details = [
    `New appointment request from ${ownerName} for ${petName}`,
    [appointmentDate, appointmentTime].filter(Boolean).join(' at '),
    concern ? `Concern: ${concern}` : ''
  ].filter(Boolean);
  const notificationRef = doc(
    db,
    'notifications',
    `appointment_${appointment.id}`
  );

  const attemptKey = `${userId}:${appointment.id}`;
  if (staffAppointmentNotificationAttempts.has(attemptKey)) {
    return staffAppointmentNotificationAttempts.get(attemptKey);
  }

  const attempt = (async () => {
    try {
      await runTransaction(db, async (transaction) => {
        const existing = await transaction.get(notificationRef);
        if (existing.exists()) return;

        transaction.set(notificationRef, {
          title: `New appointment request from ${ownerName}`,
          message: details.join(' · '),
          type: 'APPOINTMENT',
          targetScreen: 'APPOINTMENTS',
          targetId: appointment.id,
          sourceAppointmentId: appointment.id,
          recipientRole: 'webStaff',
          isRead: false,
          readBy: [],
          dismissedBy: [],
          deletedBy: [],
          timestamp: new Date().toLocaleString(),
          createdAtMillis: Date.now(),
          createdAt: serverTimestamp()
        });
      }, { maxAttempts: 1 });
      return true;
    } catch {
      return false;
    }
  })();

  staffAppointmentNotificationAttempts.set(attemptKey, attempt);
  return attempt;
}

function appointmentsForDate(date) {
  const key = dateKey(date);
  return activeAppointments()
    .filter((appointment) => {
      const appointmentDate = parseDate(
        appointment.preferredDate || appointment.date
      );
      return appointmentDate && dateKey(appointmentDate) === key;
    })
    .sort((first, second) => {
      const firstTime = parseTime(first.preferredTime || first.time);
      const secondTime = parseTime(second.preferredTime || second.time);
      const firstMinutes = firstTime
        ? firstTime.hours * 60 + firstTime.minutes
        : Number.MAX_SAFE_INTEGER;
      const secondMinutes = secondTime
        ? secondTime.hours * 60 + secondTime.minutes
        : Number.MAX_SAFE_INTEGER;
      return firstMinutes - secondMinutes;
    });
}

function renderCalendarAppointments() {
  if (state.appointmentsError) {
    return `<p class="ha-calendar-message ha-calendar-error">${esc(state.appointmentsError)}</p>`;
  }

  const appointments = appointmentsForDate(calendar.selectedDate);
  if (!appointments.length) {
    return '<p class="ha-calendar-message">No scheduled appointments for this day.</p>';
  }

  return appointments.map((appointment) => `
    <a class="ha-calendar-appointment" href="appointments.html">
      <span class="ha-calendar-time">${formatAppointmentTime(
        appointment.preferredTime || appointment.time
      )}</span>
      <span class="ha-calendar-appointment-info">
        <strong>${esc(appointment.petName || appointment.pet || 'Pet appointment')}</strong>
        <small>${esc(
          appointment.concern ||
          appointment.concerns ||
          appointment.notes ||
          'Appointment'
        )}</small>
      </span>
    </a>`).join('');
}

function renderCalendar() {
  const selectedDateKey = dateKey(calendar.selectedDate);
  const today = new Date();
  const todayKey = dateKey(today);
  const monthStart = new Date(
    calendar.viewedMonth.getFullYear(),
    calendar.viewedMonth.getMonth(),
    1
  );
  const nextMonthStart = new Date(
    calendar.viewedMonth.getFullYear(),
    calendar.viewedMonth.getMonth() + 1,
    1
  );
  const monthAppointmentCount = activeAppointments().filter((appointment) => {
    const date = parseDate(appointment.preferredDate || appointment.date);
    return date && date >= monthStart && date < nextMonthStart;
  }).length;
  const gridStart = new Date(monthStart);
  gridStart.setDate(gridStart.getDate() - gridStart.getDay());
  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const days = Array.from({ length: 42 }, (_, index) => {
    const date = new Date(gridStart);
    date.setDate(gridStart.getDate() + index);
    const count = appointmentsForDate(date).length;
    const classes = [
      'ha-calendar-day',
      date.getMonth() === calendar.viewedMonth.getMonth() ? '' : 'is-outside',
      dateKey(date) === todayKey ? 'is-today' : '',
      dateKey(date) === selectedDateKey && dateKey(date) !== todayKey
        ? 'is-selected'
        : '',
      count ? 'has-appointments' : ''
    ].filter(Boolean).join(' ');
    const countLabel = count
      ? `, ${count} appointment${count === 1 ? '' : 's'}`
      : '';

    return `
      <button type="button" class="${classes}"
              data-ha-calendar-date="${dateKey(date)}"
              aria-label="${esc(date.toLocaleDateString('en-US', {
                weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
              }))}${countLabel}"
              aria-pressed="${dateKey(date) === selectedDateKey}">
        <span>${date.getDate()}</span>
        ${count ? '<i aria-hidden="true"></i>' : ''}
      </button>`;
  }).join('');
  const dateLabel = calendar.selectedDate.toLocaleDateString('en-US', {
    weekday: 'long', month: 'short', day: 'numeric'
  });

  return `
    <div class="ha-panel ha-calendar-panel" id="haCalendarPanel" hidden>
      <div class="ha-calendar-month">
        <div class="ha-calendar-month-title">
          <strong>${calendar.viewedMonth.toLocaleDateString('en-US', {
            month: 'long', year: 'numeric'
          })}</strong>
          <span>${monthAppointmentCount} appointment${monthAppointmentCount === 1 ? '' : 's'} this month</span>
        </div>
        <div class="ha-calendar-month-nav">
          <button type="button" class="ha-calendar-nav" data-ha-calendar-month="-1"
                  aria-label="Previous month">
            <i class="bi bi-chevron-left" aria-hidden="true"></i>
          </button>
          <button type="button" class="ha-calendar-nav" data-ha-calendar-month="1"
                  aria-label="Next month">
            <i class="bi bi-chevron-right" aria-hidden="true"></i>
          </button>
        </div>
      </div>
      <div class="ha-calendar-grid" role="grid" aria-label="Appointment dates">
        ${weekdays.map((day) => `<span class="ha-calendar-weekday" role="columnheader">${day}</span>`).join('')}
        ${days}
      </div>
      <section class="ha-calendar-agenda" aria-live="polite">
        <h3>${esc(dateLabel)}</h3>
        <div class="ha-calendar-agenda-list">${renderCalendarAppointments()}</div>
      </section>
      <div class="ha-calendar-footer">
        <span class="ha-calendar-legend"><i aria-hidden="true"></i> Has appointments</span>
        <button type="button" class="ha-calendar-today" data-ha-calendar-today>
          Go to today
        </button>
      </div>
    </div>`;
}

function notificationItems() {
  const notifications = state.notifications
    .map((notification, index) => ({ notification, index }))
    .filter(({ notification }) => {
      if (state.notificationFilter === 'all') return true;

      const type = String(notification.type || '').toUpperCase();
      const targetScreen = String(notification.targetScreen || '').toUpperCase();
      const isSystem = type === 'WEB_USER_ACCESS_CHANGED';
      const isAppointment = type === 'APPOINTMENT' ||
        type === 'APPOINTMENT_STATUS' ||
        targetScreen === 'APPOINTMENTS' ||
        targetScreen === 'CONSULTATIONS' ||
        Boolean(notification.consultationId) ||
        Boolean(notification.sourceAppointmentId);
      const isMessage = !isAppointment && (
        type === 'MESSAGE' ||
        type === 'VET_CHAT_ESCALATION' ||
        targetScreen === 'CHAT' ||
        Boolean(notification.sourceMessageId)
      );

      if (state.notificationFilter === 'appointments') return isAppointment;
      if (state.notificationFilter === 'messages') return isMessage;
      return state.notificationFilter === 'system' && isSystem;
    });

  if (!notifications.length) {
    return `
      <div class="ha-empty">
        <i class="bi bi-bell-slash"></i>
        <p>${state.notifications.length
          ? 'No notifications in this category'
          : "You're all caught up"}</p>
      </div>`;
  }
  return notifications.map(({ notification: n, index }) => `
    <article class="ha-notif ${n.isRead ? 'is-read' : ''}">
      <button type="button" class="ha-notif-open" data-ha-notif-open="${index}">
        <i class="bi ${esc(n.icon || 'bi-bell')}"></i>
        <span class="ha-notif-content">
          <span class="ha-notif-title">${esc(n.title)}</span>
          <span class="ha-notif-message">${esc(n.message || '')}</span>
          <span class="ha-notif-time">${esc(n.time || '')}</span>
        </span>
      </button>
      <button type="button" class="ha-notif-dismiss" data-ha-notif-dismiss="${index}"
              aria-label="Delete ${esc(n.title || 'notification')}"
              title="Delete notification">
        <i class="bi bi-x-lg" aria-hidden="true"></i>
      </button>
    </article>`).join('');
}

function render() {
  if (!mount) return;

  document.documentElement.classList.toggle(
    "header-ready",
    Boolean(state.user.name && state.user.role) &&
      state.user.name !== "User" &&
      state.user.role !== "Clinic account" &&
      state.user.role !== "Loading account..."
  );

  const openPanelId = Array.from(mount.querySelectorAll('.ha-panel'))
    .find((panel) => !panel.hidden)?.id;
  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric'
  });
  const initial = esc((state.user.name || 'A').charAt(0).toUpperCase());
  const role = esc(state.user.role || 'Clinic account');
  const isSuperadmin = state.roleKey === 'superadmin' ||
    document.documentElement.dataset.role === 'superadmin' ||
    state.user.role === 'IT Administrator';

  mount.innerHTML = `
    <div class="ha-root">

      ${isSuperadmin ? '' : `
        <div class="ha-wrap">
          <button type="button" class="ha-date" data-ha-toggle="calendar"
                  aria-label="Open appointment calendar" aria-expanded="false"
                  title="Appointment calendar">
          <i class="bi bi-calendar3"></i>
            <span class="ha-date-label">${esc(today)}</span>
          </button>
          ${renderCalendar()}
        </div>

        <a class="ha-icon-btn" href="consultations.html" aria-label="Open consultations" title="Consultations">
          <i class="bi bi-clipboard2-pulse"></i>
          ${badge(state.chat)}
        </a>
      `}

      <div class="ha-wrap">
        <button type="button" class="ha-icon-btn" data-ha-toggle="notif"
                aria-label="Notifications" aria-expanded="false">
          <i class="bi bi-bell"></i>
          ${badge(state.notifications.filter((n) => !n.isRead).length)}
        </button>
        <div class="ha-panel ha-notif-panel" id="haNotifPanel" hidden>
          <div class="ha-panel-head">
            <span>Notifications</span>
            <button type="button" class="ha-mark-all-read"
                    data-ha-notif-mark-all
                    ${state.notifications.some((n) => !n.isRead) ? '' : 'disabled'}>
              Mark all read
            </button>
          </div>
          <div class="ha-notif-filters" role="group" aria-label="Filter notifications">
            <button type="button" class="ha-notif-filter ${state.notificationFilter === 'all' ? 'is-active' : ''}"
                    data-ha-notif-filter="all"
                    aria-pressed="${state.notificationFilter === 'all'}">All</button>
            <button type="button" class="ha-notif-filter ${state.notificationFilter === 'appointments' ? 'is-active' : ''}"
                    data-ha-notif-filter="appointments"
                    aria-pressed="${state.notificationFilter === 'appointments'}">Appointments</button>
            <button type="button" class="ha-notif-filter ${state.notificationFilter === 'messages' ? 'is-active' : ''}"
                    data-ha-notif-filter="messages"
                    aria-pressed="${state.notificationFilter === 'messages'}">Messages</button>
            <button type="button" class="ha-notif-filter ${state.notificationFilter === 'system' ? 'is-active' : ''}"
                    data-ha-notif-filter="system"
                    aria-pressed="${state.notificationFilter === 'system'}">System</button>
          </div>
          <div class="ha-notif-list">${notificationItems()}</div>
        </div>
      </div>

      <div class="ha-wrap">
        <button type="button" class="ha-profile" data-ha-toggle="profile"
                aria-label="Account menu" aria-expanded="false">
          <span class="ha-avatar">${initial}</span>
          <span class="ha-who">
            <strong>${esc(state.user.name)}</strong>
            <small>${role}</small>
          </span>
          <i class="bi bi-chevron-down ha-caret"></i>
        </button>
        <div class="ha-panel ha-profile-panel" id="haProfilePanel" hidden>
          <div class="ha-panel-head ha-user-info">
            <strong>${esc(state.user.name)}</strong>
            <small>${esc(state.user.email)}</small>
          </div>
          <a class="ha-menu-item" href="settings.html">
            <i class="bi bi-gear"></i> Settings
          </a>
          <button type="button" class="ha-menu-item ha-danger" id="logoutBtn">
            <i class="bi bi-box-arrow-right"></i> Log out
          </button>
        </div>
      </div>

    </div>`;

  if (openPanelId) {
    const panel = document.getElementById(openPanelId);
    const button = mount.querySelector(
      `[data-ha-toggle="${openPanelId === 'haCalendarPanel' ? 'calendar' : openPanelId === 'haNotifPanel' ? 'notif' : 'profile'}"]`
    );
    if (panel) panel.hidden = false;
    button?.setAttribute('aria-expanded', 'true');
  }
}

function closeAll() {
  document.querySelectorAll('.ha-panel').forEach((p) => { p.hidden = true; });
  document.querySelectorAll('[data-ha-toggle]').forEach((b) => {
    b.setAttribute('aria-expanded', 'false');
  });
}

function toggle(name) {
  const panelId = {
    calendar: 'haCalendarPanel',
    notif: 'haNotifPanel',
    profile: 'haProfilePanel'
  }[name];
  const panel = document.getElementById(panelId);
  const btn = document.querySelector(`[data-ha-toggle="${name}"]`);
  if (!panel || !btn) return;
  const willOpen = panel.hidden;
  closeAll();
  panel.hidden = !willOpen;
  btn.setAttribute('aria-expanded', String(willOpen));
}

if (mount) {
  render();

  document.addEventListener('click', (event) => {
    if (!(event.target instanceof Element)) return;

    const calendarDateButton = event.target.closest('[data-ha-calendar-date]');
    if (calendarDateButton) {
      const [year, month, day] = calendarDateButton.dataset.haCalendarDate
        .split('-').map(Number);
      calendar.selectedDate = new Date(year, month - 1, day);
      calendar.viewedMonth = new Date(year, month - 1, 1);
      render();
      return;
    }

    const calendarMonthButton = event.target.closest('[data-ha-calendar-month]');
    if (calendarMonthButton) {
      const amount = Number(calendarMonthButton.dataset.haCalendarMonth);
      calendar.viewedMonth = new Date(
        calendar.viewedMonth.getFullYear(),
        calendar.viewedMonth.getMonth() + amount,
        1
      );
      calendar.selectedDate = new Date(
        calendar.viewedMonth.getFullYear(),
        calendar.viewedMonth.getMonth(),
        1
      );
      render();
      return;
    }

    if (event.target.closest('[data-ha-calendar-today]')) {
      calendar.selectedDate = new Date();
      calendar.viewedMonth = new Date(
        calendar.selectedDate.getFullYear(),
        calendar.selectedDate.getMonth(),
        1
      );
      render();
      return;
    }

    const notificationFilterButton =
      event.target.closest('[data-ha-notif-filter]');
    if (notificationFilterButton) {
      state.notificationFilter = notificationFilterButton.dataset.haNotifFilter;
      render();
      return;
    }

    const openNotificationButton = event.target.closest('[data-ha-notif-open]');
    if (openNotificationButton) {
      const notification = state.notifications[
        Number(openNotificationButton.dataset.haNotifOpen)
      ];
      if (!notification) return;

      if (typeof state.notificationActions.onOpen === 'function') {
        state.notificationActions.onOpen(notification);
      } else if (notification.href) {
        window.location.href = notification.href;
      }
      return;
    }

    const dismissNotificationButton =
      event.target.closest('[data-ha-notif-dismiss]');
    if (dismissNotificationButton) {
      const notification = state.notifications[
        Number(dismissNotificationButton.dataset.haNotifDismiss)
      ];
      if (!notification) return;

      if (typeof state.notificationActions.onDismiss === 'function') {
        dismissNotificationButton.disabled = true;
        state.notificationActions.onDismiss(
          notification,
          dismissNotificationButton
        );
      }
      return;
    }

    const markAllReadButton = event.target.closest('[data-ha-notif-mark-all]');
    if (markAllReadButton) {
      if (typeof state.notificationActions.onMarkAllRead === 'function') {
        markAllReadButton.disabled = true;
        state.notificationActions.onMarkAllRead(
          state.notifications,
          markAllReadButton
        );
      }
      return;
    }

    const btn = event.target.closest('[data-ha-toggle]');
    if (btn) {
      toggle(btn.dataset.haToggle);
      return;
    }
    if (!event.target.closest('.ha-panel')) closeAll();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeAll();
  });
}

if (mount) {
  onAuthStateChanged(auth, async (user) => {
    if (!user) {
      unsubscribeAppointments?.();
      unsubscribeAppointments = null;
      appointmentUserId = null;
      hasInitialAppointmentSnapshot = false;
      state.appointments = [];
      state.appointmentsError = "";
      state.roleKey = "";
      state.user = { name: "User", email: "", role: "Clinic account" };
      render();
      return;
    }

    state.user = {
      ...state.user,
      name: state.user.name || user.displayName || user.email?.split("@")[0] || "User",
      email: user.email || "",
      role: state.user.role || "Loading account..."
    };
    render();

    if (appointmentUserId !== user.uid) {
      unsubscribeAppointments?.();
      appointmentUserId = user.uid;
      hasInitialAppointmentSnapshot = false;
      state.appointmentsError = "";
      unsubscribeAppointments = onSnapshot(
        collection(db, 'consultations'),
        (snapshot) => {
          state.appointments = snapshot.docs.map((appointmentDoc) => {
            const data = appointmentDoc.data();
            return {
              ...data,
              id: appointmentDoc.id,
              preferredDate: data.preferredDate || data.date || '',
              preferredTime: data.preferredTime || data.time || ''
            };
          });
          state.appointmentsError = "";
          render();

          if (!hasInitialAppointmentSnapshot) {
            if (!snapshot.metadata.fromCache) {
              hasInitialAppointmentSnapshot = true;
              state.appointments.forEach((appointment) => {
                createStaffAppointmentNotification(appointment, user.uid)
                  .catch(() => false);
              });
            }
            return;
          }

          snapshot.docChanges().forEach((change) => {
            if (change.type !== 'added') return;

            const data = change.doc.data();
            const appointment = {
              ...data,
              id: change.doc.id,
              preferredDate: data.preferredDate || data.date || '',
              preferredTime: data.preferredTime || data.time || ''
            };

            createStaffAppointmentNotification(appointment, user.uid)
              .catch(() => false);
          });
        },
        (error) => {
          console.error("Could not load calendar appointments:", error);
          state.appointments = [];
          state.appointmentsError = "Appointments could not be loaded. Please check your connection and permissions.";
          render();
        }
      );
    }

    try {
      const profileSnapshot = await getUserProfileSnapshot(user);
      if (auth.currentUser?.uid !== user.uid) return;

      if (!profileSnapshot.exists()) {
        state.user.role = "Role unavailable";
        render();
        return;
      }

      const profile = profileSnapshot.data();
      const role = String(profile.role || "").toLowerCase().trim();
      state.roleKey = role;
      const roleLabel = {
        admin: "Administrator",
        staff: "Staff",
        vet: "Veterinarian",
        veterinarian: "Veterinarian",
        superadmin: "IT Administrator"
      }[role];

      state.user = {
        name: profile.fullName || profile.displayName || user.displayName ||
          user.email?.split("@")[0] || "User",
        email: profile.email || user.email || "",
        role: roleLabel || "Role unavailable"
      };
      try {
        localStorage.setItem("userName", state.user.name);
        localStorage.setItem("userEmail", state.user.email);
        localStorage.setItem("userRoleLabel", state.user.role);
      } catch {
        // Cached header hydration is best effort.
      }
      render();
    } catch (error) {
      if (auth.currentUser?.uid !== user.uid) return;
      console.error("Could not load the signed-in user's header profile:", error);
      state.user.role = "Role unavailable";
      render();
    }
  });

  window.addEventListener('beforeunload', () => {
    unsubscribeAppointments?.();
  });
}

// Use these from other scripts, for example:
// window.HeaderActions.setChatCount(3);
// window.HeaderActions.setNotifications([{ icon: 'bi-chat-dots', title: 'New message from Mika Mirr', time: '2 min ago', href: 'consultations.html' }]);
// window.HeaderActions.setUser({ name: 'Alex', email: 'alex@example.com', role: 'Veterinarian' });
window.HeaderActions = {
  setChatCount(n) { state.chat = Number(n) || 0; render(); },
  setNotifications(list) { state.notifications = Array.isArray(list) ? list : []; render(); },
  setNotificationActions(actions) {
    state.notificationActions = actions && typeof actions === 'object' ? actions : {};
  },
  setUser(user) { state.user = { ...state.user, ...user }; render(); }
};
