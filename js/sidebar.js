
/* ==========================================================
   SKINPAWSIBLE SHARED SIDEBAR
   Uses sidebar-ui.js for sidebar markup.
   Page visibility is controlled by the role permission documents.
   ========================================================== */

import { auth, db } from "./firebase-config.js";

import { getUserProfileSnapshot } from "./user-profile.js";
import {
    getPagePermissionKey,
    getPermissionPagePath,
    getRolePermissions
} from "../utils/roles.js?v=3";

import {
    onAuthStateChanged,
    signOut
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";

function applyRoleBasedNavigation(permissions) {
    document.querySelectorAll(".sidebar .nav-link").forEach((link) => {
        const navItem = link.closest(".nav-item");
        if (!navItem) return;
        const pageKey = getPagePermissionKey(new URL(link.href).pathname);
        navItem.style.display = pageKey && permissions[pageKey] === true ? "" : "none";
    });

    document.querySelectorAll(".sidebar .nav-section-title").forEach((section) => {
        let next = section.nextElementSibling;
        let hasVisibleLink = false;
        while (next && !next.classList.contains("nav-section-title")) {
            if (next.classList.contains("nav-item") && next.style.display !== "none") {
                hasVisibleLink = true;
                break;
            }
            next = next.nextElementSibling;
        }
        section.style.display = hasVisibleLink ? "" : "none";
    });

    const adminNavigation = document.getElementById("adminNavigation");
    if (adminNavigation) {
        const hasVisibleAdminLink = [...adminNavigation.querySelectorAll(".nav-item")]
            .some((item) => item.style.display !== "none");
        adminNavigation.style.display = hasVisibleAdminLink ? "block" : "none";
    }
    document.getElementById("sidebar")?.classList.add("permissions-ready");
}

import {
    doc,
    collection,
    onSnapshot,
    query,
    updateDoc,
    deleteDoc,
    where,
    limit,
    arrayUnion,
    getDoc,
    runTransaction,
    serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";


// ==========================================================
// GLOBAL STATE
// ==========================================================

let logoutInProgress = false;
let unsubscribeNotifications = [];
let notificationUserId = null;
let currentNotificationToast = null;
let notificationToastTimeout = null;
let notificationToastVisible = false;
let activeNotificationToggle = null;

const notificationToastQueue = [];
const notificationSnapshots = new Map();
let notificationRenderVersion = 0;
const logoutConfirmation = document.createElement("dialog");
logoutConfirmation.className = "logout-confirm-dialog";
logoutConfirmation.setAttribute("aria-labelledby", "logoutConfirmTitle");
logoutConfirmation.setAttribute("aria-describedby", "logoutConfirmMessage");
logoutConfirmation.innerHTML = `
    <div class="logout-confirm-content">
        <img
            class="logout-confirm-image"
            src="../images/logout-puppy.png"
            alt=""
            aria-hidden="true"
        >
        <h2 id="logoutConfirmTitle">Log out?</h2>
        <p id="logoutConfirmMessage">Do you wish to log out?</p>
        <form method="dialog" class="logout-confirm-actions">
            <button type="submit" class="logout-confirm-cancel" value="cancel">
                Stay logged in
            </button>
            <button type="submit" class="logout-confirm-submit" value="confirm">
                Log out
            </button>
        </form>
    </div>`;
document.body.append(logoutConfirmation);

function confirmLogout() {
    return new Promise((resolve) => {
        logoutConfirmation.addEventListener(
            "close",
            () => resolve(logoutConfirmation.returnValue === "confirm"),
            { once: true }
        );
        logoutConfirmation.showModal();
        logoutConfirmation.querySelector(".logout-confirm-cancel").focus();
    });
}

const notificationTargets = {
    CHAT: "consultations.html",
    CONSULTATIONS: "consultations.html",
    APPOINTMENTS: "appointments.html",
    USERS: "users.html",
    SETTINGS: "settings.html",
    SMS: "sms-logs.html#awarenessPane"
};

const seasonalSmsStartMonths = new Map([
    [2, "Hot dry"],
    [5, "Rainy"],
    [11, "Cool dry"]
]);

async function createSeasonalSmsReminder(role) {
    if (!["admin", "staff"].includes(role)) return;

    const now = new Date();
    const season = seasonalSmsStartMonths.get(now.getMonth());
    if (!season) return;

    const notificationRef = doc(
        db,
        "notifications",
        `seasonal_sms_${now.getFullYear()}_${String(now.getMonth() + 1).padStart(2, "0")}`
    );

    await runTransaction(db, async (transaction) => {
        const existing = await transaction.get(notificationRef);
        if (existing.exists()) return;

        transaction.set(notificationRef, {
            title: `${season} season SMS reminder`,
            message: `The ${season.toLowerCase()} season starts this month. Send the seasonal awareness SMS to pet owners.`,
            type: "SEASONAL_SMS_REMINDER",
            targetScreen: "SMS",
            recipientRole: "webStaff",
            isRead: false,
            readBy: [],
            dismissedBy: [],
            deletedBy: [],
            timestamp: now.toLocaleString(),
            createdAtMillis: now.getTime(),
            createdAt: serverTimestamp()
        });
    });
}

function isStaffNotification(notification) {
    return ["webStaff", "webAdmin"].includes(
        notification.recipientRole
    );
}

function isAppointmentRequestNotification(notification) {
    return /^\s*(?:📅\s*)?(?:\[Appointment Request\]|Appointment Request)\s*\|\s*Pet:\s*.+?\s*\|\s*Date:\s*.+\s*$/i
        .test(String(notification.message || ""));
}

function isVetEscalationNotification(notification) {
    return String(notification.type || "").toUpperCase() ===
        "VET_CHAT_ESCALATION";
}

function isMessageNotification(notification) {
    return !isVetEscalationNotification(notification) &&
        !isAppointmentRequestNotification(notification) &&
        (notification.type === "MESSAGE" ||
            notification.targetScreen === "CHAT");
}

function isAppointmentNotification(notification) {
    return ["APPOINTMENT", "APPOINTMENT_STATUS"].includes(
        String(notification.type || "").toUpperCase()
    ) ||
        notification.targetScreen === "APPOINTMENTS" ||
        isAppointmentRequestNotification(notification);
}

function shouldHideNotificationForRole(notification, role) {
    if (!isStaffNotification(notification)) return false;

    if (isMessageNotification(notification)) {
        return !["staff", "admin"].includes(role);
    }

    if (isAppointmentNotification(notification)) {
        return !["staff", "admin", "vet", "veterinarian"].includes(role);
    }

    return false;
}

function getNotificationHref(notification) {
    const targetScreen = String(notification.targetScreen || "").toUpperCase();
    if (!Object.prototype.hasOwnProperty.call(
        notificationTargets,
        targetScreen
    )) {
        return null;
    }

    const target = notificationTargets[targetScreen];

    if (!target) return null;

    const roomId = [
        notification.roomId,
        notification.sourceRoomId,
        ...(targetScreen === "CHAT" ? [notification.targetId] : [])
    ].find((value) => typeof value === "string" && value.trim());

    if (
        ["CHAT", "CONSULTATIONS"].includes(targetScreen) &&
        roomId
    ) {
        return `${target}?roomId=${encodeURIComponent(roomId.trim())}`;
    }

    if (
        targetScreen === "APPOINTMENTS" &&
        typeof notification.targetId === "string" &&
        notification.targetId.trim()
    ) {
        return `${target}?appointmentId=${encodeURIComponent(
          notification.targetId.trim()
        )}`;
    }

    return target;
}

function getNotificationDate(notification) {
    const createdAtMillis = Number(notification.createdAtMillis);
    if (Number.isFinite(createdAtMillis) && createdAtMillis > 0) {
        const date = new Date(createdAtMillis);
        if (Number.isFinite(date.getTime())) return date;
    }

    const createdAt = notification.createdAt;
    if (typeof createdAt?.toDate === "function") {
        const date = createdAt.toDate();
        if (Number.isFinite(date.getTime())) return date;
    }
    if (createdAt instanceof Date && Number.isFinite(createdAt.getTime())) {
        return createdAt;
    }

    const timestamp = notification.timestamp;
    if (typeof timestamp === "number" && Number.isFinite(timestamp)) {
        const date = new Date(timestamp);
        if (Number.isFinite(date.getTime())) return date;
    }
    if (typeof timestamp === "string" && !/^just now$/i.test(timestamp.trim())) {
        const date = new Date(timestamp);
        if (Number.isFinite(date.getTime())) return date;
    }

    return null;
}

function formatNotificationDate(notification) {
    const date = getNotificationDate(notification);
    return date
        ? date.toLocaleString([], {
            dateStyle: "medium",
            timeStyle: "short"
        })
        : "";
}


// ==========================================================
// LOGOUT
// ==========================================================

document.addEventListener("click", async (event) => {
    const target = event.target;

    if (!(target instanceof Element)) return;

    const logoutButton = target.closest(
        "#logoutBtn, #settingsLogoutBtn"
    );

    if (!(logoutButton instanceof HTMLButtonElement)) return;

    event.preventDefault();
    event.stopImmediatePropagation();

    if (logoutInProgress) return;
    if (!await confirmLogout()) return;

    logoutInProgress = true;
    logoutButton.disabled = true;

    try {
        localStorage.removeItem("userRole");
        localStorage.removeItem("userName");
        localStorage.removeItem("userEmail");
        localStorage.removeItem("userRoleLabel");
        await signOut(auth);
        window.location.href = "login.html";
    } catch (error) {
        logoutInProgress = false;
        logoutButton.disabled = false;

        console.error("Logout error:", error);
        alert("Unable to log out. Please try again.");
    }
}, true);


// ==========================================================
// USE EXISTING SIDEBAR
// sidebar-ui.js must render the markup first.
// ==========================================================

const sidebar = document.getElementById("sidebar");
const sidebarContainer = document.getElementById("sidebar-container");

if (!sidebar || !sidebarContainer) {
    console.error(
        "SkinPawsible sidebar not found. Check sidebar-ui.js and its script placement."
    );
} else {
    initializeSidebar();
}


// ==========================================================
// INITIALIZE SIDEBAR
// ==========================================================

function initializeSidebar() {
    const notificationPanel =
        document.getElementById("notificationPanel");

    const notificationList =
        document.getElementById("notificationList");

    const notificationToastHost =
        document.getElementById("notificationToastHost");

    const adminNavigation =
        document.getElementById("adminNavigation");

    const menuToggle =
        document.getElementById("menuToggle");

    const sidebarScrollKey =
        "skinpawsible-sidebar-scroll";


    // Hide Admin-only links until the user's role is verified.
    if (adminNavigation) {
        adminNavigation.style.display = "none";
    }


    // ======================================================
    // NOTIFICATION BADGES
    // ======================================================

    function updateNotificationBadges(count) {
        document
            .querySelectorAll("[data-notification-count]")
            .forEach((badge) => {
                badge.textContent =
                    count > 99 ? "99+" : String(count);

                badge.hidden = count === 0;

                badge.setAttribute(
                    "aria-label",
                    `${count} unread notification${count === 1 ? "" : "s"}`
                );
            });
    }


    // ======================================================
    // CLOSE NOTIFICATION PANEL
    // ======================================================

    function closeNotificationPanel() {
        if (!notificationPanel) return;

        notificationPanel.hidden = true;
        activeNotificationToggle = null;

        document
            .querySelectorAll("[data-notification-toggle]")
            .forEach((toggle) => {
                toggle.setAttribute("aria-expanded", "false");
            });
    }


    // ======================================================
    // POSITION NOTIFICATION PANEL
    // ======================================================

    function positionNotificationPanel() {
        if (
            !notificationPanel ||
            notificationPanel.hidden ||
            !activeNotificationToggle?.isConnected
        ) {
            return;
        }

        const triggerRect =
            activeNotificationToggle.getBoundingClientRect();

        const panelRect =
            notificationPanel.getBoundingClientRect();

        const viewportPadding =
            window.innerWidth <= 576 ? 12 : 16;

        const left = Math.min(
            Math.max(
                triggerRect.right - panelRect.width,
                viewportPadding
            ),
            window.innerWidth - panelRect.width - viewportPadding
        );

        let top = triggerRect.bottom + 10;

        if (
            top + panelRect.height >
            window.innerHeight - viewportPadding
        ) {
            top = Math.max(
                viewportPadding,
                triggerRect.top - panelRect.height - 10
            );
        }

        notificationPanel.style.left = `${left}px`;
        notificationPanel.style.top = `${top}px`;
    }


    // ======================================================
    // RENDER NOTIFICATIONS
    // ======================================================

    function renderNotifications(notifications) {
        if (!notificationList) return;

        updateNotificationBadges(
            notifications.filter(
                (notification) => !isNotificationRead(notification)
            ).length
        );
        notificationList.replaceChildren();

        if (notifications.length === 0) {
            const emptyMessage = document.createElement("p");
            emptyMessage.className = "notification-empty";

            const emptyIcon = document.createElement("i");
            emptyIcon.className = "bi bi-bell-slash";
            emptyIcon.setAttribute("aria-hidden", "true");

            const emptyText = document.createElement("span");
            emptyText.textContent = "You're all caught up.";

            emptyMessage.append(emptyIcon, emptyText);
            notificationList.appendChild(emptyMessage);
            return;
        }

        notifications.forEach((notification) => {
            const item = document.createElement("div");
            const isRead = isNotificationRead(notification);
            item.className = isRead
                ? "notification-entry is-read"
                : "notification-entry";

            const openButton = document.createElement("button");
            openButton.type = "button";
            openButton.className = "notification-entry-open";

            openButton.setAttribute(
                "aria-label",
                `Open ${notification.title || "notification"}`
            );

            const unreadDot = document.createElement("span");
            unreadDot.className = "notification-entry-dot";
            unreadDot.setAttribute("aria-hidden", "true");
            unreadDot.hidden = isRead;

            const content = document.createElement("span");
            content.className = "notification-entry-content";

            const title = document.createElement("strong");
            title.textContent =
                notification.title || "New notification";

            const message = document.createElement("span");
            message.className = "notification-entry-message";
            message.textContent = notification.message || "";

            const timestamp = document.createElement("time");
            timestamp.className = "notification-entry-time";

            const date = getNotificationDate(notification);
            if (date) {
                timestamp.dateTime = date.toISOString();
                timestamp.textContent = formatNotificationDate(notification);
            }

            content.append(title, message, timestamp);
            openButton.append(unreadDot, content);

            openButton.addEventListener("click", () => {
                void openNotification(notification);
            });

            const dismissButton = document.createElement("button");
            dismissButton.type = "button";
            dismissButton.className = "notification-entry-dismiss";
            dismissButton.innerHTML =
                '<i class="bi bi-x-lg" aria-hidden="true"></i>';

            dismissButton.setAttribute(
                "aria-label",
                `Delete ${notification.title || "notification"}`
            );
            dismissButton.title = "Delete notification";

            dismissButton.addEventListener("click", () => {
                void deleteNotification(notification, dismissButton);
            });

            item.append(openButton, dismissButton);
            notificationList.appendChild(item);
        });
    }


    // ======================================================
    // NOTIFICATION TOASTS
    // ======================================================

    function showNextNotificationToast() {
        if (
            notificationToastVisible ||
            !notificationToastHost ||
            notificationToastQueue.length === 0
        ) {
            return;
        }

        const notification = notificationToastQueue.shift();

        const toast = document.createElement("article");
        toast.className = "notification-toast";
        toast.setAttribute("role", "status");

        const content = document.createElement("div");
        content.className = "notification-toast-content";

        const title = document.createElement("strong");
        title.textContent =
            notification.title || "New notification";

        const message = document.createElement("p");
        message.textContent = notification.message || "";

        const actions = document.createElement("div");
        actions.className = "notification-toast-actions";

        const viewButton = document.createElement("button");
        viewButton.className = "notification-toast-view";
        viewButton.type = "button";
        viewButton.textContent = "View";

        const closeButton = document.createElement("button");
        closeButton.className = "notification-close";
        closeButton.type = "button";
        closeButton.setAttribute(
            "aria-label",
            "Dismiss notification"
        );

        closeButton.innerHTML =
            '<i class="bi bi-x-lg" aria-hidden="true"></i>';

        const dismiss = () => {
            if (currentNotificationToast !== toast) {
                toast.remove();
                return;
            }

            window.clearTimeout(notificationToastTimeout);
            notificationToastTimeout = null;

            currentNotificationToast = null;
            notificationToastVisible = false;

            toast.remove();
            showNextNotificationToast();
        };

        viewButton.addEventListener("click", () => {
            dismiss();
            void openNotification(notification);
        });

        closeButton.addEventListener("click", dismiss);

        actions.append(viewButton, closeButton);
        content.append(title, message);
        toast.append(content, actions);

        currentNotificationToast = toast;
        notificationToastHost.appendChild(toast);
        notificationToastVisible = true;

        notificationToastTimeout =
            window.setTimeout(dismiss, 8000);
    }


    // ======================================================
    // NOTIFICATION READ STATE
    // ======================================================

    function isNotificationRead(notification) {
        if (isStaffNotification(notification)) {
            const readBy = Array.isArray(notification.readBy)
                ? notification.readBy
                : [];
            const legacyReadBy = Array.isArray(notification.dismissedBy)
                ? notification.dismissedBy
                : [];

            return readBy.includes(notificationUserId) ||
                legacyReadBy.includes(notificationUserId);
        }

        return notification.isRead === true;
    }

    function markNotificationRead(notification) {
        if (isNotificationRead(notification)) {
            return Promise.resolve();
        }

        const notificationRef =
            doc(db, "notifications", notification.id);

        if (isStaffNotification(notification)) {
            if (!notificationUserId) {
                return Promise.reject(
                    new Error(
                        "No authenticated staff account is available."
                    )
                );
            }

            return updateDoc(notificationRef, {
                readBy: arrayUnion(notificationUserId)
            });
        }

        return updateDoc(notificationRef, {
            isRead: true
        });
    }

    function notificationWithSenderName(notification, senderName) {
        if (
            typeof senderName !== "string" ||
            !senderName.trim() ||
            senderName.trim().toLowerCase() === "pet owner"
        ) {
            return notification;
        }

        const title = String(notification.title || "");
        if (!/^new message from (?:a )?pet owner$/i.test(title.trim())) {
            return notification;
        }

        return {
            ...notification,
            title: `New message from ${senderName.trim()}`
        };
    }

    function publishNotifications(notifications, userId) {
        const renderVersion = ++notificationRenderVersion;
        const namedNotifications = notifications.map((notification) =>
            notification.type === "MESSAGE"
                ? notificationWithSenderName(
                    notification,
                    notification.senderName
                )
                : notification
        );

        if (
            notificationUserId !== userId ||
            renderVersion !== notificationRenderVersion
        ) {
            return;
        }

        const displayNotifications = namedNotifications.map((notification) => {
            if (!isAppointmentRequestNotification(notification)) {
                return notification;
            }

            const sender = /^new message from (.+)$/i.exec(
                String(notification.title || "").trim()
            );
            return {
                ...notification,
                type: "APPOINTMENT",
                title: sender
                    ? `New appointment request from ${sender[1]}`
                    : "New appointment request"
            };
        });
        const namesById = new Map(
            displayNotifications.map((notification) => [
                notification.id,
                notification.title
            ])
        );
        notificationToastQueue.forEach((notification) => {
            const title = namesById.get(notification.id);
            if (title) notification.title = title;
        });

        window.HeaderActions?.setNotifications(
            displayNotifications.map((notification) => ({
                ...notification,
                isRead: isNotificationRead(notification),
                icon: isVetEscalationNotification(notification)
                    ? "bi-clipboard2-pulse"
                    : notification.type === "MESSAGE"
                    ? "bi-chat-dots"
                    : notification.type === "APPOINTMENT"
                        ? "bi-calendar-event"
                        : "bi-bell",
                title: notification.title || "New notification",
                message: notification.message || "",
                time: formatNotificationDate(notification),
                href: getNotificationHref(notification) ||
                    "consultations.html"
            }))
        );

        renderNotifications(displayNotifications);
        showNextNotificationToast();
    }

    async function markAllNotificationsRead(notifications, button) {
        const unreadNotifications = notifications.filter(
            (notification) => !isNotificationRead(notification)
        );

        if (!unreadNotifications.length) {
            button.disabled = false;
            return;
        }

        try {
            await Promise.all(
                unreadNotifications.map((notification) =>
                    markNotificationRead(notification)
                )
            );
        } catch (error) {
            console.error("Could not mark all notifications as read:", error);
            window.alert(
                "Unable to mark all notifications as read. Please try again."
            );
        } finally {
            button.disabled = false;
        }
    }

    // ======================================================
    // OPEN NOTIFICATION
    // ======================================================

    async function openNotification(notification) {
        const target = getNotificationHref(notification);

        if (!target) {
            console.error(
                "Unsupported notification destination:",
                notification.targetScreen
            );
            return;
        }

        try {
            await markNotificationRead(notification);
            closeNotificationPanel();

            window.location.href = target;
        } catch (error) {
            console.error("Could not open notification:", error);

            window.alert(
                "Unable to open this notification. Please try again."
            );
        }
    }


    // ======================================================
    // DELETE NOTIFICATION
    // ======================================================

    async function deleteNotification(
        notification,
        deleteButton
    ) {
        deleteButton.disabled = true;

        try {
            if (isStaffNotification(notification)) {
                if (!notificationUserId) {
                    throw new Error(
                        "No authenticated staff account is available."
                    );
                }

                await updateDoc(
                    doc(db, "notifications", notification.id),
                    { deletedBy: arrayUnion(notificationUserId) }
                );
            } else {
                await deleteDoc(
                    doc(db, "notifications", notification.id)
                );
            }
        } catch (error) {
            deleteButton.disabled = false;

            console.error(
                "Could not delete notification:",
                error
            );

            window.alert(
                "Unable to delete this notification. Please try again."
            );
        }
    }


    // ======================================================
    // SUBSCRIBE TO FIRESTORE NOTIFICATIONS
    // ======================================================

    function subscribeToNotifications(userId, role) {
        if (
            notificationUserId === userId &&
            unsubscribeNotifications.length > 0
        ) {
            return;
        }

        unsubscribeNotifications.forEach((unsubscribe) => {
            unsubscribe();
        });

        unsubscribeNotifications = [];
        notificationUserId = userId;
        notificationSnapshots.clear();

        window.HeaderActions?.setNotificationActions({
            onOpen: (notification) => {
                void openNotification(notification);
            },
            onDismiss: (notification, button) => {
                void deleteNotification(notification, button);
            },
            onMarkAllRead: (notifications, button) => {
                void markAllNotificationsRead(notifications, button);
            }
        });

        const queries = [
            {
                key: "personal",
                value: ["vet", "veterinarian"].includes(role)
                    ? query(
                        collection(db, "notifications"),
                        where("userId", "==", userId),
                        where("type", "in", [
                            "VET_CHAT_ESCALATION",
                            "WEB_USER_ACCESS_CHANGED"
                        ])
                    )
                    : query(
                        collection(db, "notifications"),
                        where("userId", "==", userId)
                    )
            }
        ];

        if (["admin", "staff"].includes(role)) {
            queries.push({
                key: "webStaff",
                value: query(
                    collection(db, "notifications"),
                    where("recipientRole", "==", "webStaff"),
                    limit(100)
                )
            });
        }

        if (role === "superadmin") {
            queries.push({
                key: "webAdmin",
                value: query(
                    collection(db, "notifications"),
                    where("recipientRole", "==", "webAdmin"),
                    limit(100)
                )
            });
        }

        queries.forEach(({ key, value }) => {
            let hasInitialSnapshot = false;

            const unsubscribe = onSnapshot(
                value,
                (snapshot) => {
                    notificationSnapshots.set(
                        key,
                        new Map(
                            snapshot.docs.map((notificationDoc) => [
                                notificationDoc.id,
                                {
                                    id: notificationDoc.id,
                                    ...notificationDoc.data()
                                }
                            ])
                        )
                    );

                    if (hasInitialSnapshot) {
                        snapshot.docChanges().forEach((change) => {
                            if (change.type !== "added") return;

                            const notification = {
                                id: change.doc.id,
                                ...change.doc.data()
                            };

                            const deletedBy =
                                Array.isArray(notification.deletedBy)
                                    ? notification.deletedBy
                                    : [];

                            if (
                                !shouldHideNotificationForRole(
                                    notification,
                                    role
                                ) &&
                                !deletedBy.includes(userId) &&
                                !isNotificationRead(notification) &&
                                !notificationToastQueue.some(
                                    (queued) => queued.id === notification.id
                                )
                            ) {
                                notificationToastQueue.push(notification);
                            }
                        });

                    } else if (!snapshot.metadata.fromCache) {
                        hasInitialSnapshot = true;
                    }

                    const notificationsById = new Map();
                    ["personal", "webStaff", "webAdmin"].forEach((key) => {
                        notificationSnapshots.get(key)?.forEach(
                            (notification, id) => {
                                notificationsById.set(id, notification);
                            }
                        );
                    });

                    const notifications = Array.from(notificationsById.values())
                        .filter((notification) => {
                            if (
                                shouldHideNotificationForRole(
                                    notification,
                                    role
                                )
                            ) {
                                return false;
                            }

                            if (isStaffNotification(notification)) {
                                if (
                                    notification.recipientRole === "webAdmin" &&
                                    role !== "superadmin"
                                ) {
                                    return false;
                                }

                                const deletedBy =
                                    Array.isArray(notification.deletedBy)
                                        ? notification.deletedBy
                                        : [];

                                return !deletedBy.includes(userId);
                            }

                            return (
                                notification.recipientRole !== "webStaff" &&
                                notification.userId === userId &&
                                typeof notification.isRead === "boolean"
                            );
                        })
                        .sort(
                            (first, second) =>
                                (getNotificationDate(second)?.getTime() || 0) -
                                (getNotificationDate(first)?.getTime() || 0)
                        );

                    void publishNotifications(notifications, userId);
                },
                (error) => {
                    console.error(
                        `Could not load ${key} notifications:`,
                        error
                    );

                    if (notificationList) {
                        notificationList.textContent =
                            "Could not load notifications. Please try again later.";
                    }
                }
            );

            unsubscribeNotifications.push(unsubscribe);
        });
    }


    // ======================================================
    // NOTIFICATION PANEL EVENTS
    // ======================================================

    document
        .querySelectorAll("[data-notification-toggle]")
        .forEach((toggle) => {
            toggle.addEventListener("click", () => {
                if (!notificationPanel) return;

                const shouldOpen = notificationPanel.hidden;

                if (!shouldOpen) {
                    closeNotificationPanel();
                    return;
                }

                activeNotificationToggle = toggle;
                notificationPanel.hidden = false;

                document
                    .querySelectorAll("[data-notification-toggle]")
                    .forEach((button) => {
                        button.setAttribute(
                            "aria-expanded",
                            String(button === toggle)
                        );
                    });

                positionNotificationPanel();
            });
        });

    window.addEventListener(
        "resize",
        positionNotificationPanel
    );

    window.addEventListener(
        "scroll",
        positionNotificationPanel,
        true
    );

    document
        .getElementById("notificationPanelClose")
        ?.addEventListener("click", closeNotificationPanel);

    document.addEventListener("click", (event) => {
        const target = event.target;

        if (
            target instanceof Element &&
            notificationPanel &&
            !notificationPanel.hidden &&
            !notificationPanel.contains(target) &&
            !target.closest("[data-notification-toggle]")
        ) {
            closeNotificationPanel();
        }
    });

    document.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
            closeNotificationPanel();
        }
    });


    // ======================================================
    // ACTIVE PAGE
    // ======================================================

    const currentPage =
        window.location.pathname.split("/").pop() ||
        "dashboard.html";

    document
        .querySelectorAll(".sidebar .nav-link")
        .forEach((link) => {
            const linkPage = link.getAttribute("href");

            if (linkPage === currentPage) {
                link.classList.add("active");
            } else {
                link.classList.remove("active");
            }
        });


    // ======================================================
    // SIDEBAR TOGGLE
    // ======================================================

    const restoreSidebarScroll = () => {
        const savedScrollTop = Number(
            sessionStorage.getItem(sidebarScrollKey)
        );

        if (
            Number.isFinite(savedScrollTop) &&
            savedScrollTop > 0
        ) {
            sidebar.scrollTop = savedScrollTop;
        }
    };

    sidebar.addEventListener("scroll", () => {
        sessionStorage.setItem(
            sidebarScrollKey,
            String(sidebar.scrollTop)
        );
    });

    restoreSidebarScroll();

    if (menuToggle) {
        menuToggle.addEventListener("click", () => {
            const isClosed =
                sidebar.classList.toggle("closed");
            sessionStorage.setItem(
                "skinpawsible-sidebar-closed",
                String(isClosed)
            );

            menuToggle.classList.toggle(
                "closed",
                isClosed
            );

            menuToggle.setAttribute(
                "aria-expanded",
                String(!isClosed)
            );

            menuToggle.setAttribute(
                "aria-label",
                isClosed
                    ? "Expand navigation"
                    : "Collapse navigation"
            );

            menuToggle.innerHTML = isClosed
                ? '<i class="bi bi-chevron-right" aria-hidden="true"></i>'
                : '<i class="bi bi-chevron-left" aria-hidden="true"></i>';
        });
    }


    // ======================================================
    // ROLE-BASED ACCESS
    // ======================================================

    onAuthStateChanged(auth, async (user) => {
        if (!user) {
            unsubscribeNotifications.forEach((unsubscribe) => {
                unsubscribe();
            });

            unsubscribeNotifications = [];
            notificationUserId = null;
            notificationSnapshots.clear();
            notificationToastQueue.length = 0;

            window.clearTimeout(notificationToastTimeout);
            notificationToastTimeout = null;
            currentNotificationToast = null;
            notificationToastVisible = false;

            notificationToastHost?.replaceChildren();
            closeNotificationPanel();
            renderNotifications([]);

            if (adminNavigation) {
                adminNavigation.style.display = "none";
            }
            document.getElementById("sidebar")?.classList.remove("permissions-ready");

            return;
        }

        try {
            const userSnap = await getUserProfileSnapshot(user);

            if (!userSnap.exists()) {
                await signOut(auth);
                window.location.href = "login.html";
                return;
            }

            const userData = userSnap.data();

            const role = String(user.role || userData.role || "")
                .toLowerCase()
                .trim();

            if (role) {
                document.documentElement.setAttribute("data-role", role);
            }

            document.documentElement.classList.toggle(
                "role-superadmin",
                role === "superadmin"
            );
            document.documentElement.classList.toggle(
                "role-clinic",
                Boolean(role) && role !== "superadmin"
            );

            const status = String(userData.status || "active")
                .toLowerCase()
                .trim();

            const allowedRoles = [
                "admin",
                "staff",
                "vet",
                "veterinarian",
                "superadmin"
            ];

            if (
                !allowedRoles.includes(role) ||
                status !== "active"
            ) {
                await signOut(auth);
                window.location.href = "login.html";
                return;
            }

            const displayName =
                userData.fullName ||
                userData.displayName ||
                user.displayName ||
                user.email?.split("@")[0] ||
                "User";
            const roleLabel = {
                admin: "Administrator",
                staff: "Staff",
                vet: "Veterinarian",
                veterinarian: "Veterinarian",
                superadmin: "IT Administrator"
            }[role];

            window.HeaderActions?.setUser({
                name: displayName,
                email: userData.email || user.email || "",
                role: roleLabel
            });

            const permissions = await getRolePermissions(role);
            applyRoleBasedNavigation(permissions);

            const currentPageKey = getPagePermissionKey();
            if (currentPageKey && permissions[currentPageKey] !== true) {
                const fallbackPage = Object.keys(permissions)
                    .find((pageKey) => permissions[pageKey] === true);
                const fallbackPath = getPermissionPagePath(fallbackPage);
                if (fallbackPath) {
                    window.location.replace(fallbackPath);
                    return;
                }
                await signOut(auth);
                window.location.replace("login.html");
                return;
            }

            createSeasonalSmsReminder(role).catch((error) => {
                console.error("Could not create seasonal SMS reminder:", error);
            });
            subscribeToNotifications(user.uid, role);
            restoreSidebarScroll();

        } catch (error) {
            console.error(
                "Error checking user role:",
                error
            );
            window.alert("Could not verify page permissions. Please sign in again.");
            await signOut(auth);
            window.location.replace("login.html");
        }
    });
}
