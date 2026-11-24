import { auth, db } from "./firebase-config.js";

import {
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import { getUserProfileSnapshot } from "./user-profile.js";

import {
  collection,
  getDocs,
  query,
  where
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";


// ========================================
// CHECK LOGGED-IN USER
// ========================================

onAuthStateChanged(auth, async (user) => {

  if (!user) {
    window.location.href = "login.html";
    return;
  }

  const profileSnapshot = await getUserProfileSnapshot(user);
  const role = profileSnapshot.exists()
    ? String(profileSnapshot.data().role || "").trim().toLowerCase()
    : "";

  if (!["admin", "staff"].includes(role)) {
    window.location.replace("users.html");
    return;
  }


  // ========================================
  // DISPLAY USER INFORMATION
  // ========================================

  const displayName =
    user.displayName || "User";


  const userNameElement =
    document.getElementById("userName");

  const userEmailElement =
    document.getElementById("userEmail");

  const userInitialElement =
    document.getElementById("userInitial");


  if (userNameElement) {
    userNameElement.textContent =
      displayName;
  }


  if (userEmailElement) {
    userEmailElement.textContent =
      user.email || "";
  }


  if (userInitialElement) {
    userInitialElement.textContent =
      displayName.charAt(0).toUpperCase();
  }


  // Load SMS logs
  await loadSMSLogs(user.uid);

});


// ========================================
// LOAD SMS LOGS
// ========================================

async function loadSMSLogs(userId) {

  const table =
    document.getElementById("smsLogsTable");


  if (!table) {
    return;
  }


  try {

    const smsQuery =
      query(
        collection(db, "smsLogs"),
        where("userId", "==", userId)
      );


    const snapshot =
      await getDocs(smsQuery);


    // ========================================
    // NO SMS LOGS
    // ========================================

    if (snapshot.empty) {

      table.innerHTML = `
        <tr>

          <td
            colspan="5"
            class="text-center"
          >
            No SMS logs yet.
          </td>

        </tr>
      `;

      return;

    }


    table.innerHTML = "";


    // ========================================
    // DISPLAY SMS LOGS
    // ========================================

    snapshot.forEach((docSnap) => {

      const sms =
        docSnap.data();


      const recipient =
        sms.recipient ||
        sms.phoneNumber ||
        "-";


      const message =
        sms.message ||
        "-";


      const date =
        sms.date ||
        sms.sentAt ||
        "-";


      const type =
        sms.type ||
        "Notification";


      const status =
        sms.status ||
        "Pending";


      // ========================================
      // STATUS STYLE
      // ========================================

      let statusClass =
        "bg-warning text-dark";


      if (
        status.toLowerCase() === "sent"
      ) {

        statusClass =
          "bg-success";

      }


      if (
        status.toLowerCase() === "delivered"
      ) {

        statusClass =
          "bg-success";

      }


      if (
        status.toLowerCase() === "failed"
      ) {

        statusClass =
          "bg-danger";

      }


      table.innerHTML += `

        <tr>

          <td>
            ${escapeHTML(recipient)}
          </td>


          <td>
            ${escapeHTML(message)}
          </td>


          <td>
            ${escapeHTML(date)}
          </td>


          <td>
            ${escapeHTML(type)}
          </td>


          <td>

            <span
              class="badge ${statusClass}"
            >
              ${escapeHTML(status)}
            </span>

          </td>

        </tr>

      `;

    });


  } catch (error) {

    console.error(
      "Error loading SMS logs:",
      error
    );


    table.innerHTML = `

      <tr>

        <td
          colspan="5"
          class="text-danger text-center"
        >
          Could not load SMS logs.
        </td>

      </tr>

    `;

  }

}


// ========================================
// ESCAPE HTML
// ========================================

function escapeHTML(value) {

  const div =
    document.createElement("div");

  div.textContent =
    String(value);

  return div.innerHTML;

}
