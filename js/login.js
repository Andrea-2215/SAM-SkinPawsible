import { auth, db } from "./firebase-config.js";
import {
  cacheAuthUserProfile,
  clearAuthUserRole,
  setAuthUserRole
} from "./auth-state.js";
import {
  signInWithEmailAndPassword,
  sendPasswordResetEmail,
  sendEmailVerification
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import {
  doc,
  getDoc
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

const form = document.getElementById("loginForm");
const formError = document.getElementById("formError");
const loginBtn = document.getElementById("loginBtn");
const loginBtnText = document.getElementById("loginBtnText");
const loginSpinner = document.getElementById("loginSpinner");
const forgotLink = document.getElementById("forgotLink");

function showError(message) {
  formError.textContent = message;
  formError.style.display = "block";
}

function clearError() {
  formError.style.display = "none";
  formError.textContent = "";
}

function showToast(message, type = "success") {
  const toastEl = document.getElementById("appToast");
  document.getElementById("appToastBody").textContent = message;
  toastEl.classList.remove("success", "error", "info");
  toastEl.classList.add(type);
  bootstrap.Toast.getOrCreateInstance(toastEl, { delay: 4500 }).show();
}

function setLoading(isLoading) {
  loginBtn.disabled = isLoading;
  loginSpinner.style.display = isLoading ? "inline-block" : "none";
  loginBtnText.textContent = isLoading ? "Logging in..." : "Log in";
}

/* ---------------- LOGIN ---------------- */
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  clearError();

  const email = document.getElementById("email").value.trim().toLowerCase();
  const password = document.getElementById("password").value;

  if (!email || !password) {
    showError("Please enter your email and password.");
    return;
  }

  setLoading(true);
  let signedInUser = null;

  try {
    const cred = await signInWithEmailAndPassword(auth, email, password);
    signedInUser = cred.user;

    if (!cred.user.emailVerified) {
      let verificationSent = false;
      try {
        await sendEmailVerification(cred.user);
        verificationSent = true;
      } catch (verificationError) {
        console.error("Could not resend email verification:", verificationError);
      }

      await auth.signOut();
      signedInUser = null;
      setLoading(false);
      showError(
        verificationSent
          ? "Please verify your email using the link we sent, then log in again. If it does not arrive, check your spam folder."
          : "Your email is not verified, and we could not send a verification link. Try again later."
      );
      return;
    }

    const profileSnap = await getDoc(doc(db, "users", cred.user.uid));
    const profile = profileSnap.exists() ? profileSnap.data() : null;
    const role = String(profile?.role || "").toLowerCase();
    const status = String(profile?.status || "active").toLowerCase();

    if (
      !["admin", "staff", "vet", "veterinarian", "superadmin"].includes(role) ||
      status !== "active"
    ) {
      clearAuthUserRole();
      await auth.signOut();
      signedInUser = null;
      setLoading(false);
      showError("This account is not authorized for the web console. Contact the administrator.");
      return;
    }

    // Make the profile role available immediately to every page/component
    // that receives this authenticated Firebase user.
    setAuthUserRole(cred.user, role, profile);
    cacheAuthUserProfile(cred.user, profile);
    localStorage.setItem("userRole", role);
    localStorage.setItem(
      "userName",
      profile.fullName || profile.displayName || cred.user.displayName || email.split("@")[0]
    );
    localStorage.setItem("userEmail", profile.email || cred.user.email || email);
    localStorage.setItem(
      "userRoleLabel",
      {
        admin: "Administrator",
        staff: "Staff",
        vet: "Veterinarian",
        veterinarian: "Veterinarian",
        superadmin: "IT Administrator"
      }[role] || "Clinic account"
    );

    window.location.href = role === "superadmin"
      ? "users.html"
      : "dashboard.html";
  } catch (err) {
    console.error("Login error:", err);
    if (signedInUser) {
      await auth.signOut();
    }
    setLoading(false);
    showError(mapAuthError(err));
  }
});

/* ---------------- FORGOT PASSWORD ---------------- */
forgotLink.addEventListener("click", async (e) => {
  e.preventDefault();
  clearError();

  const email = document.getElementById("email").value.trim().toLowerCase();

  if (!email) {
    showError("Enter your email above first, then click Forgot password.");
    document.getElementById("email").focus();
    return;
  }

  try {
    await sendPasswordResetEmail(auth, email);
    showToast("If an account exists for that email, a reset link has been sent.", "success");
  } catch (err) {
    console.error("Reset error:", err);
    showError(mapAuthError(err));
  }
});

/* ---------------- ERROR MESSAGES ---------------- */
function mapAuthError(err) {
  switch (err?.code) {
    case "auth/invalid-credential":
    case "auth/wrong-password":
      return "Incorrect email or password.";
    case "auth/user-not-found":
      return "No account found with that email.";
    case "auth/invalid-email":
      return "That email address looks invalid.";
    case "auth/missing-email":
      return "Please enter your email address.";
    case "auth/too-many-requests":
      return "Too many attempts. Please wait and try again.";
    case "auth/user-disabled":
      return "This account has been disabled.";
    case "permission-denied":
    case "firestore/permission-denied":
      return "Login succeeded, but Firestore denied access to your profile. Check your Firestore security rules.";
    case "auth/network-request-failed":
      return "Network error. Check your internet connection and try again.";
    default:
      return err?.message || "Something went wrong. Please try again.";
  }
}
