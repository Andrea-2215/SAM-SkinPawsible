import { auth, db } from "./firebase-config.js";
import {
  createUserWithEmailAndPassword,
  updateProfile,
  sendEmailVerification
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import {
  doc,
  setDoc,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

const form = document.getElementById("registerForm");
const formError = document.getElementById("formError");
const registerBtn = document.getElementById("registerBtn");
const registerBtnText = document.getElementById("registerBtnText");
const registerSpinner = document.getElementById("registerSpinner");

function showToast(message, type = "info") {
  const toastEl = document.getElementById("appToast");
  const toastBody = document.getElementById("appToastBody");
  toastEl.classList.remove("success", "error", "info");
  toastEl.classList.add(type);
  toastBody.textContent = message;
  const toast = new bootstrap.Toast(toastEl, { delay: 4000 });
  toast.show();
}

function showError(message) {
  formError.textContent = message;
  formError.style.display = "block";
}

function clearError() {
  formError.style.display = "none";
  formError.textContent = "";
}

function setLoading(isLoading) {
  registerBtn.disabled = isLoading;
  registerSpinner.style.display = isLoading ? "inline-block" : "none";
  registerBtnText.textContent = isLoading ? "Creating account..." : "Request access";
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  clearError();

  const fullName = document.getElementById("fullName").value.trim();
  const email = document.getElementById("email").value.trim().toLowerCase();
  const contactNumber = document.getElementById("contactNumber").value.trim();
  const password = document.getElementById("password").value;
  const confirmPassword = document.getElementById("confirmPassword").value;

  if (!fullName || !email || !contactNumber || !password || !confirmPassword) {
    showError("Please fill in all fields.");
    return;
  }

  if (!/^[0-9]{10}$/.test(contactNumber)) {
    showError("Enter a 10-digit contact number after +63.");
    return;
  }

  if (fullName.length > 120 || email.length > 254) {
    showError("Full name must be 120 characters or fewer and email must be 254 characters or fewer.");
    return;
  }

  if (password.length < 6) {
    showError("Password must be at least 6 characters.");
    return;
  }

  if (password !== confirmPassword) {
    showError("Passwords do not match.");
    return;
  }

  setLoading(true);
  let accountCreated = false;
  let approvalNotificationCreated = false;
  let verificationEmailSent = false;

  try {
    // 1. Create the real Firebase Authentication account.
    const cred = await createUserWithEmailAndPassword(auth, email, password);
    accountCreated = true;

    // 2. Save the user's display name in Firebase Auth.
    await updateProfile(cred.user, { displayName: fullName });

    // 3. Save the user's application profile in Firestore.
    await setDoc(doc(db, "users", cred.user.uid), {
      fullName,
      email,
      contactNumber: `+63${contactNumber}`,
      role: "pending",
      status: "Pending",
      createdAt: serverTimestamp()
    });

    // 4. Notify admins that this account is waiting for authorization.
    const notificationId = `account_created_${cred.user.uid}`;
    await setDoc(doc(db, "notifications", notificationId), {
      title: "New web account needs approval",
      message: `${fullName} (${email}) requested web access. Review and approve this account in Users.`,
      type: "SYSTEM",
      targetScreen: "USERS",
      targetId: cred.user.uid,
      sourceUserId: cred.user.uid,
      senderName: fullName,
      senderEmail: email,
      recipientRole: "webAdmin",
      isRead: false,
      readBy: [],
      dismissedBy: [],
      deletedBy: [],
      timestamp: new Date().toLocaleString(),
      createdAtMillis: Date.now(),
      createdAt: serverTimestamp()
    });
    approvalNotificationCreated = true;

    try {
      await sendEmailVerification(cred.user);
      verificationEmailSent = true;
    } catch (verificationError) {
      console.error("Could not send registration verification email:", verificationError);
    }

    await auth.signOut();

    showToast(
      verificationEmailSent
        ? "Account created. Verify your email, then wait for administrator approval before logging in."
        : "Account created, but the verification email could not be sent. Try logging in later to request another email.",
      verificationEmailSent ? "success" : "error"
    );
    form.reset();

    setTimeout(() => {
      window.location.href = "login.html";
    }, 3500);
  } catch (err) {
    console.error("Registration error:", err);
    setLoading(false);

    if (accountCreated) {
      if (auth.currentUser) {
        try {
          await auth.signOut();
        } catch (signOutError) {
          console.error("Could not sign out after registration:", signOutError);
        }
      }

      showError(
        approvalNotificationCreated
          ? "Your account and approval request were created, but we couldn't finish signing you out. Please return to the login page."
          : "Your account was created, but the administrator approval alert could not be sent. Please contact the administrator before trying again."
      );
      return;
    }

    showError(mapAuthError(err));
  }
});

function mapAuthError(err) {
  switch (err?.code) {
    case "auth/email-already-in-use":
      return "An account with this email already exists.";
    case "auth/invalid-email":
      return "That email address looks invalid.";
    case "auth/weak-password":
      return "Password is too weak. Use at least 6 characters.";
    case "auth/operation-not-allowed":
      return "Email/password registration is disabled in Firebase Authentication. Enable it in Firebase Console.";
    case "auth/network-request-failed":
      return "Network error. Check your internet connection and try again.";
    case "permission-denied":
    case "firestore/permission-denied":
      return "The account was created, but Firestore rejected the profile. Check your Firestore security rules.";
    default:
      return err?.message || "Something went wrong. Please try again.";
  }
}
