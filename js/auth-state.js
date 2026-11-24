import { auth } from "./firebase-config.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";

const ROLE_CACHE_KEY = "skinpawsible.auth.role";
const USER_CACHE_KEY = "skinpawsible.auth.user";
const PROFILE_CACHE_PREFIX = "skinpawsible.auth.profile.v1.";
const PROFILE_CACHE_TTL_MS = 60 * 1000;
const authStateListeners = new Set();
const PROFILE_CACHE_FIELDS = ["role", "status", "fullName", "displayName", "email"];

function normalizeRole(role) {
  return String(role || "").trim().toLowerCase();
}

function readStoredUser() {
  try {
    const stored =
      sessionStorage.getItem(USER_CACHE_KEY) ||
      localStorage.getItem(USER_CACHE_KEY);
    const user = stored ? JSON.parse(stored) : null;

    return user?.uid ? user : null;
  } catch {
    return null;
  }
}

export function cacheAuthUserProfile(user, profile) {
  if (!user?.uid || !profile || typeof profile !== "object") return;

  const cachedProfile = PROFILE_CACHE_FIELDS.reduce((result, field) => {
    if (typeof profile[field] === "string") {
      result[field] = profile[field];
    }
    return result;
  }, {});

  if (!Object.keys(cachedProfile).length) return;

  try {
    sessionStorage.setItem(
      `${PROFILE_CACHE_PREFIX}${user.uid}`,
      JSON.stringify({ cachedAt: Date.now(), profile: cachedProfile })
    );
  } catch {
    // Profile caching is optional; Firestore remains the fallback.
  }
}

export function getCachedAuthUserProfile(user) {
  if (!user?.uid) return null;

  const key = `${PROFILE_CACHE_PREFIX}${user.uid}`;
  try {
    const cached = JSON.parse(sessionStorage.getItem(key) || "null");
    const age = Date.now() - cached?.cachedAt;
    if (
      Number.isFinite(cached?.cachedAt) &&
      age >= 0 &&
      age < PROFILE_CACHE_TTL_MS &&
      cached.profile &&
      typeof cached.profile === "object"
    ) {
      return cached.profile;
    }

    sessionStorage.removeItem(key);
  } catch {
    // A missing or unavailable cache falls back to Firestore.
  }

  return null;
}

export function clearCachedAuthUserProfile(userOrUid) {
  const uid = typeof userOrUid === "string" ? userOrUid : userOrUid?.uid;
  if (!uid) return;

  try {
    sessionStorage.removeItem(`${PROFILE_CACHE_PREFIX}${uid}`);
  } catch {
    // Cache cleanup is best effort.
  }
}

// Hydrated synchronously before Firebase restores its auth session. This is
// the vanilla equivalent of initializing a React Auth Context's state from
// storage before rendering protected routes.
export const authState = {
  user: readStoredUser(),
  loading: false
};

export function getInitialAuthState() {
  return authState;
}

export function getInitialAuthUser() {
  return authState.user;
}

export function subscribeAuthState(listener) {
  authStateListeners.add(listener);
  listener(authState);
  return () => authStateListeners.delete(listener);
}

function notifyAuthStateListeners() {
  authStateListeners.forEach((listener) => listener(authState));
}

function readCachedRole(user) {
  if (!user?.uid) return "";

  try {
    const cached = JSON.parse(sessionStorage.getItem(ROLE_CACHE_KEY) || "null");
    return cached?.uid === user.uid ? normalizeRole(cached.role) : "";
  } catch {
    return "";
  }
}

/**
 * Adds the profile role to the in-memory Firebase user and caches it for the
 * current browser session so page navigation does not need another lookup.
 */
export function setAuthUserRole(user, role, profile = {}) {
  if (!user?.uid) return user;

  const normalizedRole = normalizeRole(role);
  Object.defineProperty(user, "role", {
    configurable: true,
    enumerable: true,
    value: normalizedRole,
    writable: true
  });

  const storedUser = {
    uid: user.uid,
    email: user.email || "",
    displayName: user.displayName || profile.displayName || "",
    fullName: profile.fullName || profile.displayName || readStoredUser()?.fullName || "",
    status: String(profile.status || "active").toLowerCase(),
    role: normalizedRole
  };
  authState.user = user;
  notifyAuthStateListeners();

  try {
    sessionStorage.setItem(
      ROLE_CACHE_KEY,
      JSON.stringify({ uid: user.uid, role: normalizedRole })
    );
    sessionStorage.setItem(USER_CACHE_KEY, JSON.stringify(storedUser));
    localStorage.setItem(USER_CACHE_KEY, JSON.stringify(storedUser));
  } catch {
    // Role access still works in memory when session storage is unavailable.
  }

  return user;
}

export function getAuthUserRole(user) {
  return normalizeRole(user?.role) ||
    normalizeRole(readStoredUser()?.role) ||
    readCachedRole(user);
}

export function clearAuthUserRole() {
  try {
    sessionStorage.removeItem(ROLE_CACHE_KEY);
    sessionStorage.removeItem(USER_CACHE_KEY);
    for (let index = sessionStorage.length - 1; index >= 0; index -= 1) {
      const key = sessionStorage.key(index);
      if (key?.startsWith(PROFILE_CACHE_PREFIX)) {
        sessionStorage.removeItem(key);
      }
    }
    localStorage.removeItem(USER_CACHE_KEY);
    localStorage.removeItem("userRole");
    localStorage.removeItem("userName");
    localStorage.removeItem("userEmail");
    localStorage.removeItem("userRoleLabel");
  } catch {
    // Ignore storage cleanup failures.
  }
}

export function redirectSuperadminFromSensitivePage(user, roleOverride = "") {
  const pageName = window.location.pathname
    .toLowerCase()
    .split("/")
    .pop()
    .replace(/\.html$/, "");
  const sensitivePages = new Set([
    "pet-records",
    "scan-records",
    "consultations"
  ]);

  if ((normalizeRole(roleOverride) || getAuthUserRole(user)) !== "superadmin" || !sensitivePages.has(pageName)) {
    return false;
  }

  window.location.replace("users.html");
  return true;
}

/** Auth provider-style subscription: every callback receives user.role. */
export function onAuthStateChangedWithRole(callback) {
  return onAuthStateChanged(auth, (user) => {
    if (!user) {
      authState.user = null;
      clearAuthUserRole();
      notifyAuthStateListeners();
      callback(null);
      return;
    }

    const cachedUser = readStoredUser();
    callback(
      setAuthUserRole(
        user,
        user.role || cachedUser?.role || readCachedRole(user)
      )
    );
  });
}
