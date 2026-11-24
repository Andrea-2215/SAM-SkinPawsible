
import { db } from "./firebase-config.js";
import { watchActiveStaffPage } from "./page-auth.js";

import {
  collection,
  doc,
  onSnapshot,
  query,
  where,
  writeBatch
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";


// ==========================================================
// CONFIGURATION
// ==========================================================

const PETS_COLLECTION = "pets";
const PET_OWNER_FIELDS = ["ownerId", "ownerUid", "userId", "uid"];
const PET_NAME_FIELDS = ["name", "petName"];


// ==========================================================
// DOM ELEMENTS
// ==========================================================

const table = document.getElementById("petOwnersTable");
const searchInput = document.getElementById("ownerSearch");
const footer = document.getElementById("ownerFooter");
const showMoreButton = document.getElementById("petOwnersShowMore");
const chips = document.querySelectorAll(".po-chip");
const ownerDateFilterToggle = document.getElementById("ownerDateFilterToggle");
const ownerDateFilterPanel = document.getElementById("ownerDateFilterPanel");
const ownerDateFromInput = document.getElementById("ownerDateFrom");
const ownerDateToInput = document.getElementById("ownerDateTo");
const ownerDateResetButton = document.getElementById("ownerDateReset");
const ownerSortNewestButton = document.getElementById("ownerSortNewest");
const ownerSortOldestButton = document.getElementById("ownerSortOldest");
const downloadOwnerReportButton = document.getElementById("downloadOwnerReportBtn");


// ==========================================================
// STATE
// ==========================================================

let unsubscribeOwners = null;
let unsubscribePets = null;

let allOwners = [];
let petsByOwner = new Map();

let activeFilter = "all";
let showAllOwners = false;
const PET_OWNERS_PAGE_SIZE = 10;
let dateFrom = "";
let dateTo = "";
let dateSortDirection = "desc";
let currentRole = "";
let currentUserId = "";

const selectedOwnerIds = new Set();
let selectionMode = false;
let isBulkDeleting = false;
let selectAllOwners = null;
let selectedOwnersCount = null;
let deleteSelectedOwnersButton = null;
let cancelOwnerSelectionButton = null;
let ownerEditModeButton = null;
let ownerSelectionControls = null;


// ==========================================================
// AUTHENTICATION AND ROLE CHECK
// ==========================================================

watchActiveStaffPage(({ user, profile, role }) => {
  currentRole = role;
  currentUserId = user.uid;

  if (["admin", "staff"].includes(currentRole)) {
    createOwnerAdminControls();
  }

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

  loadPetOwners();
  loadPets();
}, (error) => {
  console.error("Could not verify web access:", error);
  showError("Unable to verify your account. Please log in again.");
});


// ==========================================================
// LOAD PET OWNERS
// ==========================================================

function loadPetOwners() {
  if (!table) return;

  unsubscribeOwners?.();

  unsubscribeOwners = onSnapshot(
    query(
      collection(db, "users"),
      where("role", "in", [
        "petOwner",
        "petowner",
        "pet_owner",
        "pet-owner",
        "pet owner",
        "owner"
      ])
    ),
    (snapshot) => {
      allOwners = snapshot.docs
        .map((ownerDoc) => ({
          id: ownerDoc.id,
          ...ownerDoc.data()
        }))
        .filter((owner) => {
          const role = String(owner.role || "")
            .toLowerCase()
            .trim();

          return [
            "petowner",
            "pet_owner",
            "pet-owner",
            "pet owner",
            "owner"
          ].includes(role);
        });

      const ownerIds = new Set(allOwners.map((owner) => owner.id));
      selectedOwnerIds.forEach((id) => {
        if (!ownerIds.has(id) || id === currentUserId) {
          selectedOwnerIds.delete(id);
        }
      });

      renderPetOwners();
    },
    (error) => {
      console.error("Could not load pet owners:", error);

      showError(
        "Could not load pet owners. Check your Firestore permissions."
      );
    }
  );
}


// ==========================================================
// LOAD PET RECORDS
// ==========================================================

function loadPets() {
  unsubscribePets?.();

  unsubscribePets = onSnapshot(
    collection(db, PETS_COLLECTION),
    (snapshot) => {
      const map = new Map();

      snapshot.docs.forEach((petDoc) => {
        const pet = petDoc.data();
        const ownerId = firstValue(pet, PET_OWNER_FIELDS);
        const petName = capitalizeFirstLetter(
          firstValue(pet, PET_NAME_FIELDS)
        );

        if (!ownerId || !petName) return;

        const normalizedOwnerId = String(ownerId);

        if (!map.has(normalizedOwnerId)) {
          map.set(normalizedOwnerId, []);
        }

        map.get(normalizedOwnerId).push(String(petName));
      });

      petsByOwner = map;
      renderPetOwners();
    },
    (error) => {
      console.error("Could not load pets:", error);
    }
  );
}


// ==========================================================
// HELPERS
// ==========================================================

function firstValue(obj, keys) {
  for (const key of keys) {
    if (obj[key]) return obj[key];
  }

  return "";
}

function capitalizeFirstLetter(value) {
  const name = String(value || "").trim();
  const [firstCharacter, ...remainingCharacters] = name;

  return firstCharacter
    ? firstCharacter.toLocaleUpperCase() +
        remainingCharacters.join("")
    : "";
}

function getOwnerName(owner) {
  return (
    owner.fullName ||
    owner.displayName ||
    owner.name ||
    owner.ownerName ||
    "Unnamed owner"
  );
}

function getOwnerContact(owner) {
  return (
    owner.contact ||
    owner.contactNumber ||
    owner.phone ||
    owner.phoneNumber ||
    ""
  );
}

function getStatusKey(owner) {
  return String(owner.status || "active").toLowerCase().trim() === "active"
    ? "active"
    : "inactive";
}

function getInitials(name) {
  const parts = String(name).trim().split(/\s+/).filter(Boolean);

  if (parts.length === 0) return "?";

  if (parts.length === 1) {
    return parts[0].charAt(0).toUpperCase();
  }

  return (
    parts[0].charAt(0) +
    parts[parts.length - 1].charAt(0)
  ).toUpperCase();
}

function avatarIndex(id) {
  let hash = 0;

  for (const ch of String(id)) {
    hash = (hash * 31 + ch.charCodeAt(0)) % 5;
  }

  return hash;
}

function formatDate(value) {
  if (!value) return "-";

  const date =
    typeof value.toDate === "function"
      ? value.toDate()
      : new Date(value);

  return Number.isNaN(date.getTime())
    ? "-"
    : date.toLocaleDateString("en-US", {
        month: "long",
        day: "numeric",
        year: "numeric"
      });
}

function getOwnerRegistrationDate(owner) {
  const value =
    owner.createdAt ||
    owner.created_at ||
    owner.dateCreated ||
    owner.registrationDate ||
    owner.timestamp;

  if (!value) return null;

  const date =
    typeof value.toDate === "function"
      ? value.toDate()
      : value instanceof Date
        ? value
        : new Date(value);

  return Number.isNaN(date.getTime()) ? null : date;
}

function localDateInputValue(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function matchesDateFilter(owner) {
  if (!dateFrom && !dateTo) return true;

  const registrationDate = getOwnerRegistrationDate(owner);
  if (!registrationDate) return false;

  const date = localDateInputValue(registrationDate);
  return (!dateFrom || date >= dateFrom) && (!dateTo || date <= dateTo);
}

function closeOwnerDateFilter() {
  if (!ownerDateFilterToggle || !ownerDateFilterPanel) return;
  ownerDateFilterPanel.hidden = true;
  ownerDateFilterToggle.setAttribute("aria-expanded", "false");
}


// ==========================================================
// TABLE MESSAGE
// ==========================================================

function messageRow(text, extraClass = "") {
  const row = document.createElement("tr");
  const cell = document.createElement("td");

  cell.colSpan = 5;
  cell.className = `po-message ${extraClass}`.trim();
  cell.textContent = text;

  row.appendChild(cell);

  return row;
}


// ==========================================================
// RENDER PET OWNERS
// ==========================================================

function renderPetOwners() {
  if (!table) return;

  const filteredOwners = getVisibleOwners();
  const isShowingAll = showAllOwners || selectionMode;
  const shownOwners = isShowingAll
    ? filteredOwners
    : filteredOwners.slice(0, PET_OWNERS_PAGE_SIZE);

  if (footer) {
    footer.textContent =
      `Showing ${shownOwners.length} of ${filteredOwners.length} owners`;
  }
  if (showMoreButton) {
    showMoreButton.hidden =
      filteredOwners.length <= PET_OWNERS_PAGE_SIZE || selectionMode;
    showMoreButton.textContent = isShowingAll
      ? "Show fewer pet owners"
      : `Show remaining pet owners (${filteredOwners.length - shownOwners.length})`;
  }
  if (downloadOwnerReportButton) {
    downloadOwnerReportButton.disabled = filteredOwners.length === 0;
  }
  ownerDateFilterToggle?.classList.toggle(
    "has-date-filter",
    Boolean(dateFrom || dateTo)
  );

  table.replaceChildren();

  if (filteredOwners.length === 0) {
    if (footer) footer.textContent = `Showing 0 of ${allOwners.length} owners`;
    if (showMoreButton) showMoreButton.hidden = true;
    table.appendChild(
      messageRow(
        allOwners.length === 0
          ? "No registered pet-owner accounts found."
          : "No owners match your search."
      )
    );

    updateOwnerAdminControls(filteredOwners);
    return;
  }

  for (const owner of shownOwners) {
    const name = getOwnerName(owner);
    const email = owner.email || "-";
    const contact = getOwnerContact(owner) || "-";
    const pets = petsByOwner.get(owner.id) || [];
    const statusKey = getStatusKey(owner);

    const registered = getOwnerRegistrationDate(owner);

    const row = document.createElement("tr");

    // OWNER: AVATAR, NAME, EMAIL

    const ownerCell = document.createElement("td");
    const ownerWrap = document.createElement("div");

    ownerWrap.className = "po-owner";

    if (["admin", "staff"].includes(currentRole) && selectionMode) {
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.className = "form-check-input m-0";
      checkbox.dataset.ownerId = owner.id;
      checkbox.checked = selectedOwnerIds.has(owner.id);
      checkbox.disabled = owner.id === currentUserId || isBulkDeleting;
      checkbox.setAttribute("aria-label", `Select ${name} for deletion`);
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) selectedOwnerIds.add(owner.id);
        else selectedOwnerIds.delete(owner.id);
        updateOwnerAdminControls(filteredOwners);
      });
      ownerWrap.appendChild(checkbox);
    }

    const avatar = document.createElement("span");

    avatar.className =
      `po-avatar po-av-${avatarIndex(owner.id)}`;

    avatar.textContent = getInitials(name);

    const ownerText = document.createElement("div");
    ownerText.className = "po-owner-text";

    const ownerNameElement = document.createElement("span");
    ownerNameElement.className = "po-owner-name";
    ownerNameElement.textContent = name;

    const ownerEmail = document.createElement("span");
    ownerEmail.className = "po-owner-email";
    ownerEmail.textContent = email;

    ownerText.append(ownerNameElement, ownerEmail);
    ownerWrap.append(avatar, ownerText);
    ownerCell.appendChild(ownerWrap);

    // PETS

    const petsCell = document.createElement("td");

    if (pets.length === 0) {
      const none = document.createElement("span");

      none.className = "po-no-pets";
      none.textContent = "No pets yet";

      petsCell.appendChild(none);
    } else {
      const petsWrap = document.createElement("div");
      petsWrap.className = "po-pets";

      pets.forEach((petName) => {
        const chip = document.createElement("span");
        chip.className = "po-pet";

        const icon = document.createElement("span");

        icon.className = "po-pet-icon";
        icon.textContent = "🐾";
        icon.setAttribute("aria-hidden", "true");

        chip.append(icon, document.createTextNode(petName));
        petsWrap.appendChild(chip);
      });

      petsCell.appendChild(petsWrap);
    }

    // CONTACT

    const contactCell = document.createElement("td");
    contactCell.textContent = String(contact);

    // REGISTERED DATE

    const registeredCell = document.createElement("td");
    registeredCell.textContent = formatDate(registered);

    // STATUS

    const statusCell = document.createElement("td");
    const statusBadge = document.createElement("span");

    statusBadge.className = `po-badge po-badge-${statusKey}`;
    statusBadge.textContent = statusKey;

    statusCell.appendChild(statusBadge);

    row.append(
      ownerCell,
      petsCell,
      contactCell,
      registeredCell,
      statusCell
    );

    table.appendChild(row);
  }

  updateOwnerAdminControls(filteredOwners);
}

function createOwnerAdminControls() {
  const container = document.querySelector(".po-admin-controls");
  const header = container?.closest(".po-head");
  if (!container || !header || container.childElementCount) return;

  ownerEditModeButton = makeAdminButton(
    "bi-pencil",
    "Select pet owners to delete",
    "Enter pet-owner selection mode",
    "Edit"
  );
  ownerEditModeButton.addEventListener("click", () => {
    if (isBulkDeleting) return;
    selectionMode = !selectionMode;
    selectedOwnerIds.clear();
    renderPetOwners();
  });

  const selectAllLabel = document.createElement("label");
  selectAllLabel.className = "d-flex align-items-center gap-2 small";
  selectAllOwners = document.createElement("input");
  selectAllOwners.type = "checkbox";
  selectAllOwners.className = "form-check-input m-0";
  selectAllOwners.setAttribute("aria-label", "Select all visible pet owners");
  selectAllLabel.append(selectAllOwners, document.createTextNode("Select all"));
  selectAllOwners.addEventListener("change", () => {
    const visibleOwners = getVisibleOwners();
    visibleOwners.forEach((owner) => {
      if (selectAllOwners.checked && owner.id !== currentUserId) {
        selectedOwnerIds.add(owner.id);
      } else {
        selectedOwnerIds.delete(owner.id);
      }
    });
    renderPetOwners();
  });

  selectedOwnersCount = document.createElement("span");
  selectedOwnersCount.className = "small text-muted";

  deleteSelectedOwnersButton = makeAdminButton(
    "bi-trash",
    "Delete selected pet owners",
    "Delete selected pet owners",
    "Delete Selected"
  );
  deleteSelectedOwnersButton.addEventListener("click", deleteSelectedOwners);

  cancelOwnerSelectionButton = document.createElement("button");
  cancelOwnerSelectionButton.type = "button";
  cancelOwnerSelectionButton.className = "btn btn-sm btn-outline-secondary";
  cancelOwnerSelectionButton.textContent = "Cancel";
  cancelOwnerSelectionButton.addEventListener("click", () => {
    if (isBulkDeleting) return;
    selectionMode = false;
    selectedOwnerIds.clear();
    renderPetOwners();
  });

  container.className = "po-admin-controls d-flex flex-wrap align-items-center gap-2 ms-auto";
  container.append(ownerEditModeButton);

  ownerSelectionControls = document.createElement("div");
  ownerSelectionControls.className = "po-selection-controls";
  ownerSelectionControls.setAttribute("role", "group");
  ownerSelectionControls.setAttribute("aria-label", "Pet owner selection actions");
  ownerSelectionControls.hidden = true;
  ownerSelectionControls.append(
    selectAllLabel,
    selectedOwnersCount,
    deleteSelectedOwnersButton,
    cancelOwnerSelectionButton
  );
  header.append(ownerSelectionControls);
}

function makeAdminButton(icon, title, ariaLabel, text = "") {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "btn btn-sm btn-outline-danger";
  button.title = title;
  button.setAttribute("aria-label", ariaLabel);
  button.innerHTML = `<i class="bi ${icon}" aria-hidden="true"></i>${text ? ` ${text}` : ""}`;
  return button;
}

function getVisibleOwners() {
  const term = (searchInput?.value || "").trim().toLowerCase();
  return allOwners.filter((owner) => {
    if (activeFilter !== "all" && getStatusKey(owner) !== activeFilter) return false;
    if (!matchesDateFilter(owner)) return false;
    const pets = petsByOwner.get(owner.id) || [];
    return `${getOwnerName(owner)} ${owner.email || ""} ${getOwnerContact(owner)} ${pets.join(" ")}`
      .toLowerCase()
      .includes(term);
  }).sort((a, b) => {
    const aTime = getOwnerRegistrationDate(a)?.getTime();
    const bTime = getOwnerRegistrationDate(b)?.getTime();
    if (aTime === undefined) return bTime === undefined ? 0 : 1;
    if (bTime === undefined) return -1;
    return dateSortDirection === "asc" ? aTime - bTime : bTime - aTime;
  });
}

function downloadOwnerReport() {
  const owners = getVisibleOwners();
  if (!owners.length) {
    window.alert("There are no visible pet owners to export.");
    return;
  }

  const xlsx = window.XLSX;
  if (!xlsx) {
    console.error("Excel report library did not load.");
    window.alert("Excel export is unavailable. Refresh the page and try again.");
    return;
  }

  const rows = owners.map((owner) => [
    getOwnerName(owner),
    owner.email || "",
    getOwnerContact(owner),
    (petsByOwner.get(owner.id) || []).join(", ") || "No pets",
    formatDate(getOwnerRegistrationDate(owner)),
    getStatusKey(owner)
  ]);
  const columns = [
    "Pet Owner",
    "Email",
    "Contact",
    "Pets",
    "Registered",
    "Status"
  ];
  const generatedAt = new Date();
  const dateRangeLabel = dateFrom || dateTo
    ? `${dateFrom || "Any"} to ${dateTo || "Any"}`
    : "Any date";
  const statusLabel = activeFilter === "all"
    ? "All"
    : activeFilter.charAt(0).toUpperCase() + activeFilter.slice(1);
  const worksheet = xlsx.utils.aoa_to_sheet([
    ["SKINPAWSIBLE - PET OWNERS REPORT"],
    ["Pet owner details for the accounts currently shown in Pet Owners."],
    [`Generated: ${generatedAt.toLocaleString()}`],
    [`Owners included: ${owners.length}    Status: ${statusLabel}    Registration date range: ${dateRangeLabel}    Sort: ${dateSortDirection === "desc" ? "Newest" : "Oldest"}`],
    columns,
    ...rows
  ]);
  worksheet["!cols"] = [
    { wch: 28 },
    { wch: 34 },
    { wch: 20 },
    { wch: 32 },
    { wch: 18 },
    { wch: 14 }
  ];
  worksheet["!merges"] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: columns.length - 1 } },
    { s: { r: 1, c: 0 }, e: { r: 1, c: columns.length - 1 } },
    { s: { r: 2, c: 0 }, e: { r: 2, c: columns.length - 1 } },
    { s: { r: 3, c: 0 }, e: { r: 3, c: columns.length - 1 } }
  ];

  const workbook = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(workbook, worksheet, "Pet Owners");
  workbook.Props = {
    Title: "SkinPawsible Pet Owners Report",
    Subject: "Pet owner contact and registration details",
    Author: "SkinPawsible",
    CreatedDate: generatedAt
  };

  const filenameDate = [
    generatedAt.getFullYear(),
    String(generatedAt.getMonth() + 1).padStart(2, "0"),
    String(generatedAt.getDate()).padStart(2, "0")
  ].join("-");
  xlsx.writeFile(workbook, `SkinPawsible-Pet-Owners-${filenameDate}.xlsx`);
}

downloadOwnerReportButton?.addEventListener("click", downloadOwnerReport);

function setOwnerDateSort(direction) {
  dateSortDirection = direction;
  showAllOwners = false;
  const newestFirst = direction === "desc";
  ownerSortNewestButton?.classList.toggle("active", newestFirst);
  ownerSortNewestButton?.setAttribute("aria-pressed", String(newestFirst));
  ownerSortOldestButton?.classList.toggle("active", !newestFirst);
  ownerSortOldestButton?.setAttribute("aria-pressed", String(!newestFirst));
  renderPetOwners();
}

ownerSortNewestButton?.addEventListener("click", () => {
  setOwnerDateSort("desc");
});

ownerSortOldestButton?.addEventListener("click", () => {
  setOwnerDateSort("asc");
});

function updateOwnerAdminControls(visibleOwners = getVisibleOwners()) {
  if (!["admin", "staff"].includes(currentRole) || !selectAllOwners) return;

  ownerEditModeButton.classList.toggle("d-none", selectionMode);
  ownerEditModeButton.disabled = isBulkDeleting;
  ownerSelectionControls.hidden = !selectionMode;
  selectedOwnersCount.textContent = `${selectedOwnerIds.size} selected`;
  deleteSelectedOwnersButton.disabled = !selectedOwnerIds.size || isBulkDeleting;
  cancelOwnerSelectionButton.disabled = isBulkDeleting;

  const selectable = visibleOwners.filter((owner) => owner.id !== currentUserId);
  const selectedVisible = selectable.filter((owner) => selectedOwnerIds.has(owner.id)).length;
  selectAllOwners.checked = selectable.length > 0 && selectedVisible === selectable.length;
  selectAllOwners.indeterminate = selectedVisible > 0 && selectedVisible < selectable.length;
}

async function deleteSelectedOwners() {
  if (!["admin", "staff"].includes(currentRole) || !selectionMode || isBulkDeleting) return;
  const selected = allOwners.filter(
    (owner) => selectedOwnerIds.has(owner.id) && owner.id !== currentUserId
  );
  if (!selected.length) return;

  const confirmed = await window.SkinPawsibleDialogs.confirm(
    `Are you sure you want to delete ${selected.length} selected pet-owner profile(s)?\n\nThis removes their profiles from the clinic system. Their sign-in accounts and pet records will remain. This action cannot be undone.`,
    { title: "Delete pet-owner profiles?", confirmText: "Delete", tone: "danger" }
  );
  if (!confirmed) return;

  isBulkDeleting = true;
  updateOwnerAdminControls();
  let deletedCount = 0;
  try {
    for (let start = 0; start < selected.length; start += 450) {
      const batch = writeBatch(db);
      selected.slice(start, start + 450).forEach((owner) => {
        batch.delete(doc(db, "users", owner.id));
      });
      await batch.commit();
      deletedCount += Math.min(450, selected.length - start);
    }
    selectedOwnerIds.clear();
    selectionMode = false;
    window.alert(`Successfully deleted ${deletedCount} pet-owner profile(s).`);
  } catch (error) {
    console.error("Bulk pet-owner deletion failed:", error);
    window.alert(
      error.code === "permission-denied"
        ? "Permission denied. Check your Firestore security rules."
        : `Could not complete deletion. ${deletedCount} profile(s) were deleted before the error. Refresh the list to check which remain.`
    );
  } finally {
    isBulkDeleting = false;
    renderPetOwners();
  }
}


// ==========================================================
// ERROR MESSAGE
// ==========================================================

function showError(message) {
  if (!table) return;

  table.replaceChildren(messageRow(message, "po-error"));
}


// ==========================================================
// SEARCH
// ==========================================================

searchInput?.addEventListener("input", () => {
  showAllOwners = false;
  renderPetOwners();
});

showMoreButton?.addEventListener("click", () => {
  showAllOwners = !showAllOwners;
  renderPetOwners();
});

ownerDateFilterToggle?.addEventListener("click", () => {
  const isExpanded =
    ownerDateFilterToggle.getAttribute("aria-expanded") === "true";
  ownerDateFilterToggle.setAttribute("aria-expanded", String(!isExpanded));
  ownerDateFilterPanel.hidden = isExpanded;
});

document.addEventListener("click", (event) => {
  if (
    ownerDateFilterPanel &&
    ownerDateFilterToggle &&
    !ownerDateFilterPanel.hidden &&
    !ownerDateFilterPanel.contains(event.target) &&
    !ownerDateFilterToggle.contains(event.target)
  ) {
    closeOwnerDateFilter();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && ownerDateFilterPanel && !ownerDateFilterPanel.hidden) {
    closeOwnerDateFilter();
    ownerDateFilterToggle?.focus();
  }
});

ownerDateFromInput?.addEventListener("change", () => {
  dateFrom = ownerDateFromInput.value;
  showAllOwners = false;
  ownerDateFilterToggle?.classList.toggle("has-date-filter", Boolean(dateFrom || dateTo));
  renderPetOwners();
});

ownerDateToInput?.addEventListener("change", () => {
  dateTo = ownerDateToInput.value;
  showAllOwners = false;
  ownerDateFilterToggle?.classList.toggle("has-date-filter", Boolean(dateFrom || dateTo));
  renderPetOwners();
});

ownerDateResetButton?.addEventListener("click", () => {
  dateFrom = "";
  dateTo = "";
  showAllOwners = false;
  if (ownerDateFromInput) ownerDateFromInput.value = "";
  if (ownerDateToInput) ownerDateToInput.value = "";
  ownerDateFilterToggle?.classList.remove("has-date-filter");
  renderPetOwners();
});


// ==========================================================
// STATUS FILTERS
// ==========================================================

chips.forEach((chip) => {
  chip.addEventListener("click", () => {
    chips.forEach((c) => c.classList.remove("active"));

    chip.classList.add("active");

    activeFilter = chip.dataset.filter || "all";
    showAllOwners = false;

    renderPetOwners();
  });
});


// ==========================================================
// CLEAN UP LISTENERS
// ==========================================================

window.addEventListener("beforeunload", () => {
  unsubscribeOwners?.();
  unsubscribePets?.();
});
