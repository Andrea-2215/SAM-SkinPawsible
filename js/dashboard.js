import { auth, db } from "./firebase-config.js";
import { getUserProfileSnapshot } from "./user-profile.js";

import {
    onAuthStateChanged,
    signOut
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";

import {
    collection,
    collectionGroup,
    doc,
    onSnapshot,
    query,
    where
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

// ==========================================================
// SKINPAWSIBLE DASHBOARD
// Real-time Firestore summaries
// ==========================================================

let unsubscribeListeners = [];
let dashboardStarted = false;

// These collection names must match your Firestore structure.
const COLLECTIONS = {
    pets: "pets",
    scans: "scans",
    appointments: "consultations",
    users: "users",
    smsLogs: "smsLogs"
};

const $ = (id) => document.getElementById(id);

function setText(id, value) {
    const element = $(id);
    if (element) element.textContent = value;
}

function setCount(id, value) {
    setText(id, Number(value || 0).toLocaleString());
}

function showDashError(message) {
    const box = $("dashError");
    if (!box) return;
    box.textContent = message;
    box.classList.remove("d-none");
}

function getValue(data, keys, fallback = "") {
    for (const key of keys) {
        if (data[key] !== undefined && data[key] !== null && data[key] !== "") {
            return data[key];
        }
    }
    return fallback;
}

// Supports Firestore Timestamp, Date, and numeric timestamps.
function parseDateValue(value) {
    if (!value) return null;

    if (typeof value.toDate === "function") {
        const date = value.toDate();
        return Number.isNaN(date.getTime()) ? null : date;
    }

    if (value instanceof Date) {
        return Number.isNaN(value.getTime()) ? null : value;
    }

    if (typeof value === "number") {
        const date = new Date(value < 1e12 ? value * 1000 : value);
        return Number.isNaN(date.getTime()) ? null : date;
    }

    if (typeof value !== "string") return null;

    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;

    const zonedTimestamp = value.match(
        /^(.+?)\s+at\s+(.+?)\s+UTC([+-])(\d{1,2})(?::?(\d{2}))?$/i
    );
    if (!zonedTimestamp) return null;

    const [, datePart, timePart, sign, hours, minutes = "00"] =
        zonedTimestamp;
    const offset =
        `${sign}${hours.padStart(2, "0")}${minutes.padStart(2, "0")}`;
    const zonedDate = new Date(
        `${datePart} ${timePart} GMT${offset}`
    );
    return Number.isNaN(zonedDate.getTime()) ? null : zonedDate;
}

function getDate(data) {
    const dateKeys = [
        "createdAt",
        "timestamp",
        "scanDate",
        "dateCreated",
        "updatedAt",
        "created_at",
        "date"
    ];

    for (const key of dateKeys) {
        const date = parseDateValue(data[key]);
        if (date) return date;
    }

    return null;
}

function formatDate(data) {
    const date = getDate(data);

    return date
        ? date.toLocaleString([], {
            dateStyle: "medium",
            timeStyle: "short"
        })
        : "Date unavailable";
}

function sortNewest(records) {
    return [...records].sort((a, b) => {
        const dateA = getDate(a.data)?.getTime() || 0;
        const dateB = getDate(b.data)?.getTime() || 0;
        return dateB - dateA;
    });
}

function getRecordName(data, fallback) {
    return getValue(data, [
        "petName",
        "name",
        "fullName",
        "ownerName",
        "title"
    ], fallback);
}

// ==========================================================
// SIDEBAR PROFILE + GREETING
// ==========================================================

function renderProfile(user, data = {}) {
    const name = getValue(data, [
        "fullName",
        "displayName",
        "name"
    ], user.displayName || user.email?.split("@")[0] || "User");

    const email = data.email || user.email || "";

    // Greeting based on role
    const role = String(data.role || "").toLowerCase();
    let greeting;

    if (role === "admin") {
        greeting = `Good day, Admin ${name}!`;
    } else if (role === "staff") {
        greeting = `Good day, Staff ${name}!`;
    } else if (role === "veterinarian" || role === "vet") {
        // avoid "Dr. Dr. Name" if the name already starts with Dr.
        greeting = `Good day, Dr. ${name.replace(/^dr\.?\s+/i, "")}!`;
    } else {
        greeting = `Good day, ${name}!`;
    }
    setText("welcomeTitle", greeting);

    // Sidebar profile
    setText("userName", name);
    setText("userEmail", email);
    setText("userInitial", name.charAt(0).toUpperCase());
}

// ==========================================================
// RECENT ACTIVITY
// ==========================================================

function renderActivity(records, textId, timeId, type) {
    const latest = sortNewest(records)[0];

    if (!latest) {
        setText(textId, `No ${type} records available yet.`);
        setText(timeId, "--");
        return;
    }

    const data = latest.data;

    let description;

    if (type === "scan") {
        const condition = getValue(data, [
            "condition",
            "conditionKey",
            "detectedCondition",
            "predictedCondition",
            "prediction",
            "result",
            "diagnosis"
        ], "Unknown condition");

        description =
            `${getRecordName(data, "A dog")} — ${condition}`;
    } else if (type === "pet") {
        description = `Pet record: ${getRecordName(data, "Unnamed pet")}`;
    } else {
        description = `Appointment: ${getRecordName(data, "New appointment")}`;
    }

    setText(textId, description);
    setText(timeId, formatDate(data));
}

function renderSmsOverview(records) {
    const counts = {
        sent: 0,
        pending: 0,
        failed: 0
    };

    for (const { data } of records) {
        const status = String(data.status || "").trim().toLowerCase();

        if (/fail|error|reject|undeliver/.test(status)) {
            counts.failed++;
        } else if (/^(sent|delivered|success|successful)\b/.test(status)) {
            counts.sent++;
        } else if (/pending|queue|process/.test(status)) {
            counts.pending++;
        }
    }

    setCount("smsLogTotal", records.length);
    setCount("smsLogSent", counts.sent);
    setCount("smsLogPending", counts.pending);
    setCount("smsLogFailed", counts.failed);

    const latest = sortNewest(records)[0];

    if (!latest) {
        setText("recentSmsText", "No SMS messages have been logged yet.");
        setText("recentSmsTime", "--");
        return;
    }

    const type = String(latest.data.type || "SMS");
    const status = String(latest.data.status || "Status unavailable");
    const recipient = String(latest.data.recipient || "a pet owner");
    setText("recentSmsText", `${type} message to ${recipient} · ${status}`);
    setText("recentSmsTime", formatDate(latest.data));
}

// ==========================================================
// SCAN ANALYTICS
// ==========================================================

function normalizeCondition(data) {
    const raw = String(getValue(data, [
        "condition",
        "conditionKey",
        "detectedCondition",
        "predictedCondition",
        "prediction",
        "result",
        "diagnosis",
        "className",
        "label"
    ], "")).toLowerCase().trim();

    if (raw.includes("ringworm")) return "ringworm";

    if (
        raw.includes("yeast") ||
        raw.includes("malassezia")
    ) {
        return "yeast";
    }

    if (
        raw.includes("healthy") ||
        raw.includes("normal") ||
        raw.includes("no infection")
    ) {
        return "healthy";
    }

    return null;
}

function renderScanAnalytics(records) {
    const counts = {
        healthy: 0,
        ringworm: 0,
        yeast: 0
    };

    for (const record of records) {
        const condition = normalizeCondition(record.data);
        if (condition) counts[condition]++;
    }

    setCount("totalScans", records.length);
    setCount("healthyCount", counts.healthy);
    setCount("ringwormCount", counts.ringworm);
    setCount("yeastCount", counts.yeast);

    const percentage = (count) =>
        `${records.length ? Math.round(count / records.length * 100) : 0}% of scans`;
    setText("healthyPercent", percentage(counts.healthy));
    setText("ringwormPercent", percentage(counts.ringworm));
    setText("yeastPercent", percentage(counts.yeast));

    // Replace the placeholder with a theme-colored scan distribution chart.
    const chart = document.querySelector(".scan-chart");

    if (chart) {
        chart.replaceChildren();

        const segments = [
            { label: "Healthy", count: counts.healthy, color: "var(--primary)" },
            { label: "Ringworm", count: counts.ringworm, color: "var(--accent)" },
            { label: "Yeast dermatitis", count: counts.yeast, color: "var(--primary-light)" }
        ];
        let currentStop = 0;
        const stops = segments.map(({ count, color }) => {
            const nextStop = records.length
                ? currentStop + count / records.length * 100
                : currentStop;
            const stop = `${color} ${currentStop}% ${nextStop}%`;
            currentStop = nextStop;
            return stop;
        });

        if (currentStop < 100) {
            stops.push(`var(--border-color) ${currentStop}% 100%`);
        }

        const donut = document.createElement("div");
        donut.className = "scan-donut";
        donut.setAttribute("role", "img");
        donut.setAttribute(
            "aria-label",
            `Scan condition distribution: ${segments
                .map(({ label, count }) => `${label} ${count}`)
                .join(", ")}`
        );
        donut.style.background = records.length
            ? `conic-gradient(${stops.join(", ")})`
            : "var(--border-color)";

        const center = document.createElement("div");
        center.className = "scan-donut-center";
        const total = document.createElement("strong");
        total.textContent = records.length.toLocaleString();
        const caption = document.createElement("span");
        caption.textContent = "total scans";
        center.append(total, caption);
        donut.appendChild(center);
        chart.appendChild(donut);
    }

    renderActivity(
        records,
        "recentScanText",
        "recentScanTime",
        "scan"
    );
}

// ==========================================================
// REAL-TIME COLLECTION LISTENERS
// ==========================================================

function listenToCollection(collectionName, onData, ...queryConstraints) {
    const collectionRef = query(
        collection(db, collectionName),
        ...queryConstraints
    );

    const unsubscribe = onSnapshot(
        collectionRef,
        (snapshot) => {
            const records = snapshot.docs.map((item) => ({
                id: item.id,
                data: item.data()
            }));

            onData(records);
        },
        (error) => {
            console.error(`Error reading ${collectionName}:`, error);
            showDashError(
                `Could not load "${collectionName}" data. Please check your connection or Firestore rules.`
            );
        }
    );

    unsubscribeListeners.push(unsubscribe);
}

function listenToCollectionGroup(collectionName, onData) {
    const collectionRef = collectionGroup(db, collectionName);

    const unsubscribe = onSnapshot(
        collectionRef,
        (snapshot) => {
            const records = snapshot.docs.map((item) => ({
                id: item.id,
                data: item.data()
            }));

            onData(records);
        },
        (error) => {
            console.error(
                `Error reading ${collectionName} collection group:`,
                error
            );

            const status = $("firestoreStatus");

            if (status) {
                status.textContent =
                    `Database read failed: ${collectionName}`;
            }
        }
    );

    unsubscribeListeners.push(unsubscribe);
}

function startDashboardListeners(role) {
    // Pets
    listenToCollectionGroup(COLLECTIONS.pets, (records) => {
        setCount("totalPets", records.length);

        renderActivity(
            records,
            "recentPetText",
            "recentPetTime",
            "pet"
        );
    });

    // App scan records
    listenToCollectionGroup(COLLECTIONS.scans, (records) => {
        renderScanAnalytics(records);
    });

    // Appointments
    listenToCollection(COLLECTIONS.appointments, (records) => {
        setCount("totalAppointments", records.length);

        renderActivity(
            records,
            "recentAppointmentText",
            "recentAppointmentTime",
            "appointment"
        );
    });

    // Registered user profile documents
    listenToCollection(COLLECTIONS.users, (records) => {
        setCount("totalUsers", records.length);
    }, ...(role === "admin" ? [where("role", "!=", "superadmin")] : []));

    // SMS message logs
    listenToCollection(COLLECTIONS.smsLogs, (records) => {
        renderSmsOverview(records);
    });
}

// ==========================================================
// AUTHENTICATION
// ==========================================================

onAuthStateChanged(auth, async (user) => {
    if (!user) {
        unsubscribeListeners.forEach((unsubscribe) => unsubscribe());
        unsubscribeListeners = [];
        dashboardStarted = false;

        window.location.href = "login.html";
        return;
    }

    try {
        const userSnap = await getUserProfileSnapshot(user);
        const profile = userSnap.exists() ? userSnap.data() : null;
        const role = String(profile?.role || "").toLowerCase();
        const status = String(profile?.status || "active").toLowerCase();

        if (
            !["admin", "staff", "vet", "veterinarian", "superadmin"].includes(role) ||
            status !== "active"
        ) {
            await signOut(auth);
            window.location.href = "login.html";
            return;
        }

        if (role === "superadmin") {
            window.location.replace("users.html");
            return;
        }

        renderProfile(
            user,
            profile
        );
    } catch (error) {
        console.error("Error loading user profile:", error);
        await signOut(auth);
        window.location.href = "login.html";
        return;
    }

    // Avoid registering duplicate listeners when auth state
    // is re-emitted for the same page session.
    if (!dashboardStarted) {
        dashboardStarted = true;
        startDashboardListeners(role);
    }
});

// ==========================================================
// LOGOUT
// ==========================================================

const logoutBtn = $("logoutBtn");

if (logoutBtn) {
    logoutBtn.addEventListener("click", async () => {
        try {
            localStorage.removeItem("userRole");
            localStorage.removeItem("userName");
            localStorage.removeItem("userEmail");
            localStorage.removeItem("userRoleLabel");
            unsubscribeListeners.forEach((unsubscribe) => unsubscribe());
            unsubscribeListeners = [];

            await signOut(auth);
            window.location.href = "login.html";
        } catch (error) {
            console.error("Logout error:", error);
            alert("Unable to log out. Please try again.");
        }
    });
}
