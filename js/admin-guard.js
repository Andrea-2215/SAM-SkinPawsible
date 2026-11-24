// ==========================================================
// SKINPAWSIBLE ADMIN PAGE PROTECTION
// ==========================================================

import { auth } from "./firebase-config.js";
import { getUserProfileSnapshot } from "./user-profile.js";

import {
    onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";

onAuthStateChanged(auth, async (user) => {

    // ======================================================
    // NOT LOGGED IN
    // ======================================================

    if (!user) {
        window.location.href = "login.html";
        return;
    }


    try {

        // Get current user's Firestore document
        const userSnap = await getUserProfileSnapshot(user);


        // ==================================================
        // USER DOCUMENT NOT FOUND
        // ==================================================

        if (!userSnap.exists()) {

            alert("User account information was not found.");

            window.location.href = "users.html";

            return;
        }


        // ==================================================
        // GET ROLE
        // ==================================================

        const userData = userSnap.data();

        const role = String(userData.role || "")
            .toLowerCase()
            .trim();
        const status = String(userData.status || "active")
            .toLowerCase()
            .trim();


        console.log("Admin Guard - User:", user.email);
        console.log("Admin Guard - Role:", role);


        // ==================================================
        // CHECK ADMIN
        // ==================================================

        if (!["admin", "superadmin"].includes(role) || status !== "active") {

            alert("Access denied. Administrator access only.");

            window.location.href = "users.html";

            return;
        }


        // ==================================================
        // ADMIN ACCESS GRANTED
        // ==================================================

        console.log("Admin access granted.");

    } catch (error) {

        console.error(
            "Admin access check failed:",
            error
        );

        alert("Unable to verify your account.");

        window.location.href = "users.html";
    }

});
