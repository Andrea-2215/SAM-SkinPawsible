import { db } from "./firebase-config.js";
import {
  cacheAuthUserProfile,
  getCachedAuthUserProfile,
  setAuthUserRole
} from "./auth-state.js";

import {
  doc,
  getDoc
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

const profileRequests = new Map();

function createCachedProfileSnapshot(uid, profile) {
  return {
    id: uid,
    exists: () => true,
    data: () => ({ ...profile })
  };
}

export function getUserProfileSnapshot(user) {
  if (!user?.uid) {
    return Promise.reject(new Error("A signed-in user is required."));
  }

  const existingRequest = profileRequests.get(user.uid);
  if (existingRequest) return existingRequest;

  const cachedProfile = getCachedAuthUserProfile(user);
  if (cachedProfile) {
    return Promise.resolve(createCachedProfileSnapshot(user.uid, cachedProfile));
  }

  const request = getDoc(doc(db, "users", user.uid))
    .then((snapshot) => {
      if (snapshot.exists()) {
        const profile = snapshot.data();
        setAuthUserRole(user, profile.role, profile);
        cacheAuthUserProfile(user, profile);
      }
      return snapshot;
    })
    .catch((error) => {
      profileRequests.delete(user.uid);
      throw error;
    });

  profileRequests.set(user.uid, request);
  return request;
}
