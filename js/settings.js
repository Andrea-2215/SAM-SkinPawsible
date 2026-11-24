import { auth, db } from "./firebase-config.js";
import { getUserProfileSnapshot } from "./user-profile.js";
import { clearCachedAuthUserProfile } from "./auth-state.js";

import {
  onAuthStateChanged,
  updateProfile,
  updatePassword
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";

import {
  doc,
  setDoc
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";


// ========================================
// CURRENT USER
// ========================================

let currentUser = null;

function getRoleLabel(role) {
  const normalizedRole = String(role || "").toLowerCase().trim();

  return {
    admin: "Administrator",
    staff: "Staff",
    vet: "Veterinarian",
    veterinarian: "Veterinarian"
  }[normalizedRole] || "Not assigned";
}


// ========================================
// CHECK LOGGED-IN USER
// ========================================

onAuthStateChanged(auth, async (user) => {

  if (!user) {

    window.location.href =
      "login.html";

    return;

  }


  currentUser = user;

  let profile = {};
  let profileLoadFailed = false;
  try {
    const profileSnapshot = await getUserProfileSnapshot(user);
    if (profileSnapshot.exists()) {
      profile = profileSnapshot.data();
    }
  } catch (error) {
    profileLoadFailed = true;
    console.error("Error loading account role:", error);
  }


  // ========================================
  // DISPLAY USER INFORMATION
  // ========================================

  const displayName =
    profile.fullName ||
    profile.displayName ||
    user.displayName ||
    user.email?.split("@")[0] ||
    "User";


  const userNameElement =
    document.getElementById("userName");

  const userEmailElement =
    document.getElementById("userEmail");

  const userInitialElement =
    document.getElementById("userInitial");

  const fullNameInput =
    document.getElementById("fullName");

  const emailInput =
    document.getElementById("email");

  const roleInput =
    document.getElementById("accountRole");


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


  if (fullNameInput) {
    fullNameInput.value =
      displayName;
  }


  if (emailInput) {
    emailInput.value =
      user.email || "";
  }

  if (roleInput) {
    roleInput.value = profileLoadFailed
      ? "Unable to load role"
      : getRoleLabel(profile.role);
  }

  window.HeaderActions?.setUser({
    name: displayName,
    email: profile.email || user.email || "",
    role: profileLoadFailed
      ? "Role unavailable"
      : getRoleLabel(profile.role)
  });

});


// ========================================
// UPDATE PROFILE
// ========================================

const profileForm =
  document.getElementById("profileForm");


if (profileForm) {

  profileForm.addEventListener(
    "submit",
    async (e) => {

      e.preventDefault();


      if (!currentUser) {
        return;
      }


      const fullName =
        document
          .getElementById("fullName")
          .value
          .trim();


      const saveButton =
        document.getElementById(
          "saveProfileBtn"
        );


      try {

        if (saveButton) {

          saveButton.disabled = true;

          saveButton.textContent =
            "Saving...";

        }


        // Update Firebase Authentication profile
        await updateProfile(
          currentUser,
          {
            displayName: fullName
          }
        );


        // Update Firestore user document
        await setDoc(
          doc(
            db,
            "users",
            currentUser.uid
          ),
          {
            fullName: fullName,
            email: currentUser.email || ""
          },
          {
            merge: true
          }
        );
        clearCachedAuthUserProfile(currentUser);


        // Update sidebar
        const userNameElement = document.getElementById("userName");
        if (userNameElement) {
          userNameElement.textContent = fullName;
        }


        const userInitialElement = document.getElementById("userInitial");
        if (userInitialElement) {
          userInitialElement.textContent = fullName.charAt(0).toUpperCase();
        }

        window.HeaderActions?.setUser({
          name: fullName,
          email: currentUser.email || ""
        });


        alert(
          "Profile updated successfully!"
        );


      } catch (error) {

        console.error(
          "Error updating profile:",
          error
        );


        alert(
          "Failed to update profile: " +
          error.message
        );


      } finally {

        if (saveButton) {

          saveButton.disabled = false;

          saveButton.textContent =
            "Save Changes";

        }

      }

    }
  );

}
// ========================================
// CHANGE PASSWORD
// ========================================

const passwordForm =
  document.getElementById(
    "passwordForm"
  );


if (passwordForm) {

  passwordForm.addEventListener(
    "submit",
    async (e) => {

      e.preventDefault();


      if (!currentUser) {
        return;
      }


      const newPassword =
        document
          .getElementById("newPassword")
          .value;


      const confirmPassword =
        document
          .getElementById("confirmPassword")
          .value;


      if (
        newPassword !==
        confirmPassword
      ) {

        alert(
          "Passwords do not match."
        );

        return;

      }


      if (newPassword.length < 6) {

        alert(
          "Password must be at least 6 characters."
        );

        return;

      }


      const changeButton =
        document.getElementById(
          "changePasswordBtn"
        );


      try {

        if (changeButton) {

          changeButton.disabled = true;

          changeButton.textContent =
            "Updating...";

        }


        await updatePassword(
          currentUser,
          newPassword
        );


        alert(
          "Password changed successfully!"
        );


        passwordForm.reset();


      } catch (error) {

        console.error(
          "Password update error:",
          error
        );


        if (
          error.code ===
          "auth/requires-recent-login"
        ) {

          alert(
            "For security, please log out and log in again before changing your password."
          );

        } else {

          alert(
            "Failed to change password: " +
            error.message
          );

        }

      } finally {

        if (changeButton) {

          changeButton.disabled = false;

          changeButton.textContent =
            "Change Password";

        }

      }

    }
  );

}
