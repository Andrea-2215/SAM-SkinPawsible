import { auth, db } from "./firebase-config.js";
import { getUserProfileSnapshot } from "./user-profile.js";
import { clearCachedAuthUserProfile } from "./auth-state.js";
import { logAuditEvent } from "../utils/auditLogger.js";
import { checkPermission, initializeRolePermissionsPage } from "../utils/roles.js?v=3";
import { ensureRecentAuthentication } from "./recent-auth.js";

import {
  onAuthStateChanged,
  signOut,
  sendPasswordResetEmail
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";

import {
  doc,
  collection,
  getDoc,
  getDocs,
  query,
  where,
  writeBatch,
  serverTimestamp,
  updateDoc,
  deleteDoc
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";



let currentAdminId = null;
let currentAdminRole = null;
let securitySettings = {
  requireRecentLogin: true,
  roleNotifications: true,
  adminPasswordResets: false
};
let selectionMode = false;
let isBulkDeleting = false;
const selectedUserIds = new Set();
const userAccountsById = new Map();
const PRIMARY_SUPERADMIN_UID = "4uIUNYTrBtNm3w2UhlmcFZKHHJk2";
let editModeButton = null;
let selectAllLabel = null;
let selectAllCheckbox = null;
let selectionCount = null;
let deleteSelectedButton = null;
let cancelSelectionButton = null;
let userSelectionControls = null;

// =====================================================
// CHECK LOGIN + ADMIN ACCESS
// =====================================================

onAuthStateChanged(auth, async (user) => {

  // ---------------------------------------------------
  // USER NOT LOGGED IN
  // ---------------------------------------------------

  if (!user) {

    window.location.href = "login.html";

    return;
  }


  try {

    // -------------------------------------------------
    // GET CURRENT USER'S FIRESTORE DOCUMENT
    // -------------------------------------------------

    const userSnap = await getUserProfileSnapshot(user);


    // -------------------------------------------------
    // USER DOCUMENT DOES NOT EXIST
    // -------------------------------------------------

    if (!userSnap.exists()) {

      alert("User account information was not found.");

      await signOut(auth);

      window.location.href = "login.html";

      return;
    }


    const userData = userSnap.data();
    currentAdminId = user.uid;

    const userRole = String(userData.role || "user")
      .toLowerCase()
      .trim();
    currentAdminRole = userRole;
    const hasUsersPermission = await checkPermission(userRole, "users");


    console.log("Logged in user:", user.email);

    console.log("User role:", userRole);


    // -------------------------------------------------
    // SUPERADMIN ONLY
    // -------------------------------------------------

    if (
      !["admin", "superadmin"].includes(userRole) ||
      !hasUsersPermission ||
      String(userData.status || "active").toLowerCase() !== "active"
    ) {

      alert("Access denied. Your role does not have permission to manage users.");

      window.location.href = "dashboard.html";

      return;
    }

    const securitySettingsSnapshot = await getDoc(
      doc(db, "system_settings", "security")
    );
    if (securitySettingsSnapshot.exists()) {
      securitySettings = {
        ...securitySettings,
        ...securitySettingsSnapshot.data()
      };
    }


    // -------------------------------------------------
    // DISPLAY ADMIN INFORMATION
    // -------------------------------------------------

    const userName =
      document.getElementById("userName");

    const userEmail =
      document.getElementById("userEmail");

    const userInitial =
      document.getElementById("userInitial");


    if (userName) {

      userName.textContent =
        userData.fullName ||
        user.displayName ||
        "Administrator";
    }


    if (userEmail) {

      userEmail.textContent =
        user.email || "";
    }


    if (userInitial) {

      userInitial.textContent =
        (
          userData.fullName ||
          user.displayName ||
          "A"
        )
        .charAt(0)
        .toUpperCase();
    }


    // -------------------------------------------------
    // LOAD USERS
    // -------------------------------------------------

    createAdminControls();
    await loadUsers();
    initializeRolesPermissions(userRole, user);


  } catch (error) {

    console.error(
      "Error checking administrator access:",
      error
    );

    alert(
      "Could not verify your account or load web-user settings. Confirm the latest Firestore Rules are published and try again."
    );

    window.location.href = "dashboard.html";
  }

});



// =====================================================
// LOAD USERS FROM FIRESTORE
// =====================================================

async function loadUsers() {

  const staffTable =
    document.getElementById("staffUsersTable");
  const petOwnersTable =
    document.getElementById("petOwnersTable");


  if (!staffTable && !petOwnersTable) {

    console.error(
      "No user account table element was found."
    );

    return;
  }


  try {

    const usersQuery = currentAdminRole === "admin"
      ? query(
        collection(db, "users"),
        where("role", "!=", "superadmin")
      )
      : collection(db, "users");
    const snapshot = await getDocs(usersQuery);

    const staffAccounts = [];
    const petOwners = [];

    userAccountsById.clear();
    snapshot.forEach((docSnap) => {
      const account = {
        id: docSnap.id,
        data: docSnap.data()
      };
      userAccountsById.set(account.id, account);
      const role = normalizeRole(account.data.role);

      if ((role === "petOwner" || role === "pending") && petOwnersTable) {
        petOwners.push(account);
      } else if (role === "pending" && !petOwnersTable) {
        staffAccounts.push(account);
      } else if (role !== "petOwner") {
        staffAccounts.push(account);
      }
    });

    if (staffTable) {
      staffTable.innerHTML = staffAccounts.length
        ? staffAccounts.map((account) =>
          renderAccountRow(account, true)
        ).join("")
        : emptyTableRow(5, "No staff, veterinarian, or pending accounts found.");
    }

    if (petOwnersTable) {
      petOwnersTable.innerHTML = petOwners.length
        ? petOwners.map((account) =>
          renderAccountRow(account, false)
        ).join("")
        : emptyTableRow(9, "No pet-owner accounts found.");
    }

    const usersFooter = document.getElementById("usersFooter");
    if (usersFooter && staffTable) {
      const count = staffAccounts.length;
      usersFooter.textContent =
        `Showing ${count} ${count === 1 ? "user" : "users"}`;
    }

    updateRoleUserCounts(staffAccounts);

    updateAdminControls();

  } catch (error) {

    console.error(
      "Error loading users:",
      error
    );

    const message = `Could not load accounts: ${escapeHTML(error.message)}`;
    if (staffTable) {
      staffTable.innerHTML = emptyTableRow(5, message, true);
    }
    if (petOwnersTable) {
      petOwnersTable.innerHTML = emptyTableRow(9, message, true);
    }

  }

}

function renderAccountRow(account, canManage) {
  const { id, data } = account;
  const normalizedRole = normalizeRole(data.role);
  const status = data.status ||
    (normalizedRole === "pending" ? "Pending" : "Active");
  const statusValue = String(status).toLowerCase();
  const statusClass = statusValue === "inactive" ? "inactive" : statusValue === "pending" ? "pending" : "active";
  const lastActive = data.lastActive || data.lastLogin || data.lastLoginAt || "Just now";
  const name = data.fullName || data.displayName || data.name || "-";

  return `
    <tr data-user-row data-search="${escapeHTML(`${name} ${data.email || ""} ${roleName(normalizedRole)}`.toLowerCase())}">
      <td><div class="user-cell"><span class="user-avatar">${escapeHTML(name.charAt(0).toUpperCase())}</span><span><span class="user-name">${escapeHTML(name)}</span><span class="user-email">${escapeHTML(data.email || "-")}</span></span></div></td>
      <td><span class="user-role-badge">${escapeHTML(roleName(normalizedRole))}</span></td>
      <td><span class="user-status-badge ${statusClass}">${escapeHTML(status)}</span></td>
      <td>${escapeHTML(String(lastActive))}</td>
      <td class="text-end"><button type="button" class="users-manage-button" data-manage-user data-user-id="${escapeHTML(id)}">Manage</button></td>
    </tr>
  `;
}

function createAdminControls() {
  const container = document.querySelector(".users-admin-controls");
  const heading = container?.closest(".users-table-heading");
  const tablePanel = document.getElementById("usersTablePanel");
  if (
    !container ||
    !heading ||
    !tablePanel ||
    container.childElementCount > 0 ||
    currentAdminRole === "superadmin"
  ) return;

  container.className = "users-admin-controls d-flex align-items-center justify-content-end gap-2";

  editModeButton = document.createElement("button");
  editModeButton.type = "button";
  editModeButton.className = "btn btn-sm btn-outline-danger";
  editModeButton.title = "Select user profiles to delete";
  editModeButton.setAttribute("aria-label", "Enter user selection mode");
  editModeButton.innerHTML = '<i class="bi bi-pencil" aria-hidden="true"></i> Edit';
  editModeButton.addEventListener("click", () => {
    if (isBulkDeleting) return;
    selectionMode = !selectionMode;
    selectedUserIds.clear();
    renderUsersSelection();
  });

  selectAllLabel = document.createElement("label");
  selectAllLabel.className = "users-select-all";
  selectAllCheckbox = document.createElement("input");
  selectAllCheckbox.type = "checkbox";
  selectAllCheckbox.className = "form-check-input m-0";
  selectAllCheckbox.setAttribute("aria-label", "Select all user profiles");
  selectAllLabel.append(selectAllCheckbox, document.createTextNode("Select all"));
  selectAllCheckbox.addEventListener("change", () => {
    if (!selectionMode || isBulkDeleting) return;
    const selectableCheckboxes = [
      ...staffUsersTable.querySelectorAll("[data-select-user]:not(:disabled)")
    ];
    selectableCheckboxes.forEach((checkbox) => {
      if (selectAllCheckbox.checked) {
        selectedUserIds.add(checkbox.dataset.userId);
      } else {
        selectedUserIds.delete(checkbox.dataset.userId);
      }
    });
    renderUsersSelection();
  });

  selectionCount = document.createElement("span");
  selectionCount.className = "users-selection-count";

  deleteSelectedButton = document.createElement("button");
  deleteSelectedButton.type = "button";
  deleteSelectedButton.className = "btn btn-sm btn-outline-danger";
  deleteSelectedButton.innerHTML = '<i class="bi bi-trash me-1" aria-hidden="true"></i>Delete Selected';
  deleteSelectedButton.addEventListener("click", deleteSelectedUsers);

  cancelSelectionButton = document.createElement("button");
  cancelSelectionButton.type = "button";
  cancelSelectionButton.className = "btn btn-sm btn-outline-secondary";
  cancelSelectionButton.textContent = "Cancel";
  cancelSelectionButton.addEventListener("click", () => {
    if (isBulkDeleting) return;
    selectionMode = false;
    selectedUserIds.clear();
    renderUsersSelection();
  });

  container.append(editModeButton);
  userSelectionControls = document.createElement("div");
  userSelectionControls.className = "users-selection-controls";
  userSelectionControls.setAttribute("role", "group");
  userSelectionControls.setAttribute("aria-label", "User selection actions");
  userSelectionControls.hidden = true;
  userSelectionControls.append(
    selectAllLabel,
    selectionCount,
    deleteSelectedButton,
    cancelSelectionButton
  );
  heading.insertAdjacentElement("afterend", userSelectionControls);
  updateAdminControls();
}

function renderUsersSelection() {
  selectedUserIds.forEach((id) => {
    if (id === currentAdminId) selectedUserIds.delete(id);
  });
  loadUsers();
}

function updateAdminControls() {
  const container = document.querySelector(".users-admin-controls");
  if (!container || !selectAllCheckbox || !selectionCount || !deleteSelectedButton || !cancelSelectionButton) return;

  if (editModeButton) {
    editModeButton.hidden = selectionMode;
    editModeButton.disabled = isBulkDeleting;
  }
  if (userSelectionControls) {
    userSelectionControls.hidden =
      !selectionMode || Boolean(document.querySelector(".users-table-heading")?.hidden);
  }

  const selectedCount = selectedUserIds.size;
  selectionCount.textContent = `${selectedCount} selected`;
  deleteSelectedButton.disabled = selectedCount === 0 || isBulkDeleting;
  cancelSelectionButton.disabled = isBulkDeleting;

  const selectableCheckboxes = [
    ...(staffUsersTable?.querySelectorAll("[data-select-user]:not(:disabled)") || [])
  ];
  const selectedVisibleCount = selectableCheckboxes.filter((checkbox) =>
    selectedUserIds.has(checkbox.dataset.userId)
  ).length;
  selectAllCheckbox.checked =
    selectableCheckboxes.length > 0 &&
    selectedVisibleCount === selectableCheckboxes.length;
  selectAllCheckbox.indeterminate =
    selectedVisibleCount > 0 &&
    selectedVisibleCount < selectableCheckboxes.length;
}

async function deleteSelectedUsers() {
  if (
    currentAdminRole === "superadmin" ||
    !selectionMode ||
    isBulkDeleting ||
    selectedUserIds.size === 0
  ) return;

  const selectedIds = [...selectedUserIds].filter((id) => id !== currentAdminId);
  if (selectedIds.length === 0) {
    selectedUserIds.clear();
    await loadUsers();
    window.alert("No user profiles are selected.");
    return;
  }

  const confirmed = await window.SkinPawsibleDialogs.confirm(
    `Are you sure you want to delete ${selectedIds.length} selected user profile(s)?\n\nThis removes their profiles from the clinic system. Their sign-in accounts and related records will remain. This action cannot be undone.`,
    { title: "Delete user profiles?", confirmText: "Delete", tone: "danger" }
  );
  if (!confirmed) return;

  isBulkDeleting = true;
  updateAdminControls();

  let deletedCount = 0;
  try {
    const batchSize = 450;
    for (let start = 0; start < selectedIds.length; start += batchSize) {
      const batch = writeBatch(db);
      selectedIds.slice(start, start + batchSize).forEach((id) => {
        batch.delete(doc(db, "users", id));
      });
      await batch.commit();
      selectedIds.slice(start, start + batchSize).forEach((id) => {
        clearCachedAuthUserProfile(id);
      });
      deletedCount += Math.min(batchSize, selectedIds.length - start);
    }

    selectedUserIds.clear();
    selectionMode = false;
    window.alert(`Successfully deleted ${deletedCount} user profile(s).`);
  } catch (error) {
    console.error("Bulk user profile deletion failed:", error);
    if (error.code === "permission-denied") {
      window.alert("Permission denied. Check your Firestore security rules.");
    } else {
      window.alert(
        `Could not complete deletion. ${deletedCount} profile(s) were deleted before the error. Refresh the table and check which profiles remain.`
      );
    }
  } finally {
    isBulkDeleting = false;
    await loadUsers();
  }
}

function getContactNumber(data) {
  const contactFields = [
    "contactNumber",
    "phoneNumber",
    "mobileNumber",
    "phone",
    "mobile",
    "contact",
    "telephone",
    "contact_number",
    "phone_number",
    "mobile_number"
  ];
  const value = contactFields
    .map((field) => data[field])
    .find((fieldValue) =>
      typeof fieldValue === "string" || typeof fieldValue === "number"
        ? String(fieldValue).trim() !== ""
        : false
    );

  return value === undefined ? "-" : String(value);
}

function emptyTableRow(columnCount, message, isError = false) {
  return `
    <tr>
      <td colspan="${columnCount}" class="text-center ${isError ? "text-danger" : "text-muted"} py-4">
        ${message}
      </td>
    </tr>
  `;
}

function normalizeRole(role) {
  const value = String(role || "").toLowerCase().trim();
  if (value === "veterinarian") return "vet";
  if (["owner", "user", "pet owner", "petowner", "pet_owner"].includes(value)) {
    return "petOwner";
  }
  return ["admin", "staff", "vet", "superadmin", "pending"].includes(value)
    ? value
    : "pending";
}

function roleName(role) {
  return {
    admin: "Administrator",
    superadmin: "IT Administrator",
    staff: "Staff",
    vet: "Veterinarian",
    petOwner: "Pet Owner",
    pending: "Pending Approval"
  }[role] || "Pending Approval";
}

function roleOptions(selectedRole, canAssignSuperadmin) {
  const options = [
    ["staff", "Staff"],
    ["pending", "Pending Approval"],
    ["vet", "Veterinarian"],
    ["admin", "Administrator"]
  ];
  if (canAssignSuperadmin) options.push(["superadmin", "IT Administrator"]);

  return options.map(([value, label]) => `
    <option value="${value}" ${value === selectedRole ? "selected" : ""}>
      ${label}
    </option>
  `).join("");
}

function statusOptions(status) {
  const normalized = String(status || "Active").toLowerCase();
  const selected =
    normalized === "inactive" ? "Inactive" :
    normalized === "pending" ? "Pending" :
    "Active";

  return ["Active", "Pending", "Inactive"].map((value) => `
    <option value="${value}" ${value === selected ? "selected" : ""}>
      ${value}
    </option>
  `).join("");
}

async function updateAccountAccess(account, updates) {
  const existingData = account.data || {};
  const roleChanged =
    Object.prototype.hasOwnProperty.call(updates, "role") &&
    normalizeRole(updates.role) !== normalizeRole(existingData.role);
  if (
    roleChanged &&
    normalizeRole(updates.role) === "superadmin" &&
    currentAdminRole !== "superadmin"
  ) {
    throw new Error("Only an IT Administrator can assign the IT Administrator role.");
  }

  const statusChanged =
    Object.prototype.hasOwnProperty.call(updates, "status") &&
    String(updates.status).toLowerCase() !==
      String(existingData.status || "Active").toLowerCase();
  const accessChanged = roleChanged || statusChanged;

  if (accessChanged && securitySettings.requireRecentLogin) {
    await ensureRecentAuthentication(
      auth.currentUser,
      "change a user's role or account access"
    );
  }

  const batch = writeBatch(db);
  batch.update(doc(db, "users", account.id), {
    ...updates,
    updatedAt: serverTimestamp()
  });

  if (accessChanged && securitySettings.roleNotifications) {
    const name = existingData.fullName || existingData.displayName ||
      existingData.name || existingData.email || "A web user";
    const changes = [];
    if (roleChanged) {
      changes.push(
        `role changed from ${roleName(normalizeRole(existingData.role))} to ${roleName(normalizeRole(updates.role))}`
      );
    }
    if (statusChanged) {
      changes.push(
        `access changed from ${existingData.status || "Active"} to ${updates.status}`
      );
    }
    const changeDescription = changes.join(" and ");
    const changedAtMillis = Date.now();
    const notificationBase = {
      type: "WEB_USER_ACCESS_CHANGED",
      targetId: account.id,
      createdAtMillis: changedAtMillis
    };

    batch.set(doc(collection(db, "notifications")), {
      ...notificationBase,
      title: "Your account access changed",
      message: `Your web account ${changeDescription}.`,
      targetScreen: "SETTINGS",
      userId: account.id,
      isRead: false,
      createdAt: serverTimestamp()
    });
    batch.set(doc(collection(db, "notifications")), {
      ...notificationBase,
      title: "Web user access changed",
      message: `${name}: ${changeDescription}.`,
      targetScreen: "USERS",
      recipientRole: "webAdmin",
      readBy: [],
      deletedBy: [],
      createdAt: serverTimestamp()
    });
  }

  await batch.commit();
}

const staffUsersTable = document.getElementById("staffUsersTable");
const petOwnersTable = document.getElementById("petOwnersTable");
const editProfileForm = document.getElementById("editProfileForm");
const editProfileModalElement = document.getElementById("editProfileModal");
let editingProfileUserId = null;

if (staffUsersTable) {
  staffUsersTable.addEventListener("change", (event) => {
    const checkbox = event.target.closest("[data-select-user]");
    if (!checkbox || !selectionMode || isBulkDeleting) return;

    if (checkbox.checked) {
      selectedUserIds.add(checkbox.dataset.userId);
    } else {
      selectedUserIds.delete(checkbox.dataset.userId);
    }

    updateAdminControls();
  });
}

if (staffUsersTable) {
  staffUsersTable.addEventListener("click", async (event) => {
    const saveButton = event.target.closest("[data-save-user]");
    if (!saveButton) return;

    const row = saveButton.closest("tr");
    const roleSelect = row?.querySelector("[data-role-select]");
    const statusSelect = row?.querySelector("[data-status-select]");
    const userId = saveButton.dataset.userId;

    if (!roleSelect || !statusSelect || !userId) return;

    saveButton.disabled = true;

    try {
      const account = userAccountsById.get(userId);
      if (!account) throw new Error("The selected user account is no longer loaded.");
      await updateAccountAccess(account, {
        role: roleSelect.value,
        status: statusSelect.value
      });
      clearCachedAuthUserProfile(userId);
      await loadUsers();
    } catch (error) {
      console.error("Error updating user access:", error);
      alert(error.message === "Recent sign-in confirmation was cancelled."
        ? "The account change was cancelled."
        : "Could not update this user's role or access status. Confirm your sign-in and try again.");
      saveButton.disabled = false;
    }
  });
}

if (petOwnersTable) {
  petOwnersTable.addEventListener("click", async (event) => {
    const approveButton = event.target.closest("[data-approve-owner]");
    const revertButton = event.target.closest("[data-revert-owner]");
    const setStaffRoleButton = event.target.closest("[data-set-staff-role]");
    if (!approveButton && !revertButton && !setStaffRoleButton) return;

    const button = approveButton || revertButton || setStaffRoleButton;
    const userId = button.dataset.userId;
    if (!userId) return;
    const pendingRole = setStaffRoleButton
      ? setStaffRoleButton.closest("tr")?.querySelector("[data-pending-role]")?.value
      : null;

    if (
      revertButton &&
      !await window.SkinPawsibleDialogs.confirm(
        "Revert this pet-owner account to pending approval?",
        { title: "Revert account approval?" }
      )
    ) {
      return;
    }

    if (setStaffRoleButton && !["staff", "vet"].includes(pendingRole)) {
      alert("Choose Staff or Veterinarian before assigning this account.");
      return;
    }

    if (
      setStaffRoleButton &&
      !await window.SkinPawsibleDialogs.confirm(
        `Change this account to ${pendingRole === "vet" ? "Veterinarian" : "Staff"}? It will remain pending and won't have web access until activated.`,
        { title: "Change account role?" }
      )
    ) {
      return;
    }

    button.disabled = true;

    try {
      const account = userAccountsById.get(userId);
      if (!account) throw new Error("The selected user account is no longer loaded.");
      await updateAccountAccess(account, {
        role: approveButton ? "petOwner" : revertButton ? "pending" : pendingRole,
        status: approveButton ? "Active" : "Pending"
      });
      clearCachedAuthUserProfile(userId);
      await loadUsers();
    } catch (error) {
      console.error("Error updating pet-owner account approval:", error);
      alert(error.message === "Recent sign-in confirmation was cancelled."
        ? "The account change was cancelled."
        : "Could not update this pet-owner account. Confirm your sign-in and try again.");
      button.disabled = false;
    }
  });
}

for (const table of [staffUsersTable, petOwnersTable]) {
  table?.addEventListener("click", (event) => {
    const editButton = event.target.closest("[data-edit-profile]");
    if (!editButton) return;

    editingProfileUserId = editButton.dataset.userId;
    document.getElementById("editProfileName").value =
      editButton.dataset.profileName || "";
    document.getElementById("editProfileContact").value =
      editButton.dataset.profileContact || "";
    document.getElementById("editProfileError").classList.add("d-none");
    bootstrap.Modal.getOrCreateInstance(editProfileModalElement).show();
  });
}

if (editProfileForm) {
  editProfileForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const nameInput = document.getElementById("editProfileName");
    const contactInput = document.getElementById("editProfileContact");
    const errorElement = document.getElementById("editProfileError");
    const saveButton = document.getElementById("saveProfileBtn");
    const fullName = nameInput.value.trim();
    const contactNumber = contactInput.value.trim();

    errorElement.classList.add("d-none");

    if (!editingProfileUserId || !fullName) {
      errorElement.textContent = "Enter a name before saving.";
      errorElement.classList.remove("d-none");
      nameInput.focus();
      return;
    }

    saveButton.disabled = true;

    try {
      await updateDoc(doc(db, "users", editingProfileUserId), {
        fullName,
        contactNumber,
        updatedAt: serverTimestamp()
      });
      clearCachedAuthUserProfile(editingProfileUserId);
      bootstrap.Modal.getOrCreateInstance(editProfileModalElement).hide();
      editingProfileUserId = null;
      await loadUsers();
    } catch (error) {
      console.error("Error updating account profile:", error);
      errorElement.textContent = "Could not save these account details. Please try again.";
      errorElement.classList.remove("d-none");
    } finally {
      saveButton.disabled = false;
    }
  });
}

// =====================================================
// ROLES & PERMISSIONS
// =====================================================

function updateRoleUserCounts(accounts) {
  const counts = accounts.reduce((result, account) => {
    const role = normalizeRole(account.data.role);
    result[role] = (result[role] || 0) + 1;
    return result;
  }, {});
  document.querySelectorAll("[data-role-count]").forEach((element) => {
    const count = counts[element.dataset.roleCount] || 0;
    element.textContent = `${count} ${count === 1 ? "user" : "users"}`;
  });
}

function initializeRolesPermissions(userRole, user) {
  const rolesTab = document.getElementById("rolesTab");
  if (!rolesTab || userRole !== "superadmin") return;
  rolesTab.hidden = false;

  document.getElementById("usersTab")?.addEventListener("click", () => {
    document.getElementById("usersTab").classList.add("is-active");
    document.getElementById("usersTab").setAttribute("aria-selected", "true");
    rolesTab.classList.remove("is-active");
    rolesTab.setAttribute("aria-selected", "false");
    document.getElementById("rolesPanel").hidden = true;
    document.querySelector(".users-toolbar").hidden = false;
    document.getElementById("usersTablePanel").hidden = false;
    document.querySelector(".users-table-heading").hidden = false;
    updateAdminControls();
  });
  rolesTab.addEventListener("click", () => {
    rolesTab.classList.add("is-active");
    rolesTab.setAttribute("aria-selected", "true");
    document.getElementById("usersTab").classList.remove("is-active");
    document.getElementById("usersTab").setAttribute("aria-selected", "false");
    document.getElementById("rolesPanel").hidden = false;
    document.querySelector(".users-toolbar").hidden = true;
    document.getElementById("usersTablePanel").hidden = true;
    document.querySelector(".users-table-heading").hidden = true;
    updateAdminControls();
  });
  initializeRolePermissionsPage(user).catch((error) => {
    console.error("Could not initialize role permissions:", error);
    window.alert("Could not initialize role permissions. Check Firestore access and try again.");
  });
}

// =====================================================
// ACCOUNT DRAWER
// =====================================================

const usersDrawer = document.getElementById("usersDrawer");
const usersDrawerBackdrop = document.getElementById("usersDrawerBackdrop");
const userDrawerForm = document.getElementById("userDrawerForm");
let drawerAccount = null;

function closeUsersDrawer() {
  usersDrawer?.classList.remove("is-open");
  usersDrawer?.setAttribute("aria-hidden", "true");
  if (usersDrawerBackdrop) usersDrawerBackdrop.hidden = true;
  document.body.classList.remove("users-drawer-open");
  drawerAccount = null;
}

function openUsersDrawer(account) {
  drawerAccount = account;
  const { id, data } = account;
  const name = data.fullName || data.displayName || data.name || "";
  const normalizedRole = normalizeRole(data.role);
  const status = String(data.status || (normalizedRole === "pending" ? "Pending" : "Active"));
  const roleSelect = document.getElementById("drawerRole");
  const resetPasswordButton = document.getElementById("resetUserPassword");
  const deleteButton = document.getElementById("deleteDrawerUser");
  const isPrimarySuperadmin = id === PRIMARY_SUPERADMIN_UID;
  resetPasswordButton.hidden =
    currentAdminRole !== "superadmin" && !securitySettings.adminPasswordResets;
  deleteButton.disabled = isPrimarySuperadmin;
  deleteButton.title = isPrimarySuperadmin
    ? "The primary superadmin account cannot be deleted."
    : "";
  document.getElementById("drawerUserId").value = id;
  document.getElementById("drawerName").value = name;
  document.getElementById("drawerEmail").value = data.email || "";
  roleSelect.innerHTML = roleOptions(
    normalizedRole,
    currentAdminRole === "superadmin"
  );
  roleSelect.value = normalizedRole;
  document.getElementById("drawerStatus").value = statusOptions(status).match(/value="([^"]+)"[^>]*selected/)?.[1] || "Active";
  const createdAt = data.createdAt?.toDate ? data.createdAt.toDate().toLocaleDateString("en-US") : "—";
  document.getElementById("drawerCreated").textContent = `Created ${createdAt}`;
  document.getElementById("drawerUserName").textContent = name || "Manage user";
  usersDrawerBackdrop.hidden = false;
  usersDrawer?.classList.add("is-open");
  usersDrawer?.setAttribute("aria-hidden", "false");
  document.body.classList.add("users-drawer-open");
  document.getElementById("drawerName")?.focus();
}

if (staffUsersTable) {
  staffUsersTable.addEventListener("click", (event) => {
    const manageButton = event.target.closest("[data-manage-user]");
    if (!manageButton) return;
    const userId = manageButton.dataset.userId;
    const account = userAccountsById.get(userId);
    if (!account) {
      console.error("Could not open user details: account is not loaded.", userId);
      return;
    }
    openUsersDrawer(account);
  });
}

document.getElementById("closeUsersDrawer")?.addEventListener("click", closeUsersDrawer);
usersDrawerBackdrop?.addEventListener("click", closeUsersDrawer);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && usersDrawer?.classList.contains("is-open")) closeUsersDrawer();
});

document.getElementById("deleteDrawerUser")?.addEventListener("click", async (event) => {
  if (
    !drawerAccount ||
    currentAdminRole !== "superadmin" ||
    drawerAccount.id === PRIMARY_SUPERADMIN_UID
  ) return;
  const confirmed = await window.SkinPawsibleDialogs.confirm(
    "Are you sure you want to delete this user's profile?\n\nTheir sign-in account and related records will remain. This action cannot be undone.",
    { title: "Delete user profile?", confirmText: "Delete", tone: "danger" }
  );
  if (!confirmed) return;

  const deleteButton = event.currentTarget;
  deleteButton.disabled = true;
  const account = drawerAccount;
  const accountName = account.data.fullName ||
    account.data.displayName ||
    account.data.name ||
    account.data.email ||
    "Unknown user";
  const accountRole = normalizeRole(account.data.role);
  const accountStatus = account.data.status || "Active";

  try {
    await deleteDoc(doc(db, "users", account.id));
    await logAuditEvent({
      action: "USER_ACCOUNT_DELETED",
      performedBy: {
        uid: currentAdminId,
        role: currentAdminRole
      },
      target: {
        id: account.id,
        type: "user",
        email: account.data.email || null
      },
      details: {
        name: accountName,
        role: accountRole,
        status: accountStatus
      }
    });

    closeUsersDrawer();
    await loadUsers();
  } catch (error) {
    console.error("Could not delete user account:", error);
    window.alert("Could not delete this user account.");
    deleteButton.disabled = false;
  }
});

userDrawerForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!drawerAccount) return;
  const saveButton = document.getElementById("saveDrawerUser");
  saveButton.disabled = true;

  const newName = document.getElementById("drawerName").value.trim();
  const newRole = document.getElementById("drawerRole").value;
  const newStatus = document.getElementById("drawerStatus").value;
  const existingData = drawerAccount.data || {};
  const auditDetails = {};

  if (newName !== String(
    existingData.fullName || existingData.displayName || existingData.name || ""
  ).trim()) {
    auditDetails.newName = newName;
  }
  if (normalizeRole(newRole) !== normalizeRole(existingData.role)) {
    auditDetails.newRole = newRole;
  }
  if (newStatus.toLowerCase() !== String(existingData.status || "Active").toLowerCase()) {
    auditDetails.newStatus = newStatus;
  }

  try {
    await updateAccountAccess(drawerAccount, {
      fullName: newName,
      role: newRole,
      status: newStatus
    });
    clearCachedAuthUserProfile(drawerAccount.id);

    if (Object.keys(auditDetails).length > 0) {
      await logAuditEvent({
        action: "USER_ACCOUNT_UPDATED",
        performedBy: {
          uid: currentAdminId,
          role: currentAdminRole
        },
        target: {
          id: drawerAccount.id,
          type: "user",
          email: drawerAccount.data?.email || null
        },
        details: auditDetails
      });
    }

    closeUsersDrawer();
    await loadUsers();
  } catch (error) {
    console.error("Error saving user details:", error);
    window.alert(error.message === "Recent sign-in confirmation was cancelled."
      ? "The account change was cancelled."
      : "Could not save this user's details. Confirm your sign-in and try again.");
  } finally {
    saveButton.disabled = false;
  }
});

// WITH THIS:
document.getElementById("resetUserPassword")?.addEventListener("click", async () => {
  if (
    currentAdminRole !== "superadmin" &&
    !securitySettings.adminPasswordResets
  ) {
    window.alert("Password reset is not enabled for clinic administrators.");
    return;
  }

  if (!drawerAccount || !drawerAccount.data?.email) {
    window.alert("No valid email address found for this user account.");
    return;
  }

  const userEmail = drawerAccount.data.email;
  const userName = drawerAccount.data.fullName || drawerAccount.data.name || userEmail;

  const confirmed = await window.SkinPawsibleDialogs.confirm(
    `Send a password reset email to ${userName} (${userEmail})?`,
    { title: "Send password reset?", confirmText: "Send" }
  );
  if (!confirmed) return;

  const resetButton = document.getElementById("resetUserPassword");
  resetButton.disabled = true;

  try {
    await sendPasswordResetEmail(auth, userEmail);

    const auditLogged = await logAuditEvent({
      action: "PASSWORD_RESET_REQUESTED",
      performedBy: {
        uid: currentAdminId,
        role: currentAdminRole
      },
      target: {
        id: drawerAccount.id,
        type: "user",
        email: userEmail
      },
      details: {
        recipientEmail: userEmail,
        initiatedByAdmin: true
      }
    });

    window.alert(auditLogged
      ? `Password reset email sent to ${userEmail}.`
      : `Password reset email sent to ${userEmail}, but the audit event could not be recorded.`);
  } catch (error) {
    console.error("Error sending password reset email:", error);
    if (error.code === "auth/user-not-found") {
      window.alert("No authentication account exists for this email address.");
    } else {
      window.alert(error.message || "Could not send the password reset email.");
    }
  } finally {
    resetButton.disabled = false;
  }
});

document.getElementById("userSearch")?.addEventListener("input", (event) => {
  const query = event.target.value.trim().toLowerCase();
  document.querySelectorAll("[data-user-row]").forEach((row) => {
    row.hidden = query && !row.dataset.search.includes(query);
  });
});

document.getElementById("addUserBtn")?.addEventListener("click", () => {
  window.alert("Create a new account from the registration page, then manage its role and access here.");
});

// =====================================================
// ESCAPE HTML
// =====================================================

function escapeHTML(value) {

  const div =
    document.createElement("div");

  div.textContent =
    String(value);

  return div.innerHTML
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
