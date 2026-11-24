import { auth, db } from "./firebase-config.js";
import { getUserProfileSnapshot } from "./user-profile.js";
import { ensureRecentAuthentication } from "./recent-auth.js";
import { logAuditEvent } from "../utils/auditLogger.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import {
  doc,
  getDoc,
  serverTimestamp,
  setDoc
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

const defaults = {
  requireRecentLogin: true,
  roleNotifications: true,
  adminPasswordResets: false
};

const securitySettingsRef = doc(db, "system_settings", "security");

async function loadSettings() {
  const snapshot = await getDoc(securitySettingsRef);
  return snapshot.exists()
    ? { ...defaults, ...snapshot.data() }
    : { ...defaults };
}

async function initializeSettings(user) {
  let state = await loadSettings();
  document.querySelectorAll("[data-security-key]").forEach((toggle) => {
    toggle.checked = Boolean(state[toggle.dataset.securityKey]);
  });

  document.getElementById("securitySettingsForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const saveButton = event.currentTarget.querySelector('[type="submit"]');
    const message = document.getElementById("securitySaveMessage");
    message.textContent = "";
    message.classList.remove("is-warning");

    const nextState = {};
    document.querySelectorAll("[data-security-key]").forEach((toggle) => {
      nextState[toggle.dataset.securityKey] = toggle.checked;
    });

    const changedSettings = Object.keys(nextState).filter(
      (key) => Boolean(state[key]) !== nextState[key]
    ).map((key) => ({
      key,
      enabled: nextState[key]
    }));

    if (changedSettings.length === 0) {
      message.textContent = "No security settings changed.";
      return;
    }

    saveButton.disabled = true;

    try {
      await ensureRecentAuthentication(auth.currentUser, "save security settings");
      await setDoc(securitySettingsRef, {
        ...nextState,
        updatedAt: serverTimestamp()
      }, { merge: true });
      state = nextState;

      const auditLogged = await logAuditEvent({
        action: "SECURITY_SETTINGS_UPDATED",
        performedBy: {
          uid: user.uid,
          role: "superadmin"
        },
        target: {
          id: "security",
          type: "security settings"
        },
        details: {
          changed: changedSettings
        }
      });

      message.classList.toggle("is-warning", !auditLogged);
      message.textContent = auditLogged
        ? "Security settings saved."
        : "Settings were saved, but the audit event could not be recorded.";
    } catch (error) {
      console.error("Could not save security settings:", error);
      message.classList.remove("is-warning");
      message.textContent = error.message === "Recent sign-in confirmation was cancelled."
        ? "Save cancelled."
        : "Could not save settings. Confirm your sign-in and try again.";
    } finally {
      saveButton.disabled = false;
    }
  });
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
    await initializeSettings(user);
  } catch (error) {
    console.error("Could not verify security settings access:", error);
    window.alert(
      "Could not verify access or load settings. Confirm the latest Firestore Rules are published, then try again."
    );
    window.location.href = "users.html";
  }
});
