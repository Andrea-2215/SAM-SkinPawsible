import { auth } from "./firebase-config.js";
import { redirectSuperadminFromSensitivePage } from "./auth-state.js";
import { getUserProfileSnapshot } from "./user-profile.js";

import {
  onAuthStateChanged,
  signOut
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";

const STAFF_ROLES = new Set([
  "admin",
  "staff",
  "vet",
  "veterinarian",
  "superadmin"
]);

export function watchActiveStaffPage(
  onAuthorized,
  onError = (error) => console.error("Could not verify staff access:", error)
) {
  return onAuthStateChanged(auth, async (user) => {
    if (!user) {
      window.location.href = "login.html";
      return;
    }

    let profile;
    let role;

    try {
      const profileSnapshot = await getUserProfileSnapshot(user);
      profile = profileSnapshot.exists() ? profileSnapshot.data() : null;
      role = String(profile?.role || "").toLowerCase().trim();
      const status = String(profile?.status || "active").toLowerCase().trim();

      if (redirectSuperadminFromSensitivePage(user, role)) return;

      if (!profile || !STAFF_ROLES.has(role) || status !== "active") {
        await signOut(auth);
        window.location.href = "login.html";
        return;
      }
    } catch (error) {
      onError(error);
      await signOut(auth);
      window.location.href = "login.html";
      return;
    }

    onAuthorized({ user, profile, role });
  });
}
