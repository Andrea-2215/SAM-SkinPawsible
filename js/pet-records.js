import { auth, db } from "./firebase-config.js";
import { redirectSuperadminFromSensitivePage } from "./auth-state.js";
import { getUserProfileSnapshot } from "./user-profile.js";

import {
  onAuthStateChanged,
  signOut
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";

import {
  addDoc,
  collection,
  collectionGroup,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

// ==========================================================
// ELEMENTS AND STATE
// ==========================================================

const table = document.getElementById("petRecordsTable");
const footerEl = document.getElementById("petFooter");
const showMoreButton = document.getElementById("petRecordsShowMore");
const searchInput = document.getElementById("petSearch");
const chips = document.querySelectorAll("[data-filter]");
const petDateFilterToggle = document.getElementById("petDateFilterToggle");
const petDateFilterPanel = document.getElementById("petDateFilterPanel");
const petDateFromInput = document.getElementById("petDateFrom");
const petDateToInput = document.getElementById("petDateTo");
const petDateResetButton = document.getElementById("petDateReset");
const petSortNewestButton = document.getElementById("petSortNewest");
const petSortOldestButton = document.getElementById("petSortOldest");
const downloadPetReportBtn = document.getElementById("downloadPetReportBtn");
const modalEl = document.getElementById("petModal");
const modalTitle = document.getElementById("petModalTitle");
const modalBody = document.getElementById("petModalBody");
const addPetBtn = document.getElementById("addPetBtn");
const CLOUDINARY_CLOUD_NAME = "vgzc5f3c";
const CLOUDINARY_UPLOAD_PRESET = "petrecords";

let unsubscribePets = null;
let unsubscribeUsers = null;

let allPets = [];
let allProfiles = new Map();
let activeFilter = "all";
let showAllPetRecords = false;
const PET_RECORDS_PAGE_SIZE = 10;
let searchText = "";
let dateFrom = "";
let dateTo = "";
let dateSortDirection = "desc";

let petModal = null;
let addPetModal = null;
let editingPet = null;

let currentUser = null;
let currentRole = "";
let initialized = false;
let pendingPetSave = null;

const selectedPetPaths = new Set();
let selectionMode = false;
let isBulkDeleting = false;
let petEditModeButton = null;
let petSelectionControls = null;
let selectAllPetsLabel = null;
let selectAllPetsCheckbox = null;
let selectedPetsCount = null;
let deleteSelectedPetsButton = null;
let cancelPetSelectionButton = null;

// ==========================================================
// AUTHENTICATION AND ROLE CHECK
// ==========================================================

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    window.location.href = "login.html";
    return;
  }

  try {
    const profileSnap = await getUserProfileSnapshot(user);
    const profile = profileSnap.exists() ? profileSnap.data() : null;
    const role = String(profile?.role || "")
      .toLowerCase()
      .trim();

    const status = String(profile?.status || "active")
      .toLowerCase()
      .trim();

    if (redirectSuperadminFromSensitivePage(user)) return;

    if (
      !["admin", "staff", "vet", "veterinarian", "superadmin"].includes(role) ||
      status !== "active"
    ) {
      await signOut(auth);
      window.location.href = "login.html";
      return;
    }

    currentUser = user;
    currentRole = role;
    window.SkinPawsibleNetworkStatus?.clearIssue("session");

    const displayName =
      profile?.fullName ||
      profile?.displayName ||
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
      addPetBtn.hidden = false;
      createPetAdminControls();
      initializeAddPet();
    }

    loadPetRecords();

  } catch (error) {
    console.error("Could not verify web access:", error);
    showLoadError(
      "Could not verify access to Pet Records. Retry when your connection is available.",
      error
    );
  }
});

// ==========================================================
// LOAD PETS AND USER PROFILES IN REAL TIME
// ==========================================================

function loadPetRecords() {
  if (!table || !currentUser) return;

  if (unsubscribeUsers) unsubscribeUsers();
  if (unsubscribePets) unsubscribePets();

  // Listen for changes to user profiles.
  unsubscribeUsers = onSnapshot(
    query(
      collection(db, "users"),
      where("role", "in", [
        "owner",
        "user",
        "pet owner",
        "petOwner",
        "petowner",
        "pet_owner",
        "pet-owner"
      ])
    ),
    (snapshot) => {
      window.SkinPawsibleNetworkStatus?.clearIssue("profiles");
      allProfiles = new Map();

      snapshot.forEach((profileSnap) => {
        allProfiles.set(
          profileSnap.id,
          profileSnap.data()
        );
      });

      render();
      populatePetOwners();
    },
    (error) => {
      reportLoadError(
        "profiles",
        "Could not load pet owner profiles. Retry when your connection is available.",
        error
      );
    }
  );

  // Listen for additions, updates, and deletions of pet records.
  unsubscribePets = onSnapshot(
    collectionGroup(db, "pets"),
    (snapshot) => {
      window.SkinPawsibleNetworkStatus?.clearIssue("pets");
      allPets = snapshot.docs.map((petSnap) => ({
        id: petSnap.id,

        // Keep the actual path for accurate document operations.
        path: petSnap.ref.path,

        ownerId:
          petSnap.ref.parent.parent?.id ||
          petSnap.data().userId ||
          petSnap.data().ownerId ||
          "",

        data: petSnap.data()
      }));

      const currentPaths = new Set(allPets.map((pet) => pet.path));
      selectedPetPaths.forEach((path) => {
        if (!currentPaths.has(path)) selectedPetPaths.delete(path);
      });

      render();
    },
    (error) => {
      reportLoadError(
        "pets",
        "Could not load pet records. Retry when your connection is available.",
        error
      );
    }
  );
}

function reportLoadError(source, message, error) {
  console.error(message, error);
  window.SkinPawsibleNetworkStatus?.setIssue(
    source,
    message,
    loadPetRecords
  );
}

// ==========================================================
// HELPERS
// ==========================================================

function el(tag, className = "", text) {
  const node = document.createElement(tag);

  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;

  return node;
}

function capitalize(value) {
  const text = String(value || "").trim();

  return text
    ? text.charAt(0).toUpperCase() + text.slice(1)
    : "";
}

function toDate(value) {
  if (!value) return null;

  let date;

  if (typeof value.toDate === "function") {
    date = value.toDate();
  } else {
    date = new Date(value);
  }

  return Number.isNaN(date.getTime()) ? null : date;
}

function formatAge(value) {
  if (value === undefined || value === null || value === "") {
    return "-";
  }

  const text = String(value).trim();

  if (/^\d+(\.\d+)?$/.test(text)) {
    const number = Number(text);

    return number + (number === 1 ? " yr" : " yrs");
  }

  return text
    .replace(/\byears\b/gi, "yrs")
    .replace(/\byear\b/gi, "yr")
    .replace(/\bmonths\b/gi, "mos")
    .replace(/\bmonth\b/gi, "mo");
}

function normalizeSex(value) {
  const sex = String(value || "")
    .trim()
    .toLowerCase();

  if (sex === "male" || sex === "m") return "male";
  if (sex === "female" || sex === "f") return "female";

  return "";
}

function initials(name) {
  const text = String(name || "?").trim();

  if (text.includes("@")) {
    return text.charAt(0).toUpperCase();
  }

  return text
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join("") || "?";
}

function avatarClass(name) {
  let sum = 0;

  for (const character of String(name || "")) {
    sum += character.charCodeAt(0);
  }

  return "pr-av-" + (sum % 5);
}

function safeImage(value) {
  const url = String(value || "").trim();

  return /^(data:image\/|https?:\/\/)/i.test(url)
    ? url
    : "";
}

function safeLink(value) {
  const url = String(value || "").trim();

  return /^https?:\/\//i.test(url) ? url : "";
}

function isWebStaffRole(role) {
  return ["admin", "staff", "vet", "veterinarian", "superadmin"].includes(
    String(role || "").toLowerCase().trim()
  );
}

function isActiveProfile(profile) {
  return String(profile?.status || "active")
    .toLowerCase()
    .trim() === "active";
}

// ==========================================================
// FORMAT PET RECORD
// ==========================================================

function toRecord(pet) {
  const data = pet.data || {};
  const ownerProfile = allProfiles.get(pet.ownerId) || {};

  const ownerName =
    data.ownerName ||
    data.petOwnerName ||
    data.userName ||
    ownerProfile.fullName ||
    ownerProfile.displayName ||
    ownerProfile.name ||
    ownerProfile.email ||
    pet.ownerId ||
    "Unknown owner";

  const created = toDate(
    data.createdAt ||
    data.timestamp ||
    data.dateCreated
  );

  return {
    id: pet.id,
    path: pet.path,
    ownerId: pet.ownerId,

    name: capitalize(
      data.petName ||
      data.pet_name ||
      data.name ||
      "Unnamed pet"
    ),

    breed: capitalize(
      data.breed ||
      data.petBreed ||
      data.pet_breed ||
      ""
    ),

    age: formatAge(
      data.age ??
      data.petAge ??
      data.pet_age
    ),

    sex: normalizeSex(
      data.sex ||
      data.petSex ||
      data.pet_sex ||
      data.gender
    ),

    owner: String(ownerName),

    photo: safeImage(
      data.imageUrl ||
      data.photoUrl ||
      data.image
    ),

    created,

    createdText: created
      ? created.toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric"
        })
      : "-",

    data
  };
}

// ==========================================================
// RENDER TABLE
// ==========================================================

function render() {
  if (!table) return;

  const records = allPets.map(toRecord);
  const filteredRecords = getVisiblePetRecords();
  const isShowingAll = showAllPetRecords || selectionMode;
  const shown = isShowingAll
    ? filteredRecords
    : filteredRecords.slice(0, PET_RECORDS_PAGE_SIZE);

  table.replaceChildren();

  if (filteredRecords.length === 0 && records.length === 0) {
    table.appendChild(messageRow("No pet records yet."));
  } else if (filteredRecords.length === 0) {
    table.appendChild(
      messageRow("No pets match your search.")
    );
  } else {
    shown.forEach((record) => {
      table.appendChild(buildRow(record));
    });
  }

  if (footerEl) {
    footerEl.textContent =
      "Showing " +
      shown.length +
      " of " +
      filteredRecords.length +
      (filteredRecords.length === 1 ? " pet" : " pets");
  }

  if (showMoreButton) {
    showMoreButton.hidden =
      filteredRecords.length <= PET_RECORDS_PAGE_SIZE || selectionMode;
    showMoreButton.textContent = isShowingAll
      ? "Show fewer pet records"
      : `Show remaining pet records (${filteredRecords.length - shown.length})`;
  }

  updatePetAdminControls(filteredRecords);
  if (downloadPetReportBtn) {
    downloadPetReportBtn.disabled = filteredRecords.length === 0;
  }
  petDateFilterToggle?.classList.toggle(
    "has-date-filter",
    Boolean(dateFrom || dateTo)
  );
}

function messageRow(message, isError = false) {
  const row = document.createElement("tr");

  const cell = el(
    "td",
    "pr-message" + (isError ? " pr-error" : ""),
    message
  );

  cell.colSpan = 6;
  row.appendChild(cell);

  return row;
}

function petIcon(record) {
  const wrapper = el("div", "pr-pet-icon");

  function showFallback() {
    wrapper.replaceChildren(
      el("i", "bi bi-heart-fill")
    );
  }

  if (record.photo) {
    const image = document.createElement("img");

    image.alt = record.name;
    image.loading = "lazy";
    image.decoding = "async";
    image.src = record.photo;

    image.addEventListener(
      "error",
      showFallback,
      { once: true }
    );

    wrapper.appendChild(image);
  } else {
    showFallback();
  }

  return wrapper;
}

// ==========================================================
// TABLE ROW: SEE MORE AND ADMIN-ONLY DELETE
// ==========================================================

function buildRow(record) {
  const row = document.createElement("tr");

  const petCell = document.createElement("td");
  const pet = el("div", "pr-pet");
  const petText = el("div", "pr-pet-text");

  if (["admin", "staff"].includes(currentRole) && selectionMode) {
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "form-check-input m-0";
    checkbox.checked = selectedPetPaths.has(record.path);
    checkbox.disabled = isBulkDeleting;
    checkbox.setAttribute("aria-label", `Select ${record.name} for deletion`);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) selectedPetPaths.add(record.path);
      else selectedPetPaths.delete(record.path);
      updatePetAdminControls(getVisiblePetRecords());
    });
    pet.appendChild(checkbox);
  }

  petText.appendChild(
    el("span", "pr-pet-name", record.name)
  );

  pet.append(petIcon(record), petText);
  petCell.appendChild(pet);

  const breedCell = el("td", "", record.breed || "-");
  const sexCell = document.createElement("td");

  if (record.sex) {
    sexCell.appendChild(
      el(
        "span",
        "pr-badge pr-badge-" + record.sex,
        capitalize(record.sex)
      )
    );
  } else {
    sexCell.textContent = "-";
  }

  const ownerCell = document.createElement("td");
  const owner = el("div", "pr-owner");

  owner.append(
    el(
      "span",
      "pr-avatar " + avatarClass(record.owner),
      initials(record.owner)
    ),
    el("span", "", record.owner)
  );

  ownerCell.appendChild(owner);

  const createdCell = el(
    "td",
    "",
    record.createdText
  );

  const actionCell = el("td", "text-nowrap");

  const viewButton = el(
    "button",
    "pr-view",
    "See more"
  );

  viewButton.type = "button";
  viewButton.appendChild(
    el("i", "bi bi-chevron-right")
  );

  viewButton.addEventListener("click", () => {
    openDetails(record);
  });

  actionCell.appendChild(viewButton);

  row.append(
    petCell,
    breedCell,
    sexCell,
    ownerCell,
    createdCell,
    actionCell
  );

  return row;
}

function createPetAdminControls() {
  const container = document.querySelector(".pr-admin-controls");
  const header = container?.closest(".pr-head");
  if (!container || !header || petEditModeButton) return;

  petEditModeButton = makePetAdminButton(
    "bi-pencil",
    "Select pet records to delete",
    "Enter pet-record selection mode",
    "Edit"
  );
  petEditModeButton.addEventListener("click", () => {
    if (isBulkDeleting) return;
    selectionMode = !selectionMode;
    selectedPetPaths.clear();
    render();
  });

  selectAllPetsLabel = document.createElement("label");
  selectAllPetsLabel.className = "d-flex align-items-center gap-2 small";
  selectAllPetsCheckbox = document.createElement("input");
  selectAllPetsCheckbox.type = "checkbox";
  selectAllPetsCheckbox.className = "form-check-input m-0";
  selectAllPetsCheckbox.setAttribute("aria-label", "Select all visible pet records");
  selectAllPetsLabel.append(
    selectAllPetsCheckbox,
    document.createTextNode("Select all")
  );
  selectAllPetsCheckbox.addEventListener("change", () => {
    const visibleRecords = getVisiblePetRecords();
    visibleRecords.forEach((record) => {
      if (selectAllPetsCheckbox.checked) selectedPetPaths.add(record.path);
      else selectedPetPaths.delete(record.path);
    });
    render();
  });

  selectedPetsCount = document.createElement("span");
  selectedPetsCount.className = "small text-muted";

  deleteSelectedPetsButton = makePetAdminButton(
    "bi-trash",
    "Delete selected pet records",
    "Delete selected pet records",
    "Delete Selected"
  );
  deleteSelectedPetsButton.addEventListener("click", deleteSelectedPets);

  cancelPetSelectionButton = document.createElement("button");
  cancelPetSelectionButton.type = "button";
  cancelPetSelectionButton.className = "btn btn-sm btn-outline-secondary";
  cancelPetSelectionButton.textContent = "Cancel";
  cancelPetSelectionButton.addEventListener("click", () => {
    if (isBulkDeleting) return;
    selectionMode = false;
    selectedPetPaths.clear();
    render();
  });

  container.className = "pr-admin-controls d-flex flex-wrap align-items-center gap-2 ms-auto";
  container.append(petEditModeButton);

  petSelectionControls = document.createElement("div");
  petSelectionControls.className = "pr-selection-controls";
  petSelectionControls.setAttribute("role", "group");
  petSelectionControls.setAttribute("aria-label", "Pet record selection actions");
  petSelectionControls.hidden = true;
  petSelectionControls.append(
    selectAllPetsLabel,
    selectedPetsCount,
    deleteSelectedPetsButton,
    cancelPetSelectionButton
  );
  header.append(petSelectionControls);
}

function makePetAdminButton(icon, title, ariaLabel, text = "") {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "btn btn-sm btn-outline-danger";
  button.title = title;
  button.setAttribute("aria-label", ariaLabel);
  button.innerHTML = `<i class="bi ${icon}" aria-hidden="true"></i>${text ? ` ${text}` : ""}`;
  return button;
}

function getVisiblePetRecords() {
  const query = searchText.trim().toLowerCase();
  return allPets
    .map(toRecord)
    .sort((a, b) => {
      const aTime = a.created?.getTime();
      const bTime = b.created?.getTime();
      if (aTime === undefined) return bTime === undefined ? 0 : 1;
      if (bTime === undefined) return -1;
      return dateSortDirection === "asc" ? aTime - bTime : bTime - aTime;
    })
    .filter((record) => {
      const matchesFilter = activeFilter === "all" || record.sex === activeFilter;
      const matchesSearch = !query ||
        [record.name, record.breed, record.owner].join(" ").toLowerCase().includes(query);
      const recordDate = record.created
        ? localDateInputValue(record.created)
        : "";
      const matchesDate =
        (!dateFrom && !dateTo) ||
        (
          Boolean(recordDate) &&
          (!dateFrom || recordDate >= dateFrom) &&
          (!dateTo || recordDate <= dateTo)
        );
      return matchesFilter && matchesSearch && matchesDate;
    });
}

function localDateInputValue(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function closePetDateFilter() {
  if (!petDateFilterToggle || !petDateFilterPanel) return;
  petDateFilterPanel.hidden = true;
  petDateFilterToggle.setAttribute("aria-expanded", "false");
}

petDateFilterToggle?.addEventListener("click", () => {
  const isExpanded =
    petDateFilterToggle.getAttribute("aria-expanded") === "true";
  petDateFilterToggle.setAttribute("aria-expanded", String(!isExpanded));
  petDateFilterPanel.hidden = isExpanded;
});

document.addEventListener("click", (event) => {
  if (
    petDateFilterPanel &&
    petDateFilterToggle &&
    !petDateFilterPanel.hidden &&
    !petDateFilterPanel.contains(event.target) &&
    !petDateFilterToggle.contains(event.target)
  ) {
    closePetDateFilter();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && petDateFilterPanel && !petDateFilterPanel.hidden) {
    closePetDateFilter();
    petDateFilterToggle?.focus();
  }
});

petDateFromInput?.addEventListener("change", () => {
  dateFrom = petDateFromInput.value;
  showAllPetRecords = false;
  render();
});

petDateToInput?.addEventListener("change", () => {
  dateTo = petDateToInput.value;
  showAllPetRecords = false;
  render();
});

petDateResetButton?.addEventListener("click", () => {
  dateFrom = "";
  dateTo = "";
  showAllPetRecords = false;
  if (petDateFromInput) petDateFromInput.value = "";
  if (petDateToInput) petDateToInput.value = "";
  render();
});

function setPetDateSort(direction) {
  dateSortDirection = direction;
  showAllPetRecords = false;
  const newestFirst = direction === "desc";
  petSortNewestButton?.classList.toggle("active", newestFirst);
  petSortNewestButton?.setAttribute("aria-pressed", String(newestFirst));
  petSortOldestButton?.classList.toggle("active", !newestFirst);
  petSortOldestButton?.setAttribute("aria-pressed", String(!newestFirst));
  render();
}

petSortNewestButton?.addEventListener("click", () => {
  setPetDateSort("desc");
});

petSortOldestButton?.addEventListener("click", () => {
  setPetDateSort("asc");
});

function downloadPetReport() {
  const records = getVisiblePetRecords();
  if (!records.length) {
    window.alert("There are no visible pet records to export.");
    return;
  }

  const xlsx = window.XLSX;
  if (!xlsx) {
    console.error("Excel report library did not load.");
    window.alert("Excel export is unavailable. Refresh the page and try again.");
    return;
  }

  const reportRows = records.map((record) => {
    const ownerProfile = allProfiles.get(record.ownerId) || {};

    return [
      record.name,
      record.breed || "-",
      record.age,
      capitalize(record.sex) || "-",
      record.owner,
      ownerProfile.email || "",
      ownerProfile.phoneNumber || ownerProfile.phone || "",
      record.createdText
    ];
  });

  const columns = [
    "Pet Name",
    "Breed",
    "Age",
    "Sex",
    "Owner",
    "Owner Email",
    "Owner Phone",
    "Date Added"
  ];
  const generatedAt = new Date();
  const genderLabel = {
    all: "All",
    male: "Male",
    female: "Female"
  }[activeFilter] || "All";
  const searchLabel = searchText.trim() || "None";
  const dateRangeLabel = dateFrom || dateTo
    ? `${dateFrom || "Any"} to ${dateTo || "Any"}`
    : "Any date";
  const worksheet = xlsx.utils.aoa_to_sheet([
    ["SKINPAWSIBLE - PET RECORDS REPORT"],
    ["Pet and owner information for the records currently shown in Pet Records."],
    [`Generated: ${generatedAt.toLocaleString()}`],
    [`Records included: ${records.length}    Sex filter: ${genderLabel}    Date range: ${dateRangeLabel}    Search: ${searchLabel}`],
    columns,
    ...reportRows
  ]);
  const lastDataRow = reportRows.length + 5;

  worksheet["!merges"] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: columns.length - 1 } },
    { s: { r: 1, c: 0 }, e: { r: 1, c: columns.length - 1 } },
    { s: { r: 2, c: 0 }, e: { r: 2, c: columns.length - 1 } },
    { s: { r: 3, c: 0 }, e: { r: 3, c: columns.length - 1 } }
  ];
  worksheet["!cols"] = [
    { wch: 24 },
    { wch: 22 },
    { wch: 12 },
    { wch: 12 },
    { wch: 28 },
    { wch: 32 },
    { wch: 18 },
    { wch: 16 }
  ];
  worksheet["!rows"] = [
    { hpt: 26 },
    { hpt: 30 },
    { hpt: 22 },
    { hpt: 22 },
    { hpt: 24 }
  ];
  worksheet["!autofilter"] = {
    ref: `A5:H${lastDataRow}`
  };
  worksheet["!freeze"] = {
    xSplit: 0,
    ySplit: 5,
    topLeftCell: "A6",
    activePane: "bottomLeft",
    state: "frozen"
  };
  worksheet["!sheetViews"] = [{
    showGridLines: false,
    zoomScale: 90
  }];
  worksheet["!pageSetup"] = {
    orientation: "landscape",
    fitToWidth: 1,
    fitToHeight: 0
  };
  worksheet["!pageMargins"] = {
    left: 0.3,
    right: 0.3,
    top: 0.5,
    bottom: 0.5,
    header: 0.2,
    footer: 0.2
  };

  const setRowStyle = (row, style, startColumn = 0, endColumn = columns.length - 1) => {
    for (let column = startColumn; column <= endColumn; column++) {
      const address = xlsx.utils.encode_cell({ r: row, c: column });
      if (!worksheet[address]) {
        worksheet[address] = { t: "s", v: "" };
      }
      worksheet[address].s = style;
    }
  };

  setRowStyle(0, {
    font: { name: "Aptos Display", sz: 18, bold: true, color: { rgb: "FFFFFF" } },
    fill: { patternType: "solid", fgColor: { rgb: "5B2C83" } },
    alignment: { vertical: "center", horizontal: "left", indent: 1 },
    border: { bottom: { style: "medium", color: { rgb: "452064" } } }
  });
  setRowStyle(1, {
    font: { name: "Aptos", sz: 10, italic: true, color: { rgb: "4B3B59" } },
    fill: { patternType: "solid", fgColor: { rgb: "F3EDF8" } },
    alignment: { vertical: "center", horizontal: "left", indent: 1, wrapText: true }
  });
  setRowStyle(2, {
    font: { name: "Aptos", sz: 10, color: { rgb: "4B3B59" } },
    fill: { patternType: "solid", fgColor: { rgb: "F3EDF8" } },
    alignment: { vertical: "center", horizontal: "left", indent: 1 }
  });
  setRowStyle(3, {
    font: { name: "Aptos", sz: 10, bold: true, color: { rgb: "5B2C83" } },
    fill: { patternType: "solid", fgColor: { rgb: "E9DDF2" } },
    alignment: { vertical: "center", horizontal: "left", indent: 1, wrapText: true },
    border: { bottom: { style: "thin", color: { rgb: "D7C5E5" } } }
  });
  setRowStyle(4, {
    font: { name: "Aptos", sz: 10, bold: true, color: { rgb: "FFFFFF" } },
    fill: { patternType: "solid", fgColor: { rgb: "6B3FA0" } },
    alignment: { vertical: "center", horizontal: "left", wrapText: true },
    border: {
      top: { style: "thin", color: { rgb: "5B2C83" } },
      bottom: { style: "medium", color: { rgb: "452064" } }
    }
  });
  for (let row = 5; row < lastDataRow; row++) {
    setRowStyle(row, {
      font: { name: "Aptos", sz: 10, color: { rgb: "30283A" } },
      fill: {
        patternType: "solid",
        fgColor: { rgb: row % 2 === 1 ? "F8F5FB" : "FFFFFF" }
      },
      alignment: { vertical: "center", wrapText: true },
      border: { bottom: { style: "hair", color: { rgb: "E7E0ED" } } }
    });
    [2, 3, 7].forEach((column) => {
      const cell = worksheet[xlsx.utils.encode_cell({ r: row, c: column })];
      cell.s.alignment = { vertical: "center", horizontal: "center", wrapText: true };
    });
  }

  const workbook = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(workbook, worksheet, "Pet Records");
  workbook.Props = {
    Title: "SkinPawsible Pet Records Report",
    Subject: "Pet records and owner contact details",
    Author: "SkinPawsible",
    CreatedDate: generatedAt
  };

  const date = new Date();
  const filenameDate = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  ].join("-");

  xlsx.writeFile(workbook, `SkinPawsible-Pet-Records-${filenameDate}.xlsx`);
}

downloadPetReportBtn?.addEventListener("click", downloadPetReport);

async function loadPetPhotoForExcel(photoUrl) {
  if (!photoUrl) return null;

  const image = new Image();
  image.crossOrigin = "anonymous";
  image.src = photoUrl;

  await new Promise((resolve, reject) => {
    image.onload = resolve;
    image.onerror = () => reject(new Error("Pet photo could not be loaded."));
  });

  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;

  const context = canvas.getContext("2d");
  if (!context) throw new Error("Could not prepare the pet photo for Excel.");

  context.drawImage(image, 0, 0);
  return canvas.toDataURL("image/png");
}

function addPetReportSection(sheet, title, firstRow, fields) {
  sheet.mergeCells(`A${firstRow}:B${firstRow}`);
  const heading = sheet.getCell(`A${firstRow}`);
  heading.value = title;
  heading.font = { name: "Aptos", size: 11, bold: true, color: { argb: "FFFFFFFF" } };
  heading.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF6B3FA0" } };
  heading.alignment = { vertical: "middle" };
  sheet.getRow(firstRow).height = 21;

  fields.forEach(([label, value], index) => {
    const row = firstRow + index + 1;
    sheet.getCell(`A${row}`).value = label;
    sheet.getCell(`A${row}`).font = {
      name: "Aptos",
      size: 10,
      bold: true,
      color: { argb: "FF5B2C83" }
    };
    sheet.getCell(`A${row}`).fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FFF3EDF8" }
    };
    sheet.getCell(`B${row}`).value = value || "-";
    sheet.getCell(`B${row}`).font = {
      name: "Aptos",
      size: 10,
      color: { argb: "FF30283A" }
    };
    sheet.getCell(`B${row}`).alignment = {
      vertical: "middle",
      wrapText: true
    };
    sheet.getCell(`A${row}`).border = {
      bottom: { style: "thin", color: { argb: "FFE7E0ED" } }
    };
    sheet.getCell(`B${row}`).border = {
      bottom: { style: "thin", color: { argb: "FFE7E0ED" } }
    };
    sheet.getRow(row).height = 22;
  });
}

async function downloadPetProfileReport(record, button) {
  if (!window.ExcelJS) {
    console.error("ExcelJS did not load for the individual pet report.");
    window.alert("The individual Excel report is unavailable. Refresh the page and try again.");
    return;
  }

  button.disabled = true;
  button.textContent = " Preparing...";

  try {
    const data = record.data || {};
    const ownerProfile = allProfiles.get(record.ownerId) || {};
    const workbook = new window.ExcelJS.Workbook();
    workbook.creator = "SkinPawsible Clinic";
    workbook.subject = "Individual pet clinic record";
    workbook.title = `${record.name} - Pet Clinic Record`;
    workbook.created = new Date();

    const sheet = workbook.addWorksheet("Clinic Record", {
      pageSetup: {
        paperSize: 9,
        orientation: "portrait",
        fitToPage: true,
        fitToWidth: 1,
        fitToHeight: 1,
        margins: {
          left: 0.3,
          right: 0.3,
          top: 0.5,
          bottom: 0.5,
          header: 0.2,
          footer: 0.2
        }
      },
      views: [{ showGridLines: false, state: "frozen", ySplit: 3 }]
    });

    sheet.columns = [
      { key: "label", width: 23 },
      { key: "value", width: 34 },
      { key: "spacer", width: 3 },
      { key: "photo", width: 19 },
      { key: "photo2", width: 19 },
      { key: "photo3", width: 19 },
      { key: "photo4", width: 19 }
    ];

    sheet.mergeCells("A1:G1");
    const title = sheet.getCell("A1");
    title.value = "SKINPAWSIBLE VETERINARY CLINIC";
    title.font = { name: "Aptos Display", size: 19, bold: true, color: { argb: "FFFFFFFF" } };
    title.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF5B2C83" } };
    title.alignment = { vertical: "middle", horizontal: "center" };
    sheet.getRow(1).height = 38;

    sheet.mergeCells("A2:G2");
    const subtitle = sheet.getCell("A2");
    subtitle.value = "INDIVIDUAL PET RECORD";
    subtitle.font = { name: "Aptos", size: 12, bold: true, color: { argb: "FF5B2C83" } };
    subtitle.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF3EDF8" } };
    subtitle.alignment = { vertical: "middle", horizontal: "center" };
    sheet.getRow(2).height = 25;

    sheet.mergeCells("A3:G3");
    const generated = sheet.getCell("A3");
    generated.value = `Prepared ${new Date().toLocaleString()}  |  Record ID: ${record.id}`;
    generated.font = { name: "Aptos", size: 9, color: { argb: "FF6F6A7D" } };
    generated.alignment = { vertical: "middle", horizontal: "center" };
    sheet.getRow(3).height = 22;

    const weightValue = data.weight ?? data.petWeight ?? data.pet_weight;
    const weightUnit = data.weightUnit || data.weight_unit || "kg";
    const weight = weightValue === undefined || weightValue === null || weightValue === ""
      ? "-"
      : `${weightValue}${String(weightValue).toLowerCase().includes(String(weightUnit).toLowerCase()) ? "" : ` ${weightUnit}`}`;
    const allergies = data.allergies ?? data.allergy ?? data.petAllergies ?? data.pet_allergies;
    const ownerNotes = data.ownerNotes ?? data.owner_notes ?? data.notes ?? data.specialNotes;

    addPetReportSection(sheet, "PET DETAILS", 5, [
      ["Pet name", record.name],
      ["Breed", record.breed || "-"],
      ["Age", record.age],
      ["Sex", capitalize(record.sex) || "-"],
      ["Weight", weight],
      ["Date added", record.createdText]
    ]);
    addPetReportSection(sheet, "OWNER DETAILS", 13, [
      ["Owner name", record.owner],
      ["Email", ownerProfile.email || ""],
      ["Phone", ownerProfile.phoneNumber || ownerProfile.phone || ""],
      ["Owner ID", record.ownerId]
    ]);
    addPetReportSection(sheet, "CARE NOTES", 19, [
      ["Allergies", displayValue(allergies, "None recorded")],
      ["Owner notes", displayValue(ownerNotes, "None recorded")]
    ]);

    sheet.mergeCells("D5:G5");
    const photoHeading = sheet.getCell("D5");
    photoHeading.value = "PET PHOTO";
    photoHeading.font = { name: "Aptos", size: 11, bold: true, color: { argb: "FFFFFFFF" } };
    photoHeading.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF6B3FA0" } };
    photoHeading.alignment = { vertical: "middle", horizontal: "center" };
    sheet.getRow(5).height = 22;

    for (let row = 6; row <= 13; row++) {
      sheet.getRow(row).height = 22;
      for (let column = 4; column <= 7; column++) {
        const cell = sheet.getRow(row).getCell(column);
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF8F5FB" } };
        cell.border = {
          left: { style: "thin", color: { argb: "FFE7E0ED" } },
          right: { style: "thin", color: { argb: "FFE7E0ED" } },
          bottom: { style: "thin", color: { argb: "FFE7E0ED" } }
        };
      }
    }

    let photoEmbeddingFailed = false;
    try {
      const photoData = await loadPetPhotoForExcel(record.photo);
      if (photoData) {
        const imageId = workbook.addImage({
          base64: photoData,
          extension: "png"
        });
        sheet.addImage(imageId, {
          tl: { col: 3.2, row: 5.2 },
          br: { col: 6.8, row: 12.8 },
          editAs: "oneCell"
        });
      } else {
        sheet.mergeCells("D7:G10");
        sheet.getCell("D7").value = "No pet photo available";
        sheet.getCell("D7").font = { name: "Aptos", size: 10, italic: true, color: { argb: "FF6F6A7D" } };
        sheet.getCell("D7").alignment = { vertical: "middle", horizontal: "center", wrapText: true };
      }
    } catch (error) {
      console.warn("Could not embed pet photo in Excel report:", error);
      photoEmbeddingFailed = true;
      sheet.mergeCells("D7:G10");
      sheet.getCell("D7").value = "Pet photo could not be embedded";
      sheet.getCell("D7").font = { name: "Aptos", size: 10, italic: true, color: { argb: "FF6F6A7D" } };
      sheet.getCell("D7").alignment = { vertical: "middle", horizontal: "center", wrapText: true };
    }

    sheet.mergeCells("A23:G23");
    const footer = sheet.getCell("A23");
    footer.value = "CONFIDENTIAL - For veterinary clinic use";
    footer.font = { name: "Aptos", size: 9, italic: true, color: { argb: "FF5B2C83" } };
    footer.alignment = { horizontal: "center", vertical: "middle" };
    footer.border = { top: { style: "thin", color: { argb: "FFD7C5E5" } } };
    sheet.getRow(23).height = 24;

    const buffer = await workbook.xlsx.writeBuffer();
    const file = new Blob([buffer], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    });
    const url = URL.createObjectURL(file);
    const link = document.createElement("a");
    link.href = url;
    const safePetName = record.name.replace(/[^a-z0-9_-]+/gi, "-");
    link.download = `SkinPawsible-${safePetName}-${record.id}-Clinic-Record.xlsx`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    if (photoEmbeddingFailed) {
      window.alert(
        `The clinic record for ${record.name} was downloaded, but its photo could not be embedded. Check that the image is publicly accessible and allows cross-origin access.`
      );
    }
  } catch (error) {
    console.error("Could not create the individual pet Excel report:", error);
    window.alert(`Could not create the Excel report for ${record.name}. Please try again.`);
  } finally {
    button.disabled = false;
    button.replaceChildren(
      el("i", "bi bi-file-earmark-spreadsheet", ""),
      document.createTextNode(" Excel")
    );
    button.title = `Download ${record.name}'s clinic record`;
  }
}

function updatePetAdminControls(visibleRecords = getVisiblePetRecords()) {
  if (!["admin", "staff"].includes(currentRole) || !selectAllPetsCheckbox) return;

  petEditModeButton.classList.toggle("d-none", selectionMode);
  petSelectionControls.hidden = !selectionMode;
  selectedPetsCount.textContent = `${selectedPetPaths.size} selected`;
  deleteSelectedPetsButton.disabled = selectedPetPaths.size === 0 || isBulkDeleting;
  cancelPetSelectionButton.disabled = isBulkDeleting;

  const selectedVisible = visibleRecords.filter((record) =>
    selectedPetPaths.has(record.path)
  ).length;
  selectAllPetsCheckbox.checked =
    visibleRecords.length > 0 && selectedVisible === visibleRecords.length;
  selectAllPetsCheckbox.indeterminate =
    selectedVisible > 0 && selectedVisible < visibleRecords.length;
}

async function deleteSelectedPets() {
  if (!["admin", "staff"].includes(currentRole) || !selectionMode || isBulkDeleting) return;

  const selected = allPets
    .map(toRecord)
    .filter((record) => selectedPetPaths.has(record.path));
  if (!selected.length) return;

  const confirmed = await window.SkinPawsibleDialogs.confirm(
    `Are you sure you want to delete ${selected.length} selected pet record(s)? This action cannot be undone.`,
    { title: "Delete pet records?", confirmText: "Delete", tone: "danger" }
  );
  if (!confirmed) return;

  isBulkDeleting = true;
  updatePetAdminControls();
  let deletedCount = 0;
  try {
    for (let start = 0; start < selected.length; start += 450) {
      const batch = writeBatch(db);
      selected.slice(start, start + 450).forEach((record) => {
        batch.delete(doc(db, record.path));
      });
      await batch.commit();
      deletedCount += Math.min(450, selected.length - start);
    }
    selectedPetPaths.clear();
    selectionMode = false;
    window.alert(`Successfully deleted ${deletedCount} pet record(s).`);
  } catch (error) {
    console.error("Bulk pet-record deletion failed:", error);
    window.alert(
      error.code === "permission-denied"
        ? "You don't have permission to delete these pet records. Contact an administrator if you need access."
        : `Could not complete deletion. ${deletedCount} record(s) were deleted before the error. Refresh the list to check which remain.`
    );
  } finally {
    isBulkDeleting = false;
    render();
  }
}

// ==========================================================
// PET PROFILE: SEE MORE
// ==========================================================


 // ==========================================================
 // PET PROFILE: SEE MORE
 // ==========================================================

function displayValue(value, fallback = "-") {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  if (Array.isArray(value)) {
    const result = value
      .map((item) => {
        if (item && typeof item === "object") {
          return item.name || item.title || item.fileName || "";
        }
        return String(item);
      })
      .filter(Boolean)
      .join(", ");

    return result || fallback;
  }

  if (typeof value === "object") {
    return value.name || value.title || value.fileName ||
      JSON.stringify(value);
  }

  return String(value);
}

function recordDate(item) {
  if (!item || typeof item !== "object") {
    return "";
  }

  const rawDate =
    item.date ||
    item.uploadedAt ||
    item.createdAt ||
    item.timestamp ||
    item.dateCreated ||
    item.dateUploaded ||
    null;

  if (!rawDate) return "";

  const date = toDate(rawDate);

  if (!date) {
    // Preserve a readable date string if it cannot be parsed.
    return typeof rawDate === "string" ? rawDate : "";
  }

  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric"
  });
}

function profileField(label, value) {
  const field = el("div", "pr-profile-field");

  field.append(
    el("span", "pr-profile-label", label),
    el("span", "pr-profile-value", value)
  );

  return field;
}

function buildRecordSection(title, badgeText, value, sectionType = "past") {
  const section = el(
    "section",
    `pr-record-section pr-record-section-${sectionType}`
  );

  const heading = el("div", "pr-section-heading");
  const headingText = el("div", "");

  headingText.append(
    el("h3", "", title),
    el("p", "", badgeText || "View only")
  );

  heading.appendChild(headingText);
  section.appendChild(heading);

  const list = el("div", "pr-medical-records");

  let items = [];

  if (Array.isArray(value)) {
    items = value;
  } else if (value && typeof value === "object") {
    items = [value];
  } else if (typeof value === "string" && value.trim()) {
    items = [{ name: value.trim() }];
  }

  if (items.length === 0) {
    list.appendChild(
      el("p", "pr-record-empty", "No records available.")
    );
    section.appendChild(list);
    return section;
  }

  items.forEach((item) => {
    if (!item) return;

    const entry =
      typeof item === "object"
        ? item
        : { name: String(item) };

    const name = String(
      entry.name ||
      entry.title ||
      entry.recordName ||
      entry.fileName ||
      entry.documentName ||
      "Veterinary record"
    );

    const url = safeLink(
      entry.url ||
      entry.fileUrl ||
      entry.downloadUrl ||
      entry.imageUrl ||
      entry.pdfUrl ||
      entry.link ||
      ""
    );

    const row = el("article", "pr-medical-record");

    row.appendChild(
      el(
        "i",
        "bi " +
          (/\.pdf($|\?)/i.test(name) || String(entry.type).toLowerCase() === "pdf"
            ? "bi-file-earmark-pdf"
            : "bi-file-earmark-medical") +
          " pr-medical-icon"
      )
    );

    const info = el("div", "pr-medical-info");
    info.appendChild(el("strong", "", name));

    const date = recordDate(entry);

    if (date) {
      info.appendChild(el("span", "pr-record-date", date));
    }

    row.appendChild(info);

    if (url) {
      const openLink = el("a", "pr-record-open", "Open");
      openLink.href = url;
      openLink.target = "_blank";
      openLink.rel = "noopener noreferrer";
      row.appendChild(openLink);
    }

    list.appendChild(row);
  });

  section.appendChild(list);
  return section;
}

function openDetails(record) {
  if (!record || !modalEl || !modalTitle || !modalBody) {
    console.error("Cannot open pet details: pet record or modal element is missing.");
    return;
  }

  modalTitle.textContent = "Pet profile";
  modalBody.replaceChildren();

  const data = record.data || {};

  const profile = el("section", "pr-profile");
  const profileActions = el("div", "pr-profile-actions");
  const reportButton = el("button", "pr-report-download");
  reportButton.type = "button";
  reportButton.title = `Download ${record.name}'s clinic record`;
  reportButton.setAttribute(
    "aria-label",
    `Download ${record.name}'s clinic record as an Excel file`
  );
  reportButton.append(
    el("i", "bi bi-file-earmark-spreadsheet", ""),
    document.createTextNode(" Download Excel record")
  );
  reportButton.addEventListener("click", () => {
    downloadPetProfileReport(record, reportButton);
  });
  profileActions.appendChild(reportButton);

  const identity = el("div", "pr-profile-identity");
  const photo = el("div", "pr-profile-photo");

  if (record.photo) {
    const image = document.createElement("img");
    image.src = record.photo;
    image.alt = record.name;

    image.addEventListener("error", () => {
      photo.replaceChildren(el("i", "bi bi-paw-fill"));
    }, { once: true });

    photo.appendChild(image);
  } else {
    photo.appendChild(el("i", "bi bi-paw-fill"));
  }

  const nameBlock = el("div", "pr-profile-name");

  nameBlock.append(
    el("h3", "", record.name),
    el(
      "p",
      "",
      [record.breed, record.age, capitalize(record.sex)]
        .filter(Boolean)
        .join(" • ") || "Pet details"
    )
  );

  identity.append(photo, nameBlock);

  const weightValue = data.weight ?? data.petWeight ?? data.pet_weight;
  const weightUnit = data.weightUnit || data.weight_unit || "kg";

  const weight =
    weightValue === undefined ||
    weightValue === null ||
    weightValue === ""
      ? ""
      : String(weightValue) +
        (
          String(weightValue).toLowerCase()
            .includes(String(weightUnit).toLowerCase())
            ? ""
            : " " + weightUnit
        );

  const allergies =
    data.allergies ??
    data.allergy ??
    data.petAllergies ??
    data.pet_allergies;

  const notes =
    data.ownerNotes ??
    data.owner_notes ??
    data.notes ??
    data.specialNotes;

  const details = el("div", "pr-profile-details");

  details.append(
    profileField("Allergies", displayValue(allergies, "None")),
    profileField("Owner notes", displayValue(notes, "No notes added"))
  );

  if (weight) {
    details.appendChild(profileField("Weight", weight));
  }

  identity.append(profileActions);
  profile.append(identity, details);
  modalBody.appendChild(profile);

  const legacyPastRecords =
    data.pastVetRecords ??
    data.past_vet_records ??
    data.vetRecords ??
    data.vet_records;

  modalBody.appendChild(
    buildRecordSection(
      "Past vet records",
      "View only",
      legacyPastRecords,
      "past"
    )
  );

  // Prevent asynchronous results from updating a different pet's modal.
  modalBody.dataset.recordPath = record.path || record.id || "";

  modalBody.appendChild(buildMedicalHistorySection(record));

  if (typeof bootstrap === "undefined" || !bootstrap.Modal) {
    console.error("Bootstrap Modal is unavailable.");
    return;
  }

  petModal = petModal || bootstrap.Modal.getOrCreateInstance(modalEl);
  petModal.show();

  loadPastVetRecordEntries(record)
    .then((entries) => {
      if (
        !modalBody.isConnected ||
        modalBody.dataset.recordPath !== (record.path || record.id || "")
      ) {
        return;
      }

      const existingSection = modalBody.querySelector(
        ".pr-record-section-past"
      );

      if (entries.length) {
        const updatedSection = buildRecordSection(
          "Past vet records",
          "View only",
          entries,
          "past"
        );

        if (existingSection) {
          existingSection.replaceWith(updatedSection);
        } else {
          const medicalSection = modalBody.querySelector(
            ".pr-record-section-medical"
          );

          if (medicalSection) {
            modalBody.insertBefore(updatedSection, medicalSection);
          } else {
            modalBody.appendChild(updatedSection);
          }
        }
      }
    })
    .catch((error) => {
      console.error("Could not load past vet records:", error);
    });
}


// ==========================================================
// MEDICAL HISTORY
// ==========================================================

function normalizeMedicalHistoryEntry(item) {
  if (!item || typeof item !== "object") {
    return null;
  }

  const name = String(
    item.name ||
    item.title ||
    item.recordName ||
    item.fileName ||
    item.documentName ||
    "Health record"
  ).trim();

  return {
    id: String(item.id || item.recordId || item.fileName || crypto.randomUUID?.() || Date.now() + Math.random()),
    name: name || "Health record",
    fileName: String(item.fileName || item.storageFileName || ""),
    storagePath: String(item.storagePath || ""),
    publicId: String(item.publicId || ""),
    resourceType: String(item.resourceType || ""),
    deliveryType: String(item.deliveryType || ""),
    url: safeLink(
      item.url ||
      item.downloadUrl ||
      item.fileUrl ||
      item.link ||
      item.pdfUrl ||
      ""
    ),
    date: recordDate(item)
  };
}

function normalizeMedicalHistoryList(value) {
  if (Array.isArray(value)) {
    return value
      .map(normalizeMedicalHistoryEntry)
      .filter(Boolean);
  }

  if (!value) return [];

  if (typeof value === "object") {
    const normalized = normalizeMedicalHistoryEntry(value);
    return normalized ? [normalized] : [];
  }

  return [];
}

async function loadMedicalHistoryEntries(record) {
  if (!record || !record.ownerId || !record.id) {
    return normalizeMedicalHistoryList(record?.data?.medicalHistory || []);
  }

  try {
    const medicalHistoryRef = collection(
      db,
      "users",
      record.ownerId,
      "pets",
      record.id,
      "medicalHistory"
    );

    const snapshot = await getDocs(medicalHistoryRef);
    const entries = snapshot.docs
      .map((docSnap) => {
        const data = docSnap.data() || {};
        return {
          id: docSnap.id,
          name: String(
            data.name ||
            data.title ||
            data.fileName ||
            "Health record"
          ),
          fileName: String(data.fileName || data.storageFileName || ""),
          storagePath: String(data.storagePath || ""),
          publicId: String(data.publicId || ""),
          resourceType: String(data.resourceType || ""),
          deliveryType: String(data.deliveryType || ""),
          url: safeLink(data.url || data.downloadUrl || data.fileUrl || data.link || ""),
          date: recordDate(data),
          uploadedAt: data.uploadedAt
        };
      })
      .filter((entry) => entry.name || entry.url)
      .sort((a, b) => {
        const aTime = toDate(a.date || a.uploadedAt)?.getTime?.() || 0;
        const bTime = toDate(b.date || b.uploadedAt)?.getTime?.() || 0;
        return bTime - aTime;
      });

    if (entries.length) return entries;
  } catch (error) {
    console.error("Could not load medical history:", error);
  }

  return normalizeMedicalHistoryList(
    record.data?.medicalHistory ||
    record.data?.medical_history ||
    []
  );
}

class PetRecordUserError extends Error {}

function uploadCloudinaryPdf(record, file, onProgress) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    const formData = new FormData();
    const safeFileName = file.name.replace(/[\\/:*?"<>|]+/g, "_");
    const publicId =
      `${Date.now()}_${safeFileName.replace(/\.pdf$/i, "")}.pdf`;
    const assetFolder =
      `medical-history/${record.ownerId}/${record.id}`;

    formData.append("file", file);
    formData.append("upload_preset", CLOUDINARY_UPLOAD_PRESET);
    formData.append("asset_folder", assetFolder);
    formData.append("public_id", publicId);

    request.open(
      "POST",
      `https://api.cloudinary.com/v1_1/${encodeURIComponent(CLOUDINARY_CLOUD_NAME)}/raw/upload`
    );
    request.timeout = 120000;

    request.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) {
        onProgress?.(event.loaded, event.total);
      }
    });

    request.addEventListener("load", () => {
      let response = {};

      try {
        response = JSON.parse(request.responseText || "{}");
      } catch (error) {
        reject(
          new PetRecordUserError(
            "The upload service returned an unexpected response. Please try again."
          )
        );
        return;
      }

      if (request.status < 200 || request.status >= 300) {
        reject(
          new PetRecordUserError(
            "We couldn't upload this file. Please try again."
          )
        );
        return;
      }

      if (
        response.resource_type !== "raw" ||
        response.type !== "upload" ||
        !response.secure_url ||
        !Number.isFinite(Number(response.bytes)) ||
        Number(response.bytes) > 10 * 1024 * 1024
      ) {
        reject(
          new PetRecordUserError(
            "We couldn't verify the uploaded file. Please try again."
          )
        );
        return;
      }

      resolve({
        ...response,
        fileName: file.name,
        assetFolder
      });
    });

    request.addEventListener("error", () => {
      reject(
        new PetRecordUserError(
          "The upload couldn't connect. Check your internet connection and try again."
        )
      );
    });

    request.addEventListener("timeout", () => {
      reject(
        new PetRecordUserError(
          "The upload is taking too long. Check your internet connection and try again."
        )
      );
    });

    request.send(formData);
  });
}

async function uploadMedicalHistoryFile(record, file, onProgress) {
  if (!record || !record.ownerId || !record.id) {
    throw new PetRecordUserError(
      "We couldn't find this pet record. Refresh the page and try again."
    );
  }

  if (!file) return;

  if (
    !/\.pdf$/i.test(file.name) ||
    (file.type && file.type !== "application/pdf")
  ) {
    throw new PetRecordUserError("Only PDF files are allowed.");
  }

  if (file.size > 10 * 1024 * 1024) {
    throw new PetRecordUserError("Please upload a PDF smaller than 10 MB.");
  }

  const uploaded = await uploadCloudinaryPdf(record, file, onProgress);
  onProgress?.(0, 0, "Saving record...");

  const recordData = {
    name: file.name.replace(/\.pdf$/i, "") || "Health record",
    fileName: uploaded.fileName,
    publicId: uploaded.public_id,
    resourceType: uploaded.resource_type,
    deliveryType: uploaded.type || "upload",
    assetFolder: uploaded.assetFolder,
    url: uploaded.secure_url,
    size: uploaded.bytes,
    contentType: "application/pdf",
    uploadedAt: serverTimestamp(),
    uploadedBy: currentUser?.uid || "",
    uploadedByRole: currentRole || ""
  };

  const metadataRef = await addDoc(
    collection(
      db,
      "users",
      record.ownerId,
      "pets",
      record.id,
      "medicalHistory"
    ),
    recordData
  );

  return {
    ...recordData,
    id: metadataRef.id,
    date: new Date().toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric"
    })
  };
}

function buildMedicalHistorySection(record) {
  const section = el(
    "section",
    "pr-record-section pr-record-section-medical"
  );

  const heading = el("div", "pr-section-heading");
  const headingText = el("div", "");

  headingText.append(
    el("h3", "", "Medical history"),
    el(
      "p",
      "",
       )
  );

  const uploadButton = el("button", "pr-upload-button");
  const uploadInput = document.createElement("input");

  uploadInput.type = "file";
  uploadInput.accept = ".pdf,application/pdf";
  uploadInput.hidden = true;

  uploadButton.type = "button";

  uploadButton.append(
    el("i", "bi bi-upload"),
    document.createTextNode(" Upload PDF")
  );

  heading.append(headingText, uploadButton);
  section.appendChild(heading);

  const status = el("p", "pr-medical-status");
  status.hidden = true;
  status.setAttribute("role", "status");

  const list = el("div", "pr-medical-records");
  section.append(status, list, uploadInput);

  let entries = [];

  function renderEntries() {
    list.replaceChildren();

    if (entries.length === 0) {
      list.appendChild(
        el(
          "p",
          "pr-record-empty",
          "No medical history available."
        )
      );

      return;
    }

    entries.forEach((entry) => {
      const row = el("article", "pr-medical-record");

      row.appendChild(
        el("i", "bi bi-file-earmark-pdf pr-medical-icon")
      );

      const info = el("div", "pr-medical-info");
      info.appendChild(
        el("strong", "", entry.name || "Health record")
      );

      if (entry.date) {
        info.appendChild(
          el("span", "pr-record-date", entry.date)
        );
      }

      row.appendChild(info);

      if (entry.url) {
        const openButton = el("a", "pr-record-open", "Open");
        openButton.href = entry.url;
        openButton.target = "_blank";
        openButton.rel = "noopener noreferrer";
        row.appendChild(openButton);
      }

      list.appendChild(row);
    });
  }

  uploadButton.addEventListener("click", () => {
    uploadInput.click();
  });

  uploadInput.addEventListener("change", async (event) => {
    const file = event.target.files?.[0];

    if (!file) return;

    try {
      uploadButton.disabled = true;
      uploadInput.value = "";

      const uploadedEntry = await uploadMedicalHistoryFile(
        record,
        file,
        (transferred, total, message) => {
          if (message) {
            uploadButton.textContent = message;
            return;
          }

          if (transferred === 0) {
            uploadButton.textContent = "Connecting...";
            return;
          }

          const progress = total
            ? Math.round((transferred / total) * 100)
            : 0;

          uploadButton.textContent = `Uploading ${progress}%...`;
        }
      );

      showMedicalStatus(status, "PDF uploaded successfully.", false);
      if (uploadedEntry) {
        entries = [
          normalizeMedicalHistoryEntry({
            ...uploadedEntry,
            date: new Date().toLocaleDateString("en-US", {
              month: "short",
              day: "numeric",
              year: "numeric"
            })
          }),
          ...entries
        ].filter(Boolean);
      }
      renderEntries();
    } catch (error) {
      console.error("Could not upload medical history PDF:", error);
      const message =
        error instanceof PetRecordUserError
          ? error.message
          : error?.code === "permission-denied"
            ? "You don't have permission to add medical records. Contact an administrator if you need access."
            : "We couldn't upload and save this file. Please try again.";
      showMedicalStatus(
        status,
        message,
        true
      );
    } finally {
      uploadButton.disabled = false;
      uploadButton.innerHTML = '<i class="bi bi-upload"></i> Upload PDF';
    }
  });

  (async () => {
    entries = await loadMedicalHistoryEntries(record);
    renderEntries();
  })();

  return section;
}

function showMedicalStatus(
  status,
  message,
  isError = false
) {
  status.textContent = message;

  status.classList.toggle(
    "pr-medical-status-error",
    isError
  );

  status.hidden = false;
}

// ==========================================================
// PAST VET RECORDS
// ==========================================================

async function loadPastVetRecordEntries(record) {
  if (!record?.id) return [];

  // Android may save records under pets/{petId}/pastRecords.
  // Web-created pet records are usually under
  // users/{ownerId}/pets/{petId}/pastRecords.
  const paths = [
    `pets/${record.id}/pastRecords`,
    record.path
      ? `${record.path}/pastRecords`
      : ""
  ].filter(Boolean);

  const uniquePaths = [...new Set(paths)];
  const entriesById = new Map();

  for (const path of uniquePaths) {
    try {
      const snapshot = await getDocs(
        collection(db, path)
      );

      snapshot.docs.forEach((docSnap) => {
        const data = docSnap.data() || {};

        const fileUrl = safeLink(
          data.fileUrl ||
          data.url ||
          data.downloadUrl ||
          data.imageUrl ||
          ""
        );

        const fileName = String(
          data.fileName ||
          data.name ||
          data.title ||
          "Past vet record"
        );

        entriesById.set(
          `${path}/${docSnap.id}`,
          {
            id: docSnap.id,
            type: String(
              data.type || ""
            ).toLowerCase(),
            name: fileName,
            fileName,
            url: fileUrl,
            fileUrl,
            uploadedAt:
              data.uploadedAt ||
              data.createdAt ||
              data.timestamp ||
              null,
            uploadedBy: String(
              data.uploadedBy || ""
            ),
            date: recordDate(data)
          }
        );
      });
    } catch (error) {
      // Continue checking the other possible path.
      console.warn(
        `Could not read past records at "${path}":`,
        error
      );
    }
  }

  return [...entriesById.values()].sort(
    (a, b) => {
      const aTime =
        toDate(a.uploadedAt || a.date)?.getTime() || 0;

      const bTime =
        toDate(b.uploadedAt || b.date)?.getTime() || 0;

      return bTime - aTime;
    }
  );
}

// ==========================================================
// LOAD ERROR
// ==========================================================

function showLoadError(message, error) {
  console.error(message, error);
  window.SkinPawsibleNetworkStatus?.setIssue(
    "session",
    message,
    () => window.location.reload()
  );
}

// ==========================================================
// SEARCH AND GENDER FILTERS
// ==========================================================

if (searchInput) {
  searchInput.addEventListener("input", () => {
    searchText = searchInput.value;
    showAllPetRecords = false;
    render();
  });
}

showMoreButton?.addEventListener("click", () => {
  showAllPetRecords = !showAllPetRecords;
  render();
});

chips.forEach((chip) => {
  chip.addEventListener("click", () => {
    activeFilter = chip.dataset.filter || "all";
    showAllPetRecords = false;

    chips.forEach((item) => {
      item.classList.toggle(
        "active",
        item === chip
      );
    });

    render();
  });
});

// ==========================================================
// POPULATE REGISTERED PET OWNERS
// ==========================================================

function populatePetOwners() {
  const select = document.getElementById("newPetOwner");

  if (!select) return;

  const previousValue = select.value;

  select.replaceChildren();

  const placeholder = document.createElement("option");

  placeholder.value = "";
  placeholder.textContent = "Select registered owner";

  select.appendChild(placeholder);

  const owners = [...allProfiles.entries()]
    .filter(([id, profile]) => {
      return (
        id &&
        !isWebStaffRole(profile.role) &&
        isActiveProfile(profile)
      );
    })
    .map(([id, profile]) => ({
      id,
      name:
        profile.fullName ||
        profile.displayName ||
        profile.name ||
        profile.email ||
        "Registered Pet Owner"
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  owners.forEach((owner) => {
    const option = document.createElement("option");

    option.value = owner.id;
    option.textContent = owner.name;

    select.appendChild(option);
  });

  if (owners.length === 0) {
    const option = document.createElement("option");

    option.value = "";
    option.textContent = "No registered pet owners found";
    option.disabled = true;

    select.appendChild(option);
  }

  if (
    previousValue &&
    owners.some((owner) => owner.id === previousValue)
  ) {
    select.value = previousValue;
  }
}

function showAddPetMessage(
  message,
  isError = false
) {
  const messageEl =
    document.getElementById("addPetMessage");

  if (!messageEl) return;

  messageEl.textContent = message;

  messageEl.classList.toggle(
    "text-danger",
    isError
  );

  messageEl.classList.toggle(
    "text-success",
    Boolean(message) && !isError
  );
}

// ==========================================================
// INITIALIZE ADD PET
// ==========================================================

function createAddPetModal() {
  const existingModal = document.getElementById("addPetModal");
  if (existingModal) return existingModal;

  const modalElement = document.createElement("div");
  modalElement.className = "modal fade";
  modalElement.id = "addPetModal";
  modalElement.tabIndex = -1;
  modalElement.setAttribute("aria-labelledby", "addPetModalTitle");
  modalElement.setAttribute("aria-hidden", "true");
  modalElement.innerHTML = `
    <div class="modal-dialog modal-dialog-centered modal-dialog-scrollable modal-lg add-pet-dialog">
      <div class="modal-content">
        <form id="addPetForm" class="add-pet-form">
          <div class="modal-header">
            <h5 class="modal-title" id="addPetModalTitle">Add Pet Record</h5>
            <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>
          </div>
          <div class="modal-body add-pet-form-body">
            <div class="add-pet-form-grid">
            <div class="mb-3">
              <label class="form-label" for="newPetOwner">Pet owner</label>
              <select class="form-select" id="newPetOwner" required>
                <option value="">Select registered owner</option>
              </select>
            </div>
            <div class="mb-3">
              <label class="form-label" for="newPetName">Pet name</label>
              <input class="form-control" id="newPetName" type="text" maxlength="120" required>
            </div>
            <div class="mb-3">
              <label class="form-label" for="newPetBreed">Breed</label>
              <input class="form-control" id="newPetBreed" type="text" maxlength="120">
            </div>
            <div class="mb-3">
              <label class="form-label" for="newPetAge">Age</label>
              <input class="form-control" id="newPetAge" type="text" maxlength="40">
            </div>
            <div class="mb-3">
              <label class="form-label" for="newPetSex">Sex</label>
              <select class="form-select" id="newPetSex" required>
                <option value="">Select sex</option>
                <option value="male">Male</option>
                <option value="female">Female</option>
              </select>
            </div>
            <div class="mb-3">
              <label class="form-label" for="newPetWeight">Weight (kg)</label>
              <input class="form-control" id="newPetWeight" type="number" min="0" step="any">
            </div>
            <div class="mb-3">
              <label class="form-label" for="newPetAllergies">Allergies</label>
              <textarea class="form-control" id="newPetAllergies" rows="2"></textarea>
            </div>
            <div class="mb-3">
              <label class="form-label" for="newPetNotes">Owner notes</label>
              <textarea class="form-control" id="newPetNotes" rows="3"></textarea>
            </div>
            </div>
            <p id="addPetMessage" class="mb-0" role="status" aria-live="polite"></p>
          </div>
          <div class="modal-footer">
            <button type="button" class="btn btn-outline-secondary" data-bs-dismiss="modal">Cancel</button>
            <button type="submit" class="btn btn-primary" id="savePetBtn">Save Pet</button>
          </div>
        </form>
      </div>
    </div>`;

  document.body.appendChild(modalElement);
  return modalElement;
}

function initializeAddPet() {
  if (initialized) return;

  if (!addPetBtn) return;

  if (!window.bootstrap?.Modal) {
    console.error(
      "Bootstrap Modal is unavailable for the Add Pet button."
    );
    return;
  }

  const modalElement = createAddPetModal();

  addPetModal =
    window.bootstrap.Modal.getOrCreateInstance(modalElement);

  const form = document.getElementById("addPetForm");
  const saveButton = document.getElementById("savePetBtn");
  const ownerSelect = document.getElementById("newPetOwner");
  const formFields = [...form.querySelectorAll("input, select, textarea")];

  function setFormFieldsDisabled(disabled) {
    formFields.forEach((field) => {
      field.disabled = disabled;
    });
  }

  function restorePendingPetSave() {
    const { ownerId, data } = pendingPetSave;
    ownerSelect.value = ownerId;
    document.getElementById("newPetName").value = data.petName;
    document.getElementById("newPetBreed").value = data.breed;
    document.getElementById("newPetAge").value = data.age;
    document.getElementById("newPetSex").value = data.sex;
    document.getElementById("newPetWeight").value = data.weight ?? "";
    document.getElementById("newPetAllergies").value = data.allergies;
    document.getElementById("newPetNotes").value = data.ownerNotes;
    setFormFieldsDisabled(true);
    saveButton.textContent = "Retry Save";
    showAddPetMessage(
      "The previous save was not confirmed. Your entries are preserved; retry the same save to avoid creating a duplicate.",
      true
    );
  }

  async function savePendingPetRecord() {
    saveButton.disabled = true;
    saveButton.textContent = "Saving...";

    try {
      await setDoc(pendingPetSave.ref, pendingPetSave.data);
      pendingPetSave = null;
      setFormFieldsDisabled(false);
      showAddPetMessage("Pet record added successfully.");
      form.reset();

      window.setTimeout(() => {
        addPetModal.hide();
      }, 700);
    } catch (error) {
      console.error("Could not add pet record:", error);

      if (["permission-denied", "invalid-argument", "failed-precondition"].includes(error.code)) {
        pendingPetSave = null;
        setFormFieldsDisabled(false);
        showAddPetMessage(
          error.code === "permission-denied"
            ? "You don't have permission to add pet records. Contact an administrator if you need access."
            : "The pet record could not be saved because its data or current state was rejected. Your entries are preserved; review them and try again.",
          true
        );
      } else {
        setFormFieldsDisabled(true);
        showAddPetMessage(
          !navigator.onLine || ["unavailable", "deadline-exceeded", "network-request-failed"].includes(error.code)
            ? "Could not confirm the save. Your entries are preserved. Reconnect, then select Retry Save; this retry uses the same record ID."
            : "Could not save the pet record. Your entries are preserved. Select Retry Save to try again.",
          true
        );
      }
    } finally {
      saveButton.disabled = false;
      saveButton.textContent = pendingPetSave ? "Retry Save" : "Save Pet";
    }
  }

  // OPEN ADD PET MODAL
  addPetBtn.addEventListener("click", () => {
    if (!currentUser || !isWebStaffRole(currentRole)) {
      alert(
        "You do not have permission to add pet records."
      );

      return;
    }

    editingPet = null;
    ownerSelect.disabled = false;

    document.getElementById("addPetModalTitle").textContent =
      "Add Pet Record";

    saveButton.textContent = "Save Pet";
    saveButton.disabled = false;

    populatePetOwners();

    if (pendingPetSave) {
      restorePendingPetSave();
    } else {
      form.reset();
      setFormFieldsDisabled(false);
      showAddPetMessage("");
    }

    addPetModal.show();
  });

  // SAVE NEW PET RECORD
  form.addEventListener("submit", async (event) => {
    event.preventDefault();

    if (saveButton.disabled) return;

    if (!currentUser || !isWebStaffRole(currentRole)) {
      showAddPetMessage(
        "You do not have permission to save pet records.",
        true
      );

      return;
    }

    if (pendingPetSave) {
      await savePendingPetRecord();
      return;
    }

    const ownerId = ownerSelect.value;

    const petName =
      document.getElementById("newPetName").value.trim();

    const breed =
      document.getElementById("newPetBreed").value.trim();

    const age =
      document.getElementById("newPetAge").value.trim();

    const sex =
      document.getElementById("newPetSex").value;

    const weightInput =
      document.getElementById("newPetWeight").value.trim();

    const allergies =
      document.getElementById("newPetAllergies").value.trim();

    const ownerNotes =
      document.getElementById("newPetNotes").value.trim();

    if (!ownerId || !petName || !sex) {
      showAddPetMessage(
        "Please complete the required fields.",
        true
      );

      return;
    }

    let weight = null;

    if (weightInput !== "") {
      weight = Number(weightInput);

      if (!Number.isFinite(weight) || weight < 0) {
        showAddPetMessage(
          "Please enter a valid weight.",
          true
        );

        return;
      }
    }

    const ownerProfile = allProfiles.get(ownerId);

    if (
      !ownerProfile ||
      isWebStaffRole(ownerProfile.role) ||
      !isActiveProfile(ownerProfile)
    ) {
      showAddPetMessage(
        "Please select a valid active registered pet owner.",
        true
      );

      return;
    }

    const petData = {
      petName,
      breed,
      age,
      sex,
      ownerId,

      ownerName:
        ownerProfile.fullName ||
        ownerProfile.displayName ||
        ownerProfile.name ||
        ownerProfile.email ||
        "Pet Owner",

      allergies,
      ownerNotes,
      weight,
      weightUnit: "kg",

      createdAt: serverTimestamp(),
      createdBy: currentUser.uid,
      createdByRole: currentRole,
      source: "web_admin"
    };

    pendingPetSave = {
      ref: doc(collection(db, "users", ownerId, "pets")),
      ownerId,
      data: petData
    };
    setFormFieldsDisabled(true);
    await savePendingPetRecord();
  });

  modalElement.addEventListener(
    "hidden.bs.modal",
    () => {
      if (pendingPetSave) {
        restorePendingPetSave();
      } else {
        form.reset();
        setFormFieldsDisabled(false);
        saveButton.textContent = "Save Pet";
        ownerSelect.disabled = false;
        showAddPetMessage("");
      }
    }
  );

  initialized = true;
}

window.addEventListener("beforeunload", (event) => {
  if (!pendingPetSave) return;

  event.preventDefault();
  event.returnValue = "";
});
