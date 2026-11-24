import { auth, db } from "../js/firebase-config.js";
import { ensureRecentAuthentication } from "../js/recent-auth.js";
import { logAuditEvent } from "./auditLogger.js";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  serverTimestamp,
  setDoc
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

export const permissionDefinitions = [
  { section: "Overview", key: "dashboard", title: "Dashboard", description: "View clinic activity summaries." },
  { section: "Clinic & patient data", key: "petRecords", title: "Pet records", description: "View pet records, scan results and veterinary history." },
  { section: "Clinic & patient data", key: "petOwners", title: "Pet owners", description: "View and manage owner profiles and contact details." },
  { section: "Clinic & patient data", key: "scanRecords", title: "Scan records", description: "View and manage scan results." },
  { section: "Clinic & patient data", key: "appointments", title: "Appointments", description: "Book, move and cancel clinic visits." },
  { section: "Communication", key: "consultations", title: "Consultations", description: "Review standard chats and join assigned veterinarian escalations." },
  { section: "Communication", key: "smsLogs", title: "SMS logs", description: "Send and review clinic SMS activity." },
  { section: "Administration", key: "users", title: "Users", description: "Manage user accounts and access." },
  { section: "Administration", key: "roles", title: "Roles & permissions", description: "Configure permissions for clinic roles." },
  { section: "Administration", key: "auditLogs", title: "Audit logs", description: "Review administrative activity." },
  { section: "Administration", key: "securitySettings", title: "Security settings", description: "Manage system security settings." },
  { section: "Account", key: "settings", title: "Settings", description: "Manage account and clinic settings." }
];

const pageKeys = permissionDefinitions.map(({ key }) => key);
const ROLE_PERMISSION_CACHE_PREFIX = "skinpawsible.role.permissions.v1.";
const ROLE_PERMISSION_CACHE_TTL_MS = 60 * 1000;
const pageRoleLimits = {
  dashboard: ["admin", "vet", "staff"],
  petRecords: ["admin", "vet", "staff"],
  petOwners: ["admin", "vet", "staff"],
  scanRecords: ["admin", "vet", "staff"],
  appointments: ["admin", "vet", "staff"],
  consultations: ["admin", "staff", "vet"],
  smsLogs: ["admin", "staff"],
  users: ["admin", "superadmin"],
  roles: ["superadmin"],
  auditLogs: ["superadmin"],
  securitySettings: ["superadmin"],
  settings: ["admin", "vet", "staff", "superadmin"]
};

const rolesData = {
  admin: {
    roleName: "Administrator",
    description: "Runs the clinic day to day",
    permissions: {
      dashboard: true, petRecords: true, petOwners: true, scanRecords: true,
      appointments: true, consultations: true, smsLogs: true, users: false,
      roles: false, auditLogs: false, securitySettings: false, settings: true
    }
  },
  vet: {
    roleName: "Veterinarian",
    description: "Clinical work and patient care",
    permissions: {
      dashboard: true, petRecords: true, petOwners: true, scanRecords: true,
      appointments: true, consultations: true, smsLogs: false, users: false,
      roles: false, auditLogs: false, securitySettings: false, settings: true
    }
  },
  staff: {
    roleName: "Staff",
    description: "Front desk and scheduling",
    permissions: {
      dashboard: true, petRecords: true, petOwners: true, scanRecords: true,
      appointments: true, consultations: true, smsLogs: true, users: false,
      roles: false, auditLogs: false, securitySettings: false, settings: true
    }
  },
  superadmin: {
    roleName: "IT Administrator",
    description: "System administration without access to clinic data",
    permissions: {
      dashboard: false, petRecords: false, petOwners: false, scanRecords: false,
      appointments: false, consultations: false, smsLogs: false, users: true,
      roles: true, auditLogs: true, securitySettings: true, settings: true
    }
  }
};

const pagePermissionKeys = {
  "dashboard.html": "dashboard",
  "pet-records.html": "petRecords",
  "pet-owners.html": "petOwners",
  "scan-records.html": "scanRecords",
  "appointments.html": "appointments",
  "consultations.html": "consultations",
  "sms-logs.html": "smsLogs",
  "users.html": "users",
  "roles-permissions.html": "roles",
  "audit-logs.html": "auditLogs",
  "security-settings.html": "securitySettings",
  "settings.html": "settings"
};

function normalizeRole(role) {
  const value = String(role || "").trim().toLowerCase();
  return value === "veterinarian" ? "vet" : value;
}

function roleHasPageAccess(role, pageKey) {
  return pageRoleLimits[pageKey]?.includes(normalizeRole(role)) === true;
}

function getCachedRolePermissions(role) {
  const cacheKey = `${ROLE_PERMISSION_CACHE_PREFIX}${role}`;
  try {
    const cached = JSON.parse(sessionStorage.getItem(cacheKey) || "null");
    const age = Date.now() - cached?.cachedAt;
    if (
      Number.isFinite(cached?.cachedAt) &&
      age >= 0 &&
      age < ROLE_PERMISSION_CACHE_TTL_MS &&
      cached.permissions &&
      pageKeys.every((key) => typeof cached.permissions[key] === "boolean")
    ) {
      return cached.permissions;
    }

    sessionStorage.removeItem(cacheKey);
  } catch {
    // A missing or unavailable cache falls back to Firestore.
  }

  return null;
}

function cacheRolePermissions(role, permissions) {
  try {
    sessionStorage.setItem(
      `${ROLE_PERMISSION_CACHE_PREFIX}${role}`,
      JSON.stringify({ cachedAt: Date.now(), permissions })
    );
  } catch {
    // Permission caching is optional; Firestore remains the fallback.
  }
}

function clearRolePermissionsCache(role) {
  try {
    sessionStorage.removeItem(`${ROLE_PERMISSION_CACHE_PREFIX}${role}`);
  } catch {
    // Cache cleanup is best effort.
  }
}

export async function seedRoles() {
  const user = auth.currentUser;
  if (!user) throw new Error("A signed-in Super Admin is required to seed roles.");

  const profileSnapshot = await getDoc(doc(db, "users", user.uid));
  const profile = profileSnapshot.exists() ? profileSnapshot.data() : {};
  if (
    String(profile.role || "").toLowerCase().trim() !== "superadmin" ||
    String(profile.status || "active").toLowerCase().trim() !== "active"
  ) {
    throw new Error("Only an active Super Admin can seed role permissions.");
  }

  let recentAuthChecked = false;
  for (const [roleId, roleData] of Object.entries(rolesData)) {
    const roleRef = doc(db, "roles", roleId);
    const existingSnapshot = await getDoc(roleRef);
    const existingData = existingSnapshot.exists() ? existingSnapshot.data() : {};
    const existingPermissions = existingData.permissions || {};
    const permissions = { ...roleData.permissions };
    let needsUpdate = !existingSnapshot.exists() ||
      existingData.roleName !== roleData.roleName ||
      existingData.description !== roleData.description ||
      !existingData.updatedAt ||
      typeof existingData.updatedBy !== "string";

    pageKeys.forEach((key) => {
      if (typeof existingPermissions[key] === "boolean") {
        permissions[key] = existingPermissions[key];
      } else {
        needsUpdate = true;
      }
    });

    if (needsUpdate) {
      if (!recentAuthChecked) {
        await ensureRecentRoleAuthentication(user);
        recentAuthChecked = true;
      }
      await setDoc(roleRef, {
        roleName: roleData.roleName,
        description: roleData.description,
        permissions,
        updatedBy: user.uid,
        updatedAt: serverTimestamp()
      }, { merge: true });
      clearRolePermissionsCache(roleId);
    }
  }
}

export async function getRolePermissions(role) {
  const normalizedRole = normalizeRole(role);
  if (!rolesData[normalizedRole]) return {};

  const cachedPermissions = getCachedRolePermissions(normalizedRole);
  if (cachedPermissions) return { ...cachedPermissions };

  const roleSnapshot = await getDoc(doc(db, "roles", normalizedRole));
  const storedPermissions = roleSnapshot.exists()
    ? roleSnapshot.data().permissions || {}
    : {};

  const permissions = pageKeys.reduce((result, key) => {
    result[key] = roleHasPageAccess(normalizedRole, key) &&
      (typeof storedPermissions[key] === "boolean"
      ? storedPermissions[key]
      : rolesData[normalizedRole].permissions[key]);
    return result;
  }, {});

  cacheRolePermissions(normalizedRole, permissions);
  return permissions;
}

export async function checkPermission(role, pageKey) {
  const permissions = await getRolePermissions(role);
  return permissions[pageKey] === true;
}

export function getPagePermissionKey(pathname = window.location.pathname) {
  const pageName = pathname.split("/").pop().toLowerCase();
  return pagePermissionKeys[pageName] || null;
}

export function getPermissionPagePath(pageKey) {
  return Object.entries(pagePermissionKeys)
    .find(([, permissionKey]) => permissionKey === pageKey)?.[0] || null;
}

function roleName(role) {
  return rolesData[normalizeRole(role)]?.roleName || role;
}

async function ensureRecentRoleAuthentication(user) {
  const securitySettings = await getDoc(
    doc(db, "system_settings", "security")
  );
  if (!securitySettings.exists() ||
      securitySettings.data().requireRecentLogin !== false) {
    await ensureRecentAuthentication(user, "change role permissions");
  }
}

function renderPermissionToggles(role, permissions) {
  const list = document.getElementById("permissionsList");
  if (!list) return;

  const locked = role === "superadmin";
  list.replaceChildren();
  let sectionName = "";

  permissionDefinitions.forEach((permission) => {
    if (permission.section !== sectionName) {
      sectionName = permission.section;
      const heading = document.createElement("h3");
      heading.className = "permission-section-title";
      heading.textContent = sectionName;
      list.appendChild(heading);
    }

    const row = document.createElement("div");
    row.className = "permission-row";
    const description = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = permission.title;
    const helpText = document.createElement("span");
    helpText.textContent = permission.description;
    description.append(title, helpText);

    const toggle = document.createElement("input");
    toggle.className = "permission-toggle";
    toggle.type = "checkbox";
    toggle.dataset.permissionKey = permission.key;
    toggle.setAttribute("aria-label", permission.title);
    toggle.checked = permissions[permission.key] === true;
    toggle.disabled = locked || !roleHasPageAccess(role, permission.key);
    row.append(description, toggle);
    list.appendChild(row);
  });
}

export async function initializeRolePermissionsPage(user) {
  await seedRoles();

  const countsSnapshot = await getDocs(collection(db, "users"));
  const counts = {};
  countsSnapshot.docs.forEach((account) => {
    const role = normalizeRole(account.data().role);
    counts[role] = (counts[role] || 0) + 1;
  });
  document.querySelectorAll("[data-role-count]").forEach((element) => {
    const count = counts[element.dataset.roleCount] || 0;
    element.textContent = `${count} ${count === 1 ? "user" : "users"}`;
  });

  let selectedRole = "admin";
  let selectedPermissions = await getRolePermissions(selectedRole);
  const saveButton = document.getElementById("savePermissionsBtn");
  const list = document.getElementById("permissionsList");
  const title = document.getElementById("permissionsTitle");
  const notice = document.getElementById("permissionsNotice");
  let loadVersion = 0;
  let roleLoading = false;

  const loadRole = async (role) => {
    const thisLoadVersion = ++loadVersion;
    selectedRole = role;
    roleLoading = true;
    saveButton.disabled = true;
    list.replaceChildren();
    const loading = document.createElement("p");
    loading.className = "text-muted py-3";
    loading.textContent = "Loading role permissions...";
    list.appendChild(loading);

    try {
      const permissions = await getRolePermissions(role);
      if (thisLoadVersion !== loadVersion) return;
      selectedPermissions = permissions;
      roleLoading = false;
      title.textContent = `Permissions for ${roleName(role)}`;
      notice.hidden = role !== "superadmin";
      renderPermissionToggles(role, selectedPermissions);
      saveButton.disabled = role === "superadmin";
    } catch (error) {
      if (thisLoadVersion !== loadVersion) return;
      roleLoading = false;
      console.error(`Could not load permissions for ${role}:`, error);
      const message = document.createElement("p");
      message.className = "text-danger py-3";
      message.textContent = "Could not load this role's permissions.";
      list.replaceChildren(message);
      window.alert("Could not load role permissions. Check Firestore access and try again.");
    }
  };

  document.querySelectorAll("[data-permission-role]").forEach((card) => {
    card.addEventListener("click", () => {
      document.querySelectorAll("[data-permission-role]").forEach((item) => item.classList.remove("is-selected"));
      card.classList.add("is-selected");
      void loadRole(card.dataset.permissionRole);
    });
  });

  saveButton.addEventListener("click", async () => {
    if (selectedRole === "superadmin" || saveButton.disabled) return;

    const targetRole = selectedRole;
    const previousPermissions = { ...selectedPermissions };
    const permissions = {};
    document.querySelectorAll("[data-permission-key]").forEach((toggle) => {
      permissions[toggle.dataset.permissionKey] = toggle.checked;
    });
    const changedPermissions = Object.fromEntries(
      pageKeys
        .filter((key) => permissions[key] !== previousPermissions[key])
        .map((key) => [key, permissions[key]])
    );
    if (Object.keys(changedPermissions).length === 0) {
      window.alert("No permission changes to save.");
      return;
    }

    saveButton.disabled = true;
    try {
      await ensureRecentRoleAuthentication(auth.currentUser);
      await setDoc(doc(db, "roles", targetRole), {
        roleName: roleName(targetRole),
        description: rolesData[targetRole].description,
        permissions,
        updatedBy: user.uid,
        updatedAt: serverTimestamp()
      }, { merge: true });
      clearRolePermissionsCache(targetRole);

      if (selectedRole === targetRole) selectedPermissions = permissions;
      const auditLogged = await logAuditEvent({
        action: "ROLE_PERMISSIONS_UPDATED",
        performedBy: {
          uid: user.uid,
          role: "superadmin"
        },
        target: {
          id: targetRole,
          type: "role"
        },
        details: {
          role: roleName(targetRole),
          permissions: changedPermissions
        }
      });
      window.alert(auditLogged
        ? `Permissions for ${roleName(targetRole)} saved.`
        : `Permissions for ${roleName(targetRole)} were saved, but the audit event could not be recorded.`);
    } catch (error) {
      console.error(`Could not save permissions for ${targetRole}:`, error);
      window.alert(error.message === "Recent sign-in confirmation was cancelled."
        ? "The permission change was cancelled."
        : "Could not save role permissions. Confirm your sign-in and try again.");
    } finally {
      saveButton.disabled = roleLoading || selectedRole === "superadmin";
    }
  });

  document.querySelectorAll("[data-permission-role]").forEach((card) => {
    card.classList.toggle("is-selected", card.dataset.permissionRole === selectedRole);
  });
  title.textContent = `Permissions for ${roleName(selectedRole)}`;
  notice.hidden = true;
  renderPermissionToggles(selectedRole, selectedPermissions);
  saveButton.disabled = false;
}