import { auth } from "./firebase-config.js";
import { getUserProfileSnapshot } from "./user-profile.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import { initializeRolePermissionsPage } from "../utils/roles.js?v=3";

onAuthStateChanged(auth, async (user) => {
  if (!user) { window.location.href = "login.html"; return; }
  try {
    const profile = await getUserProfileSnapshot(user);
    const role = String(profile.data()?.role || "").toLowerCase().trim();
    const status = String(profile.data()?.status || "active").toLowerCase().trim();
    if (!profile.exists() || role !== "superadmin" || status !== "active") {
      window.alert("Access denied. IT Administrator access only.");
      window.location.href = "users.html";
      return;
    }
    await initializeRolePermissionsPage(user);
  } catch (error) {
    console.error("Could not load role permissions:", error);
    window.alert("Could not initialize role permissions. Check Firestore access and try again.");
    window.location.href = "users.html";
  }
});
