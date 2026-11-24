import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, beforeEach, test } from "node:test";
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment
} from "@firebase/rules-unit-testing";
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  getDocsFromServer,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where
} from "firebase/firestore";

const projectId = "demo-skinpawsible-security";
const primarySuperadminUid = "4uIUNYTrBtNm3w2UhlmcFZKHHJk2";
const recentAuthTime = Math.floor(Date.now() / 1000);
let testEnvironment;

before(async () => {
  testEnvironment = await initializeTestEnvironment({
    projectId,
    firestore: {
      rules: readFileSync(
        new URL("../../current-firestore.rules", import.meta.url),
        "utf8"
      )
    }
  });
});

after(async () => {
  await testEnvironment?.cleanup();
});

beforeEach(async () => {
  await testEnvironment.clearFirestore();
  await testEnvironment.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await Promise.all([
      setDoc(doc(db, "users", "admin"), {
        role: "admin",
        status: "Active"
      }),
      setDoc(doc(db, "users", "superadmin"), {
        role: "superadmin",
        status: "Active"
      }),
      setDoc(doc(db, "users", primarySuperadminUid), {
        role: "superadmin",
        status: "Active"
      }),
      setDoc(doc(db, "users", "vet"), {
        role: "vet",
        status: "Active"
      }),
      setDoc(doc(db, "users", "target"), {
        role: "staff",
        status: "Active"
      }),
      setDoc(doc(db, "users", "approved-pet-owner"), {
        role: "petOwner",
        status: "Active"
      }),
      setDoc(doc(db, "users", "pet-owner"), {
        role: "petowner",
        status: "Active"
      }),
      setDoc(doc(db, "users", "pet-owner-staff"), {
        role: "pet owner",
        status: "Active"
      }),
      setDoc(doc(db, "users", "pet-owner-vet"), {
        role: "Pet Owner",
        status: "Active"
      }),
      setDoc(doc(db, "system_settings", "security"), {
        requireRecentLogin: true,
        roleNotifications: true,
        adminPasswordResets: false,
        updatedAt: new Date()
      }),
      setDoc(doc(db, "notifications", "vet-access"), {
        userId: "vet",
        type: "WEB_USER_ACCESS_CHANGED",
        isRead: false
      }),
      setDoc(doc(db, "notifications", "other-access"), {
        userId: "target",
        type: "WEB_USER_ACCESS_CHANGED",
        isRead: false
      })
    ]);
  });
});

function authenticatedDb(uid, authTime = recentAuthTime) {
  return testEnvironment.authenticatedContext(uid, {
    auth_time: authTime,
    email_verified: true
  }).firestore();
}

test("clinic staff and assigned veterinarians can post appointment events", async () => {
  await testEnvironment.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await Promise.all([
      setDoc(doc(db, "chatRooms", "standard"), {
        petOwnerId: "pet-owner",
        participants: ["pet-owner", "admin"],
        chat_status: "STANDARD",
        lastMessage: ""
      }),
      setDoc(doc(db, "chatRooms", "escalated"), {
        petOwnerId: "pet-owner",
        participants: ["pet-owner", "vet"],
        chat_status: "ESCALATED",
        escalatedVetId: "vet",
        escalatedVetName: "Dr. Vet",
        lastMessage: ""
      })
    ]);
  });

  const appointmentEvent = (senderId) => ({
    senderId,
    sender_type: "clinic",
    type: "appointment_event",
    kind: "appointment_event",
    text: "Appointment approved"
  });

  await assertSucceeds(
    setDoc(
      doc(authenticatedDb("admin"), "chatRooms", "standard", "messages", "admin-event"),
      appointmentEvent("admin")
    )
  );
  await assertSucceeds(
    setDoc(
      doc(authenticatedDb("target"), "chatRooms", "standard", "messages", "staff-event"),
      appointmentEvent("target")
    )
  );
  await assertSucceeds(
    setDoc(
      doc(authenticatedDb("vet"), "chatRooms", "escalated", "messages", "vet-event"),
      appointmentEvent("vet")
    )
  );
  await assertSucceeds(
    updateDoc(doc(authenticatedDb("vet"), "chatRooms", "escalated"), {
      lastMessage: "Appointment completed",
      lastMessageAt: serverTimestamp(),
      lastMessageInternal: false
    })
  );
  await assertFails(
    setDoc(
      doc(authenticatedDb("vet"), "chatRooms", "standard", "messages", "vet-standard-event"),
      appointmentEvent("vet")
    )
  );
});

test("clinic staff can create only canonical reschedule slot locks", async () => {
  const staffDb = authenticatedDb("target");
  const slot = {
    ownerId: "approved-pet-owner",
    appointmentId: "replacement-appointment",
    consultationId: "replacement-appointment",
    date: "2026-11-20",
    time: "14:30",
    source: "web_reschedule",
    createdBy: "target",
    createdAt: serverTimestamp()
  };

  await assertSucceeds(
    setDoc(doc(staffDb, "bookedSlots", "2026-11-20_14:30"), slot)
  );
  await assertSucceeds(
    setDoc(
      doc(authenticatedDb("superadmin"), "bookedSlots", "2026-11-21_09:15"),
      {
        ...slot,
        date: "2026-11-21",
        time: "09:15",
        createdBy: "superadmin"
      }
    )
  );
  await assertFails(
    setDoc(doc(staffDb, "bookedSlots", "not-the-slot"), slot)
  );
  await assertFails(
    setDoc(
      doc(staffDb, "bookedSlots", "2026-11-20_14:30_extra"),
      { ...slot, source: "other" }
    )
  );
  await assertFails(
    setDoc(
      doc(staffDb, "bookedSlots", "2026-11-20_25:90"),
      { ...slot, time: "25:90" }
    )
  );

  const ownerDb = authenticatedDb("approved-pet-owner");
  await assertSucceeds(
    setDoc(doc(ownerDb, "bookedSlots", "owner-created-slot"), {
      ownerId: "approved-pet-owner"
    })
  );
  await assertFails(
    setDoc(doc(ownerDb, "bookedSlots", "another-owner-slot"), {
      ownerId: "target"
    })
  );
});

test("self-registration can create the expected pending user profile", async () => {
  const registrationDb = testEnvironment.authenticatedContext("new-user", {
    auth_time: recentAuthTime,
    email: "new-user@example.com"
  }).firestore();

  await assertSucceeds(
    setDoc(doc(registrationDb, "users", "new-user"), {
      fullName: "New User",
      email: "new-user@example.com",
      contactNumber: "+639123456789",
      role: "pending",
      status: "Pending",
      createdAt: serverTimestamp()
    })
  );
});

test("unverified clinic accounts cannot access active clinic data", async () => {
  const unverifiedAdminDb = testEnvironment.authenticatedContext("admin", {
    auth_time: recentAuthTime,
    email_verified: false
  }).firestore();

  await assertFails(getDocs(collection(unverifiedAdminDb, "appointments")));
  await assertSucceeds(getDocs(collection(authenticatedDb("admin"), "appointments")));
});

test("clinic admins cannot read superadmin profiles, but can query other users", async () => {
  const adminDb = authenticatedDb("admin");
  const vetDb = authenticatedDb("vet");

  await assertFails(getDoc(doc(adminDb, "users", "superadmin")));
  await assertFails(getDocs(query(
    collection(adminDb, "users"),
    where("role", "==", "superadmin")
  )));
  await assertFails(getDocsFromServer(collection(adminDb, "users")));
  await assertSucceeds(getDoc(doc(adminDb, "users", "target")));
  const visibleUsers = await getDocs(query(
      collection(adminDb, "users"),
      where("role", "!=", "superadmin")
    ));
  assert.ok(
    visibleUsers.docs.every((userDoc) => userDoc.data().role !== "superadmin")
  );
  const petOwners = await assertSucceeds(getDocs(query(
    collection(adminDb, "users"),
    where("role", "in", [
      "owner",
      "user",
      "pet owner",
      "petOwner",
      "petowner",
      "pet_owner",
      "Pet Owner",
      "Pet owner"
    ])
  )));
  assert.ok(petOwners.docs.every((userDoc) => [
    "owner",
    "user",
    "pet owner",
    "petOwner",
    "petowner",
    "pet_owner",
    "Pet Owner",
    "Pet owner"
  ].includes(userDoc.data().role)));
  assert.ok(petOwners.docs.some((userDoc) => userDoc.id === "approved-pet-owner"));
  await assertSucceeds(getDoc(doc(vetDb, "users", "superadmin")));
  await assertSucceeds(
    getDocsFromServer(collection(authenticatedDb("superadmin"), "users"))
  );
});

test("recent authentication permits active admins and superadmins to change access", async () => {
  const adminDb = authenticatedDb("admin");
  const superadminDb = authenticatedDb("superadmin");

  await assertSucceeds(
    updateDoc(doc(adminDb, "users", "target"), { role: "vet" })
  );
  await assertSucceeds(
    updateDoc(doc(superadminDb, "users", "target"), { status: "Inactive" })
  );
});

test("clinic admins and staff can delete pet-owner profiles only", async () => {
  const adminDb = authenticatedDb("admin");
  const staffDb = authenticatedDb("target");
  const vetDb = authenticatedDb("vet");

  await assertSucceeds(deleteDoc(doc(adminDb, "users", "pet-owner")));
  await assertSucceeds(deleteDoc(doc(staffDb, "users", "pet-owner-staff")));
  await assertFails(deleteDoc(doc(vetDb, "users", "pet-owner-vet")));
  await assertFails(deleteDoc(doc(adminDb, "users", "target")));
  await assertFails(deleteDoc(doc(adminDb, "users", "admin")));
  await assertFails(deleteDoc(doc(adminDb, "users", "superadmin")));
});

test("the primary superadmin profile cannot be deleted", async () => {
  const superadminDb = authenticatedDb("superadmin");

  await assertFails(
    deleteDoc(doc(superadminDb, "users", primarySuperadminUid))
  );
});

test("stale authentication blocks role and status changes but not profile edits", async () => {
  const staleAdminDb = authenticatedDb(
    "admin",
    Math.floor(Date.now() / 1000) - 600
  );
  const staleDb = authenticatedDb(
    "superadmin",
    Math.floor(Date.now() / 1000) - 600
  );

  await assertFails(
    updateDoc(doc(staleAdminDb, "users", "target"), { role: "vet" })
  );
  await assertFails(
    updateDoc(doc(staleDb, "users", "target"), { role: "vet" })
  );
  await assertFails(
    updateDoc(doc(staleDb, "users", "target"), { status: "Inactive" })
  );
  await assertSucceeds(
    updateDoc(doc(staleDb, "users", "target"), { fullName: "Updated Name" })
  );
});

test("recent authentication is required to save valid security settings", async () => {
  const superadminDb = authenticatedDb("superadmin");
  const adminDb = authenticatedDb("admin");
  const settings = {
    requireRecentLogin: false,
    roleNotifications: true,
    adminPasswordResets: true,
    updatedAt: serverTimestamp()
  };

  await assertSucceeds(
    setDoc(doc(superadminDb, "system_settings", "security"), settings)
  );
  await assertFails(
    setDoc(doc(adminDb, "system_settings", "security"), settings)
  );
  await assertFails(
    setDoc(doc(superadminDb, "system_settings", "security"), {
      ...settings,
      roleNotifications: "yes"
    })
  );
  const staleSuperadminDb = authenticatedDb(
    "superadmin",
    Math.floor(Date.now() / 1000) - 600
  );
  await assertFails(
    setDoc(doc(staleSuperadminDb, "system_settings", "security"), settings)
  );
});

test("disabling recent-login enforcement permits stale access changes", async () => {
  await testEnvironment.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), "system_settings", "security"), {
      requireRecentLogin: false,
      roleNotifications: true,
      adminPasswordResets: false,
      updatedAt: new Date()
    });
  });
  const staleDb = authenticatedDb(
    "superadmin",
    Math.floor(Date.now() / 1000) - 600
  );

  await assertSucceeds(
    updateDoc(doc(staleDb, "users", "target"), { role: "vet" })
  );
});

test("recent authentication is required to update role permissions", async () => {
  const staleDb = authenticatedDb(
    "superadmin",
    Math.floor(Date.now() / 1000) - 600
  );

  await assertFails(
    setDoc(doc(staleDb, "roles", "staff"), {
      roleName: "Staff",
      permissions: {}
    })
  );
});

test("disabling recent-login enforcement permits stale role-permission updates", async () => {
  await testEnvironment.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), "system_settings", "security"), {
      requireRecentLogin: false,
      roleNotifications: true,
      adminPasswordResets: false,
      updatedAt: new Date()
    });
  });
  const staleDb = authenticatedDb(
    "superadmin",
    Math.floor(Date.now() / 1000) - 600
  );

  await assertSucceeds(
    setDoc(doc(staleDb, "roles", "staff"), {
      roleName: "Staff",
      permissions: {}
    })
  );
});

test("veterinarians can read and mark only their own access notices as read", async () => {
  const vetDb = authenticatedDb("vet");

  await assertSucceeds(
    getDoc(doc(vetDb, "notifications", "vet-access"))
  );
  await assertFails(
    getDoc(doc(vetDb, "notifications", "other-access"))
  );
  await assertSucceeds(
    updateDoc(doc(vetDb, "notifications", "vet-access"), { isRead: true })
  );
  await assertFails(
    updateDoc(doc(vetDb, "notifications", "vet-access"), {
      message: "Unauthorized change"
    })
  );
});
