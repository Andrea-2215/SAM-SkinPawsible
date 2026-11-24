import { db } from "./firebase-config.js";
import { watchActiveStaffPage } from "./page-auth.js";

import {
  collection,
  collectionGroup,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  writeBatch
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

const table = document.getElementById("scanRecordsTable");
const footerEl = document.getElementById("scanFooter");
const showMoreButton = document.getElementById("scanRecordsShowMore");
const searchInput = document.getElementById("scanSearch");
const filterButtons = document.querySelectorAll("[data-filter]");
const dateFilterToggle = document.getElementById("scanDateFilterToggle");
const dateFilterPanel = document.getElementById("scanDateFilterPanel");
const dateFromInput = document.getElementById("scanDateFrom");
const dateToInput = document.getElementById("scanDateTo");
const dateResetButton = document.getElementById("scanDateReset");
const sortNewestButton = document.getElementById("scanSortNewest");
const sortOldestButton = document.getElementById("scanSortOldest");
const downloadScanReportButton = document.getElementById("downloadScanReportBtn");

const imageDialog = document.getElementById("scanImageDialog");
const imagePreview = document.getElementById("scanImagePreview");
const imageDialogTitle = document.getElementById("scanImageDialogTitle");
const imageStage = document.querySelector(".sr-image-stage");
const imageDialogBody = document.querySelector(".sr-image-dialog-body");
const imageZoomLevel = document.getElementById("scanImageZoomLevel");

const MIN_IMAGE_ZOOM = 0.5;
const MAX_IMAGE_ZOOM = 3;
const IMAGE_ZOOM_STEP = 0.25;

let imageZoom = 1;
let imagePanX = 0;
let imagePanY = 0;
let imagePanPointer = null;
let imageLastX = 0;
let imageLastY = 0;

let allScans = [];
let activeFilter = "all";
let showAllScans = false;
const SCAN_RECORDS_PAGE_SIZE = 10;
let dateSortDirection = "desc";
let dateFrom = "";
let dateTo = "";
let searchText = "";
let scanSnapshotVersion = 0;

let currentRole = "";
let selectionMode = false;
let isBulkDeleting = false;

const selectedScanPaths = new Set();
const ownerNameCache = new Map();
const ownerPetsCache = new Map();

let adminControls = null;
let editModeButton = null;
let selectAllLabel = null;
let selectAllCheckbox = null;
let selectionCount = null;
let deleteSelectedButton = null;
let cancelSelectionButton = null;


// ========================================
// CHECK LOGGED-IN USER
// ========================================

watchActiveStaffPage(({ user, profile, role }) => {
  currentRole = role;
  // ========================================
  // DISPLAY USER INFORMATION
  // ========================================

  const displayName =
    profile?.fullName ||
    profile?.displayName ||
    user.displayName ||
    "User";

  const userNameElement = document.getElementById("userName");
  const userEmailElement = document.getElementById("userEmail");
  const userInitialElement = document.getElementById("userInitial");

  if (userNameElement) {
    userNameElement.textContent = displayName;
  }

  if (userEmailElement) {
    userEmailElement.textContent = user.email || "";
  }

  if (userInitialElement) {
    userInitialElement.textContent =
      displayName.charAt(0).toUpperCase();
  }

  // Admin and staff receive the editing and bulk-delete controls.
  if (["admin", "staff"].includes(currentRole)) {
    createAdminControls();
  }

  loadScanRecords();
});


// ========================================
// ADMIN CONTROLS
// ========================================

function createAdminControls() {
  const toolbar = document.querySelector(".table-card .sr-toolbar-actions");
  const filterToolbar = document.querySelector(".table-card .sr-toolbar");

  if (!toolbar || !filterToolbar || adminControls) return;

  adminControls = document.createElement("div");
  adminControls.className = "sr-selection-controls";
  adminControls.setAttribute("role", "group");
  adminControls.setAttribute("aria-label", "Scan record selection actions");
  adminControls.hidden = true;

  editModeButton = createStyledButton({
    icon: "bi-pencil",
    text: "Edit",
    title: "Select scans to delete",
    ariaLabel: "Enter scan selection mode",
    color: "#dc3545"
  });

  editModeButton.addEventListener("click", () => {
    if (isBulkDeleting) return;

    if (!selectionMode) {
      selectionMode = true;
      selectedScanPaths.clear();
    } else {
      // Clicking the pen again exits selection mode.
      selectionMode = false;
      selectedScanPaths.clear();
    }

    render();
  });

  selectAllLabel = document.createElement("label");
  selectAllLabel.className = "sr-select-all";

  selectAllCheckbox = document.createElement("input");
  selectAllCheckbox.type = "checkbox";
  selectAllCheckbox.className = "form-check-input m-0";
  selectAllCheckbox.setAttribute(
    "aria-label",
    "Select all visible scan records"
  );

  selectAllLabel.append(
    selectAllCheckbox,
    document.createTextNode("Select all")
  );

  selectAllCheckbox.addEventListener("change", () => {
    if (!selectionMode || isBulkDeleting) return;

    const visibleScans = getVisibleScans();

    if (selectAllCheckbox.checked) {
      visibleScans.forEach((scan) => {
        selectedScanPaths.add(scan.path);
      });
    } else {
      visibleScans.forEach((scan) => {
        selectedScanPaths.delete(scan.path);
      });
    }

    render();
  });

  selectionCount = document.createElement("span");
  selectionCount.className = "sr-selection-count";

  deleteSelectedButton = createStyledButton({
    icon: "bi-trash",
    text: "Delete Selected",
    title: "Delete selected scan records",
    ariaLabel: "Delete selected scan records",
    color: "#dc3545"
  });

  deleteSelectedButton.addEventListener("click", deleteSelectedScans);

  cancelSelectionButton = createStyledButton({
    icon: "bi-x-lg",
    text: "Cancel",
    title: "Cancel scan selection",
    ariaLabel: "Cancel scan selection",
    color: "#6b7280"
  });

  cancelSelectionButton.addEventListener("click", () => {
    if (isBulkDeleting) return;

    selectionMode = false;
    selectedScanPaths.clear();

    render();
  });

  toolbar.append(editModeButton);
  adminControls.append(
    selectAllLabel,
    selectionCount,
    deleteSelectedButton,
    cancelSelectionButton
  );

  filterToolbar.insertAdjacentElement("afterend", adminControls);

  updateAdminControls();
}

function createStyledButton({
  icon,
  text = "",
  title,
  ariaLabel,
  color = "#dc3545"
}) {
  const button = document.createElement("button");

  button.type = "button";
  button.title = title;
  button.setAttribute("aria-label", ariaLabel);
  button.className = color === "#6b7280"
    ? "btn btn-sm btn-outline-secondary"
    : "btn btn-sm btn-outline-danger";

  const iconElement = document.createElement("i");
  iconElement.className = `bi ${icon}`;
  iconElement.setAttribute("aria-hidden", "true");

  button.appendChild(iconElement);

  if (text) {
    button.appendChild(document.createTextNode(text));
  }

  return button;
}

function updateAdminControls() {
  if (!adminControls || !["admin", "staff"].includes(currentRole)) return;

  editModeButton.hidden = selectionMode;
  adminControls.hidden = !selectionMode;

  const count = selectedScanPaths.size;

  selectionCount.textContent = `${count} selected`;

  deleteSelectedButton.disabled =
    count === 0 || isBulkDeleting;

  editModeButton.disabled = isBulkDeleting;
  cancelSelectionButton.disabled = isBulkDeleting;

  if (isBulkDeleting) {
    deleteSelectedButton.replaceChildren(
      document.createTextNode("Deleting...")
    );
  } else {
    deleteSelectedButton.replaceChildren();

    const icon = document.createElement("i");
    icon.className = "bi bi-trash";
    icon.setAttribute("aria-hidden", "true");

    deleteSelectedButton.append(
      icon,
      document.createTextNode("Delete Selected")
    );
  }
}


// ========================================
// REAL-TIME SCAN RECORDS
// users/{userId}/scans/{scanId}
// ========================================

function loadScanRecords() {
  if (!table) return;

  onSnapshot(
    collectionGroup(db, "scans"),

    async (snapshot) => {
      const snapshotVersion = ++scanSnapshotVersion;

      const records = await Promise.all(
        snapshot.docs.map(async (docSnap) => {
          const scan = docSnap.data();

          const ownerId =
            scan.userId ||
            docSnap.ref.parent.parent?.id ||
            "";

          const [ownerName, petName] = await Promise.all([
            getOwnerName(scan, ownerId),
            getPetName(scan, ownerId)
          ]);

          return toRecord(
            scan,
            ownerName,
            petName,
            docSnap.ref
          );
        })
      );

      if (snapshotVersion !== scanSnapshotVersion) return;

      allScans = records.sort(
        (a, b) =>
          (b.date?.getTime() || 0) -
          (a.date?.getTime() || 0)
      );

      // Remove selections for records that no longer exist.
      const existingPaths = new Set(
        allScans.map((record) => record.path)
      );

      for (const path of selectedScanPaths) {
        if (!existingPaths.has(path)) {
          selectedScanPaths.delete(path);
        }
      }

      render();
    },

    (error) => {
      console.error("Real-time scan listener error:", error);

      table.replaceChildren(
        messageRow("Could not load scan records.", true)
      );
    }
  );
}


// ========================================
// BUILD ONE RECORD
// ========================================

function toRecord(scan, ownerName, petName, scanRef) {
  const result =
    scan.result ||
    scan.prediction ||
    scan.detectedCondition ||
    scan.predictedCondition ||
    scan.condition ||
    scan.diagnosis ||
    scan.label ||
    "Unknown";

  const rawConfidence =
    scan.confidenceScore ?? scan.confidence;

  const date = getScanDate(scan);

  return {
    id: scanRef.id,
    ref: scanRef,
    path: scanRef.path,
    petName,
    ownerName,
    result: String(result),
    category: resultCategory(result),
    confidenceNumber: confidenceNumber(rawConfidence),
    confidenceText: formatConfidence(rawConfidence),
    date,
    dateText: date
      ? date.toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric"
        })
      : "-",
    image: getImageSource(scan)
  };
}

function getSavedPetName(pet) {
  return String(
    pet.petName || pet.pet_name || pet.name || ""
  ).trim();
}

function isPlaceholderPetName(name) {
  return !name ||
    /^(pet|dog|unknown(?: pet)?|unnamed pet)$/i.test(name);
}

async function getOwnerPets(ownerId) {
  if (!ownerPetsCache.has(ownerId)) {
    const petsPromise = getDocs(
      collection(db, "users", ownerId, "pets")
    )
      .then((snapshot) =>
        snapshot.docs.map((petSnap) => ({
          id: petSnap.id,
          data: petSnap.data()
        }))
      )
      .catch((error) => {
        console.error(
          `Could not load pets for owner "${ownerId}":`,
          error
        );
        return [];
      });

    ownerPetsCache.set(ownerId, petsPromise);
  }

  return ownerPetsCache.get(ownerId);
}

async function getPetName(scan, ownerId) {
  const scanPet = scan.pet || {};

  const topLevelName = getSavedPetName(scan);
  const nestedName = getSavedPetName(scanPet);

  const savedName = isPlaceholderPetName(topLevelName)
    ? nestedName || topLevelName
    : topLevelName;

  const petId =
    scan.petId ||
    scan.petID ||
    scan.pet_id ||
    scan.petDocId ||
    scan.petDocumentId ||
    scan.animalId ||
    scan.animal_id ||
    scan.petRef?.id ||
    scan.petReference?.id ||
    scanPet.petId ||
    scanPet.id;

  if (ownerId && petId) {
    try {
      const petSnap = await getDoc(
        doc(db, "users", ownerId, "pets", String(petId))
      );

      if (petSnap.exists()) {
        const linkedPetName = getSavedPetName(petSnap.data());

        if (linkedPetName) return linkedPetName;
      }
    } catch (error) {
      console.error(
        `Could not load scan pet "${petId}":`,
        error
      );
    }
  }

  if (!isPlaceholderPetName(savedName)) return savedName;
  if (!ownerId) return "Unnamed pet";

  const ownerPets = await getOwnerPets(ownerId);

  if (ownerPets.length === 1) {
    return getSavedPetName(ownerPets[0].data) || "Unnamed pet";
  }

  return "Unnamed pet";
}

async function getOwnerName(scan, ownerId) {
  const savedOwnerName =
    scan.ownerName ||
    scan.ownerFullName ||
    scan.ownerDisplayName;

  if (savedOwnerName) return String(savedOwnerName);
  if (!ownerId) return "Pet owner";

  if (!ownerNameCache.has(ownerId)) {
    const ownerNamePromise = getDoc(
      doc(db, "users", ownerId)
    )
      .then((ownerSnap) => {
        if (!ownerSnap.exists()) return "Pet owner";

        const owner = ownerSnap.data();

        const name =
          owner.fullName ||
          owner.displayName ||
          owner.name ||
          [owner.firstName, owner.lastName]
            .filter(Boolean)
            .join(" ");

        return String(name || owner.email || "Pet owner");
      })
      .catch((error) => {
        console.error(
          `Could not load scan owner "${ownerId}":`,
          error
        );
        return "Owner unavailable";
      });

    ownerNameCache.set(ownerId, ownerNamePromise);
  }

  return ownerNameCache.get(ownerId);
}

function resultCategory(result) {
  const text = String(result).toLowerCase();

  if (text.includes("healthy")) return "healthy";
  if (text.includes("ringworm")) return "ringworm";
  if (text.includes("yeast")) return "yeast";

  return "other";
}


// ========================================
// GET VISIBLE SCANS
// ========================================

function getVisibleScans() {
  const q = searchText.trim().toLowerCase();

  return allScans.filter((record) => {
    const matchesFilter =
      activeFilter === "all" ||
      record.category === activeFilter;

    const matchesSearch =
      !q ||
      (
        record.petName +
        " " +
        record.ownerName +
        " " +
        record.result
      ).toLowerCase().includes(q);

    const recordDate = record.date
      ? formatDateInputValue(record.date)
      : "";
    const matchesDateRange =
      (!dateFrom && !dateTo) ||
      (
        recordDate &&
        (!dateFrom || recordDate >= dateFrom) &&
        (!dateTo || recordDate <= dateTo)
      );

    return matchesFilter && matchesSearch && matchesDateRange;
  }).sort((a, b) => {
    if (!a.date) return b.date ? 1 : 0;
    if (!b.date) return -1;

    return dateSortDirection === "asc"
      ? a.date.getTime() - b.date.getTime()
      : b.date.getTime() - a.date.getTime();
  });
}


// ========================================
// RENDER TABLE
// ========================================

function render() {
  if (!table) return;

  const filteredScans = getVisibleScans();
  const isShowingAll = showAllScans || selectionMode;
  const shown = isShowingAll
    ? filteredScans
    : filteredScans.slice(0, SCAN_RECORDS_PAGE_SIZE);

  table.replaceChildren();

  if (filteredScans.length === 0 && allScans.length === 0) {
    table.appendChild(messageRow("No scan records yet."));
  } else if (filteredScans.length === 0) {
    table.appendChild(
      messageRow("No scans match your search.")
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
      filteredScans.length +
      (filteredScans.length === 1 ? " scan" : " scans");
  }

  if (showMoreButton) {
    showMoreButton.hidden =
      filteredScans.length <= SCAN_RECORDS_PAGE_SIZE || selectionMode;
    showMoreButton.textContent = isShowingAll
      ? "Show fewer scan records"
      : `Show remaining scan records (${filteredScans.length - shown.length})`;
  }

  if (downloadScanReportButton) {
    downloadScanReportButton.disabled = filteredScans.length === 0;
  }

  updateAdminControls();
}

function downloadScanReport() {
  const records = getVisibleScans();
  if (!records.length) {
    window.alert("There are no visible scan records to export.");
    return;
  }

  const xlsx = window.XLSX;
  if (!xlsx) {
    console.error("Excel report library did not load.");
    window.alert("Excel export is unavailable. Refresh the page and try again.");
    return;
  }

  const columns = [
    "Pet Name",
    "Pet Owner",
    "Detected Condition",
    "Confidence",
    "Scan Date"
  ];
  const rows = records.map((record) => [
    record.petName || "-",
    record.ownerName || "-",
    record.result || "Unknown",
    record.confidenceText || "-",
    record.dateText || "-"
  ]);
  const generatedAt = new Date();
  const conditionLabel = {
    all: "All",
    healthy: "Healthy",
    ringworm: "Ringworm",
    yeast: "Yeast dermatitis"
  }[activeFilter] || "All";
  const dateRangeLabel = dateFrom || dateTo
    ? `${dateFrom || "Any"} to ${dateTo || "Any"}`
    : "Any date";
  const worksheet = xlsx.utils.aoa_to_sheet([
    ["SKINPAWSIBLE - SCAN RECORDS REPORT"],
    ["Scan results for the records currently shown in Scan Records."],
    [`Generated: ${generatedAt.toLocaleString()}`],
    [`Records included: ${records.length}    Condition: ${conditionLabel}    Date range: ${dateRangeLabel}    Search: ${searchText.trim() || "None"}    Sort: ${dateSortDirection === "desc" ? "Newest" : "Oldest"}`],
    columns,
    ...rows
  ]);
  worksheet["!cols"] = [
    { wch: 24 },
    { wch: 28 },
    { wch: 24 },
    { wch: 16 },
    { wch: 18 }
  ];
  worksheet["!merges"] = [0, 1, 2, 3].map((row) => ({
    s: { r: row, c: 0 },
    e: { r: row, c: columns.length - 1 }
  }));

  const workbook = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(workbook, worksheet, "Scan Records");
  workbook.Props = {
    Title: "SkinPawsible Scan Records Report",
    Subject: "Scan results, confidence levels, and dates",
    Author: "SkinPawsible",
    CreatedDate: generatedAt
  };

  const filenameDate = [
    generatedAt.getFullYear(),
    String(generatedAt.getMonth() + 1).padStart(2, "0"),
    String(generatedAt.getDate()).padStart(2, "0")
  ].join("-");
  xlsx.writeFile(workbook, `SkinPawsible-Scan-Records-${filenameDate}.xlsx`);
}

downloadScanReportButton?.addEventListener("click", downloadScanReport);

function el(tag, className, text) {
  const node = document.createElement(tag);

  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;

  return node;
}

function messageRow(message, isError = false) {
  const row = document.createElement("tr");

  const cell = el(
    "td",
    "sr-message" + (isError ? " sr-error" : ""),
    message
  );

  cell.colSpan = 4;
  row.appendChild(cell);

  return row;
}


// ========================================
// SCAN THUMBNAIL
// ========================================

function buildThumb(record) {
  const thumb = el(
    record.image ? "button" : "div",
    record.image
      ? "sr-thumb sr-thumb-button"
      : "sr-thumb"
  );

  const showFallback = () => {
    if (thumb instanceof HTMLButtonElement) {
      thumb.disabled = true;
      thumb.setAttribute(
        "aria-label",
        "Scan photo unavailable"
      );
    }

    thumb.replaceChildren(el("i", "bi bi-image"));
  };

  if (record.image) {
    thumb.type = "button";

    thumb.setAttribute(
      "aria-label",
      `View larger scan photo for ${record.petName}`
    );

    const img = document.createElement("img");
    img.alt = "Scan of " + record.petName;
    img.loading = "lazy";
    img.decoding = "async";

    img.addEventListener("error", showFallback);
    img.src = record.image;

    thumb.appendChild(img);

    thumb.addEventListener("click", () => {
      if (
        !imageDialog ||
        !imagePreview ||
        !window.bootstrap?.Modal
      ) {
        console.error("Scan image preview is unavailable.");
        return;
      }

      imagePreview.src = record.image;
      imagePreview.alt =
        "Larger scan photo of " + record.petName;

      if (imageDialogTitle) {
        imageDialogTitle.textContent =
          `Scan photo: ${record.petName}`;
      }

      resetImageZoom();

      window.bootstrap.Modal
        .getOrCreateInstance(imageDialog)
        .show();
    });
  } else {
    showFallback();
  }

  return thumb;
}


// ========================================
// BUILD TABLE ROW
// ========================================


function buildRow(record) {
  const row = document.createElement("tr");

  // ========================================
  // SCAN CELL: CHECKBOX LEFT OF SCAN PICTURE
  // ========================================

  const scanCell = document.createElement("td");
  const scan = el("div", "sr-scan");

  // Use inline styling so no CSS file changes are needed.
  scan.style.display = "flex";
  scan.style.flexDirection = "row";
  scan.style.alignItems = "center";
  scan.style.gap = "10px";

  if (["admin", "staff"].includes(currentRole) && selectionMode) {
    const checkbox = document.createElement("input");

    checkbox.type = "checkbox";
    checkbox.className = "form-check-input m-0";
    checkbox.checked = selectedScanPaths.has(record.path);
    checkbox.disabled = isBulkDeleting;

    checkbox.setAttribute(
      "aria-label",
      `Select scan for ${record.petName}, ${record.result}`
    );

    checkbox.style.width = "18px";
    checkbox.style.height = "18px";
    checkbox.style.minWidth = "18px";
    checkbox.style.flexShrink = "0";
    checkbox.style.cursor = isBulkDeleting
      ? "not-allowed"
      : "pointer";
    checkbox.style.margin = "0";

    checkbox.addEventListener("change", () => {
      if (checkbox.checked) {
        selectedScanPaths.add(record.path);
      } else {
        selectedScanPaths.delete(record.path);
      }

      // Update the selection controls without rebuilding the row.
      updateAdminControls();

      const visible = getVisibleScans();

      selectAllCheckbox.checked =
        visible.length > 0 &&
        visible.every((item) =>
          selectedScanPaths.has(item.path)
        );

      selectAllCheckbox.indeterminate =
        visible.some((item) =>
          selectedScanPaths.has(item.path)
        ) &&
        !selectAllCheckbox.checked;
    });

    // IMPORTANT: Checkbox is inserted before the picture.
    scan.appendChild(checkbox);
  }

  // Scan picture.
  scan.appendChild(buildThumb(record));

  // Pet and owner information.
  const scanInfo = el("div", "sr-scan-info");

  scanInfo.append(
    el("span", "sr-pet-name", record.petName),
    el(
      "span",
      "sr-owner-name",
      "Pet owner: " + record.ownerName
    )
  );

  scan.appendChild(scanInfo);
  scanCell.appendChild(scan);

  // ========================================
  // RESULT BADGE
  // ========================================

  const resultCell = document.createElement("td");

  if (
    record.category === "other" &&
    record.result === "Unknown"
  ) {
    resultCell.appendChild(
      el("span", "sr-muted", "Unknown")
    );
  } else {
    resultCell.appendChild(
      el(
        "span",
        "sr-badge sr-badge-" + record.category,
        record.result
      )
    );
  }

  // ========================================
  // CONFIDENCE BAR + PERCENTAGE
  // ========================================

  const confCell = document.createElement("td");

  if (record.confidenceNumber !== null) {
    const conf = el("div", "sr-conf");
    const bar = el("div", "sr-bar");
    const fill = el("div", "sr-bar-fill");

    fill.style.width = record.confidenceNumber + "%";

    bar.appendChild(fill);

    conf.append(
      bar,
      el("span", "", record.confidenceNumber + "%")
    );

    confCell.appendChild(conf);
  } else {
    confCell.appendChild(
      el("span", "sr-muted", record.confidenceText)
    );
  }

  // ========================================
  // DATE
  // ========================================

  const dateCell = el("td", "", record.dateText);

  // Preserve the original four-column table structure.
  row.append(
    scanCell,
    resultCell,
    confCell,
    dateCell
  );

  return row;
}


// ========================================
// BULK DELETE
// ========================================

async function deleteSelectedScans() {
  if (
    !["admin", "staff"].includes(currentRole) ||
    !selectionMode ||
    isBulkDeleting ||
    selectedScanPaths.size === 0
  ) {
    return;
  }

  const selectedRecords = allScans.filter((record) =>
    selectedScanPaths.has(record.path)
  );

  if (selectedRecords.length === 0) {
    selectedScanPaths.clear();
    render();

    window.alert("No scan records are selected.");
    return;
  }

  const confirmed = await window.SkinPawsibleDialogs.confirm(
    `Are you sure you want to delete ${selectedRecords.length} selected scan record(s)?\n\nThis action cannot be undone.`,
    { title: "Delete scan records?", confirmText: "Delete", tone: "danger" }
  );

  if (!confirmed) return;

  isBulkDeleting = true;
  updateAdminControls();

  let deletedCount = 0;

  try {
    // Firestore batches support at most 500 writes.
    // Use smaller batches to leave room for future changes.
    const batchSize = 450;

    for (
      let start = 0;
      start < selectedRecords.length;
      start += batchSize
    ) {
      const chunk = selectedRecords.slice(
        start,
        start + batchSize
      );

      const batch = writeBatch(db);

      chunk.forEach((record) => {
        // Uses the actual document reference captured
        // from collectionGroup("scans").
        batch.delete(record.ref);
      });

      await batch.commit();

      deletedCount += chunk.length;
    }

    selectedScanPaths.clear();
    selectionMode = false;

    window.alert(
      `Successfully deleted ${deletedCount} scan record(s).`
    );
  } catch (error) {
    console.error("Bulk scan deletion failed:", error);

    if (error.code === "permission-denied") {
      window.alert(
        "You do not have permission to delete these scan records. Check your Firestore Security Rules."
      );
    } else {
      window.alert(
        `Could not complete bulk deletion. ${deletedCount} record(s) were deleted before the error. Please refresh the records and check which scans remain.`
      );
    }
  } finally {
    isBulkDeleting = false;
    render();
  }
}


// ========================================
// SEARCH AND FILTERS
// ========================================

dateFilterToggle?.addEventListener("click", () => {
  const isExpanded = dateFilterToggle.getAttribute("aria-expanded") === "true";
  dateFilterToggle.setAttribute("aria-expanded", String(!isExpanded));
  dateFilterPanel.hidden = isExpanded;
});

document.addEventListener("click", (event) => {
  if (
    dateFilterPanel &&
    dateFilterToggle &&
    !dateFilterPanel.hidden &&
    !dateFilterPanel.contains(event.target) &&
    !dateFilterToggle.contains(event.target)
  ) {
    dateFilterPanel.hidden = true;
    dateFilterToggle.setAttribute("aria-expanded", "false");
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && dateFilterPanel && !dateFilterPanel.hidden) {
    dateFilterPanel.hidden = true;
    dateFilterToggle?.setAttribute("aria-expanded", "false");
    dateFilterToggle?.focus();
  }
});

if (searchInput) {
  searchInput.addEventListener("input", () => {
    searchText = searchInput.value;
    showAllScans = false;
    render();
  });
}

showMoreButton?.addEventListener("click", () => {
  showAllScans = !showAllScans;
  render();
});

filterButtons.forEach((button) => {
  button.addEventListener("click", () => {
    activeFilter = button.dataset.filter;
    showAllScans = false;

    filterButtons.forEach((filterButton) => {
      const isActive = filterButton === button;
      filterButton.classList.toggle(
        "active",
        isActive
      );
      filterButton.setAttribute("aria-pressed", String(isActive));
    });

    render();
  });
});

function setDateSort(direction) {
  dateSortDirection = direction;
  showAllScans = false;
  const newestFirst = direction === "desc";
  sortNewestButton?.classList.toggle("active", newestFirst);
  sortNewestButton?.setAttribute("aria-pressed", String(newestFirst));
  sortOldestButton?.classList.toggle("active", !newestFirst);
  sortOldestButton?.setAttribute("aria-pressed", String(!newestFirst));
  render();
}

sortNewestButton?.addEventListener("click", () => {
  setDateSort("desc");
});

sortOldestButton?.addEventListener("click", () => {
  setDateSort("asc");
});

dateFromInput?.addEventListener("change", () => {
  dateFrom = dateFromInput.value;
  showAllScans = false;
  dateFilterToggle?.classList.toggle("has-date-filter", Boolean(dateFrom || dateTo));
  render();
});

dateToInput?.addEventListener("change", () => {
  dateTo = dateToInput.value;
  showAllScans = false;
  dateFilterToggle?.classList.toggle("has-date-filter", Boolean(dateFrom || dateTo));
  render();
});

dateResetButton?.addEventListener("click", () => {
  dateFrom = "";
  dateTo = "";
  showAllScans = false;
  if (dateFromInput) dateFromInput.value = "";
  if (dateToInput) dateToInput.value = "";
  dateFilterToggle?.classList.remove("has-date-filter");
  render();
});

function formatDateInputValue(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

// ========================================
// IMAGE ZOOM AND PAN
// ========================================

function applyImageTransform() {
  if (imagePreview) {
    imagePreview.style.transform =
      `translate(${imagePanX}px, ${imagePanY}px) scale(${imageZoom})`;
  }
}

function constrainImagePan() {
  if (!imagePreview || !imageStage) return;

  const maxX = Math.max(
    0,
    (
      imagePreview.offsetWidth * imageZoom -
      imageStage.clientWidth
    ) / 2
  );

  const maxY = Math.max(
    0,
    (
      imagePreview.offsetHeight * imageZoom -
      imageStage.clientHeight
    ) / 2
  );

  imagePanX = Math.max(
    -maxX,
    Math.min(maxX, imagePanX)
  );

  imagePanY = Math.max(
    -maxY,
    Math.min(maxY, imagePanY)
  );
}

function setImageZoom(value) {
  imageZoom = Math.min(
    MAX_IMAGE_ZOOM,
    Math.max(MIN_IMAGE_ZOOM, value)
  );

  if (imageZoom <= 1) {
    imagePanX = 0;
    imagePanY = 0;
  } else {
    constrainImagePan();
  }

  applyImageTransform();

  imageStage?.classList.toggle(
    "is-zoomed",
    imageZoom > 1
  );

  if (imageZoomLevel) {
    imageZoomLevel.textContent =
      `${Math.round(imageZoom * 100)}%`;
  }
}

function resetImageZoom() {
  imagePanX = 0;
  imagePanY = 0;

  setImageZoom(1);
}

document
  .getElementById("scanImageZoomIn")
  ?.addEventListener("click", () => {
    setImageZoom(imageZoom + IMAGE_ZOOM_STEP);
  });

document
  .getElementById("scanImageZoomOut")
  ?.addEventListener("click", () => {
    setImageZoom(imageZoom - IMAGE_ZOOM_STEP);
  });

document
  .getElementById("scanImageZoomReset")
  ?.addEventListener("click", resetImageZoom);

imageStage?.addEventListener("pointerdown", (event) => {
  if (imageZoom <= 1 || event.button !== 0) return;

  imagePanPointer = event.pointerId;
  imageLastX = event.clientX;
  imageLastY = event.clientY;

  imageStage.classList.add("is-dragging");
  imageStage.setPointerCapture(event.pointerId);

  event.preventDefault();
});

imageStage?.addEventListener("pointermove", (event) => {
  if (event.pointerId !== imagePanPointer) return;

  imagePanX += event.clientX - imageLastX;
  imagePanY += event.clientY - imageLastY;

  imageLastX = event.clientX;
  imageLastY = event.clientY;

  constrainImagePan();
  applyImageTransform();
});

function stopImagePan(event) {
  if (event.pointerId !== imagePanPointer) return;

  if (imageStage?.hasPointerCapture(event.pointerId)) {
    imageStage.releasePointerCapture(event.pointerId);
  }

  imagePanPointer = null;
  imageStage?.classList.remove("is-dragging");
}

imageStage?.addEventListener("pointerup", stopImagePan);
imageStage?.addEventListener("pointercancel", stopImagePan);

imageDialogBody?.addEventListener(
  "wheel",
  (event) => {
    if (!imageDialog?.classList.contains("show")) return;

    event.preventDefault();

    setImageZoom(
      imageZoom +
      (event.deltaY < 0
        ? IMAGE_ZOOM_STEP
        : -IMAGE_ZOOM_STEP)
    );
  },
  { passive: false }
);

imageDialog?.addEventListener(
  "hidden.bs.modal",
  () => {
    resetImageZoom();

    imagePreview?.removeAttribute("src");

    if (imagePreview) {
      imagePreview.alt = "";
    }
  }
);


// ========================================
// DATE HELPERS
// ========================================

function parseScanDate(value) {
  if (!value) return null;

  if (typeof value.toDate === "function") {
    const date = value.toDate();

    return Number.isNaN(date.getTime())
      ? null
      : date;
  }

  if (typeof value === "number") {
    const date = new Date(
      value < 1e12 ? value * 1000 : value
    );

    return Number.isNaN(date.getTime())
      ? null
      : date;
  }

  if (typeof value !== "string") return null;

  const parsed = new Date(value);

  if (!Number.isNaN(parsed.getTime())) {
    return parsed;
  }

  const zonedTimestamp = value.match(
    /^(.+?)\s+at\s+(.+?)\s+UTC([+-])(\d{1,2})(?::?(\d{2}))?$/i
  );

  if (!zonedTimestamp) return null;

  const [
    ,
    datePart,
    timePart,
    sign,
    hours,
    minutes = "00"
  ] = zonedTimestamp;

  const offset =
    `${sign}${hours.padStart(2, "0")}${minutes.padStart(2, "0")}`;

  const zonedDate = new Date(
    `${datePart} ${timePart} GMT${offset}`
  );

  return Number.isNaN(zonedDate.getTime())
    ? null
    : zonedDate;
}

function getScanDate(scan) {
  for (const key of [
    "timestamp",
    "createdAt",
    "scanDate",
    "date",
    "dateCreated",
    "created_at"
  ]) {
    const date = parseScanDate(scan[key]);

    if (date) return date;
  }

  return null;
}


// ========================================
// CONFIDENCE HELPERS
// ========================================

function confidenceNumber(value) {
  if (
    value === undefined ||
    value === null ||
    value === ""
  ) {
    return null;
  }

  const n = typeof value === "number"
    ? value
    : Number(String(value).replace("%", "").trim());

  if (!Number.isFinite(n)) return null;

  const percent = n <= 1 ? n * 100 : n;

  return Math.max(
    0,
    Math.min(100, Math.round(percent))
  );
}

function formatConfidence(value) {
  if (
    value === undefined ||
    value === null ||
    value === ""
  ) {
    return "-";
  }

  if (
    typeof value === "number" &&
    Number.isFinite(value)
  ) {
    return `${Math.round(
      value <= 1 ? value * 100 : value
    )}%`;
  }

  const text = String(value).trim();
  const numericValue = Number(text);

  if (text && Number.isFinite(numericValue)) {
    return `${Math.round(
      numericValue <= 1
        ? numericValue * 100
        : numericValue
    )}%`;
  }

  return text || "-";
}


// ========================================
// SCAN IMAGE SOURCE
// ========================================

function getImageSource(scan) {
  if (
    typeof scan.imageUrl === "string" &&
    scan.imageUrl.trim()
  ) {
    const imageUrl = scan.imageUrl.trim();

    if (/^https:\/\//i.test(imageUrl)) {
      return imageUrl;
    }

    console.warn(
      "Ignoring a scan image URL that is not HTTPS."
    );

    return "";
  }

  if (
    typeof scan.imageBase64 !== "string" ||
    !scan.imageBase64.trim()
  ) {
    return "";
  }

  const image = scan.imageBase64.trim();

  if (
    /^data:image\/(?:png|jpe?g|webp|gif);base64,/i.test(image)
  ) {
    return image;
  }

  return `data:image/jpeg;base64,${image}`;
}
