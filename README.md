# SkinPawsible — Auth Setup

## Files
- `login.html` / `login.js` — login page
- `register.html` / `register.js` — sign up page
- `dashboard.html` / `dashboard.js` — protected landing page after login, proves auth + Firestore work
- `firebase-config.js` — shared Firebase init (edit this with your project's keys)
- `css/style.css` and `css/app-shell.css` — shared component styles and the consistent site background, navigation, and page header

## 1. Create a Firebase project
1. Go to https://console.firebase.google.com → **Add project**.
2. Once created, click the **Web** icon (`</>`) to register a web app.
3. Copy the `firebaseConfig` object it gives you.

## 2. Plug in your config
Open `firebase-config.js` and replace the placeholder values:

```js
const firebaseConfig = {
  apiKey: "...",
  authDomain: "...",
  projectId: "...",
  storageBucket: "...",
  messagingSenderId: "...",
  appId: "..."
};
```

## 3. Enable Email/Password auth
Firebase Console → **Build → Authentication → Sign-in method** → enable **Email/Password**.

## 4. Create Firestore
Firebase Console → **Build → Firestore Database → Create database**. Deploy the
Firestore rules for the application.

Pet Records uploads medical PDFs directly to Cloudinary with the unsigned
`petrecords` preset and stores their metadata in each pet's `medicalHistory`
subcollection. This does not require Firebase Storage or Cloud Functions.

Consultations uploads chat photos and documents directly to Cloudinary with
the unsigned `chatattachments` preset. Configure that preset to accept JPG,
JPEG, PNG, GIF, WEBP, PDF, DOC, DOCX, XLS, XLSX, CSV, and TXT files, with a
10 MB upload limit and dynamic folders enabled. The page places these uploads
under `chat-attachments/{ownerId}/{roomId}` and saves their secure Cloudinary
URL to the chat message's `fileUrl` field. This preset is separate from
`petrecords`, which remains restricted to PDFs.

**Privacy warning:** Cloudinary unsigned upload assets use public delivery.
Anyone with a file URL can access the PDF, and the unsigned preset can be used
outside the web console. Do not upload sensitive medical information with this
setup. Configure the `petrecords` preset in Cloudinary to allow PDF files only
and limit uploads to 10 MB; leave the asset folder unset in the preset so the
page can assign a per-pet dynamic folder. Unsigned uploads do not provide a
secure delete operation, so the page does not offer PDF deletion. For private
medical records and controlled deletion, use a backend capable of signing
Cloudinary uploads and authorizing downloads, or another private storage
provider.

Chat attachments uploaded through the unsigned `chatattachments` preset are
also publicly accessible to anyone with their URL. Do not use this setup for
private or sensitive chat files; use a signed upload flow or private storage
with authenticated downloads for those files. Deleting a chat message does not
delete its Cloudinary asset; secure asset deletion requires a signed backend.

## 5. Run it
These pages use ES module `<script type="module">` imports, so they must be served over
`http://` or `https://`, not opened directly as `file://`. Easiest options:
- VS Code "Live Server" extension
- `npx serve .` from this folder
- Firebase Hosting (`firebase init hosting` → `firebase deploy`)

## JavaScript utility tests

Run the appointment status and date/time utility tests from the project root:

```bash
node --test tests/appointments/appointment-utils.test.mjs
```

## How it works
- **register.html** → creates a Firebase Auth account, sends an email-verification
  link, and creates a pending profile at `users/{uid}`. The user must verify the
  email and an administrator must approve the role and status before web access.
- **login.html** → signs the user in with Firebase Auth and permits only active
  `admin`, `staff`, or `vet` profiles into the web console.
- **dashboard.html** → guarded with `onAuthStateChanged`; if no one is logged in it bounces
  back to `login.html`. Its pet and scan counts read the same user subcollections as the
  Android app.
- **Roles & permissions** → the Super Admin seeds and edits the `roles/{roleId}` permission
  maps in Firestore. These maps control sidebar visibility and page redirects; existing
  page-specific checks and Firestore data rules remain in force, so UI permissions are
  not a substitute for data authorization. Deploy `current-firestore.rules` for the
  role documents to be readable by their matching role and writable by an active Super Admin.

## Staff notifications

The shared `sidebar.js` listener displays unread badges, an in-page notification
panel, and popups for notification records addressed to the signed-in staff
account. Opening a chat notification navigates to the specific conversation in
the Consultations messaging page; consultation notifications open the
Appointments page. Opening a notification marks it read for that staff member
while keeping it in the list. Read notifications have a darker background; the X removes the
notification from that staff member's list without affecting other staff.
Personal notifications are deleted from Firestore when their owner clicks X.
Each owner event has one shared staff notification; each staff member's
`readBy` and `deletedBy` state is independent.

The shared header watches the `consultations` collection for pending appointment
requests and creates the matching staff notification if one is missing,
including on its initial server sync. Regular message notifications are hidden
from staff, but formatted appointment-request messages remain visible as
appointment alerts.

The external pet-owner app should create one notification in the **same
Firestore batch** as the source owner event. Each active staff/vet account
receives it through the shared `recipientRole: "webStaff"` audience. Use these
document paths and fields (`createdAt` and `senderName` are optional):

| Owner event | Document path | Required payload |
| --- | --- | --- |
| Chat message | `notifications/message_{messageId}` | `{ title: "Owner Name sent a message", message: "Message preview", type: "MESSAGE", targetScreen: "CHAT", targetId: roomId, recipientRole: "webStaff", dismissedBy: [], isRead: false, createdAtMillis: Date.now(), timestamp: new Date().toLocaleString(), sourceMessageId: messageId }` |
| Appointment request | `notifications/appointment_{appointmentId}` | `{ title: "New appointment request", message: "Owner Name · pet/date preview", type: "APPOINTMENT", targetScreen: "APPOINTMENTS", targetId: appointmentId, recipientRole: "webStaff", dismissedBy: [], isRead: false, createdAtMillis: Date.now(), timestamp: new Date().toLocaleString(), sourceAppointmentId: appointmentId }` |

Pet-owner appointment requests sent as Consultations chat messages in the
`[Appointment Request] | Pet: ... | Date: ...` format are imported into the
`consultations` collection when a staff member opens that conversation. The
web Appointments page, dashboard, and calendar all read appointment records
from this collection. The chat notification is presented as an appointment
alert and opens the conversation; opening it imports the appointment and
creates the shared `webStaff` notification that opens the appointment in the
web Appointments page. Existing messages are imported when their conversation
is opened; future messages are imported while the conversation is open.

When staff approves or cancels a pending appointment, the Appointments page
updates the appointment and creates an unread personal notification for the
linked owner in the same Firestore transaction. For appointments imported from
Consultations, it also sends the approval or cancellation as a chat message in
the original conversation. The owner app should listen for notifications
matching its `userId`.

Create each source document in the same batch as its notification. The chat
room must already exist and its `petOwnerId` must be the authenticated owner's
UID. Store direct appointment requests in
`consultations/{consultationId}`; the web Appointments page, dashboard, and
calendar read records from this collection. These are the source document
fields:

| Source event | Document path | Required payload |
| --- | --- | --- |
| Chat message | `chatRooms/{roomId}/messages/{messageId}` | `{ senderId: ownerUid, senderName: "Owner Name", senderRole: "Pet Owner", type: "text", text: "Message text", createdAt: serverTimestamp(), read: false }` |
| Appointment request | `consultations/{consultationId}` | `{ userId: ownerUid, userEmail: "owner@example.com", petName: "Pet Name", ownerName: "Owner Name", concern: "Concern", preferredDate: "YYYY-MM-DD", preferredTime: "HH:mm", status: "Pending", createdAt: serverTimestamp() }` |

The source schemas are intentionally restricted to these fields; message text
is limited to 10,000 characters, and the other strings have bounded lengths.
The authenticated owner UID must match `senderId` or `userId`, respectively.
Set notification `isRead` to `false` initially; staff read state is tracked by
appending that staff UID to `readBy`, and deleting from a staff member's list is
tracked by appending that UID to `deletedBy`. Older notifications may have the
staff UID in `dismissedBy`; those records are treated as read for compatibility.
`createdAt` values should be Firestore server timestamps.

The Firestore rules validate recipient role, notification shape, stable
document ID, source ownership, and the source payloads before allowing these
creates. Only active web staff can read shared notifications or append their
own UID to the per-user `readBy` and `deletedBy` fields; other payload fields
are immutable. Existing staff-to-owner chat notifications remain supported. Deploy the updated
Firestore rules and indexes before integrating the owner app.

## Android pet and scan records

The web console reads the same Firebase project configured in
`js/firebase-config.js`. The Android app must use the matching Firebase project
(`skinpawsible`) and Firebase Authentication. Both apps must sign in as the
same account so the Android app can use the authenticated Firebase UID as the
document ID:

```text
users/{uid}/pets/{petId}
users/{uid}/scans/{scanId}
```

Create the profile once after a new Android user signs in; don't overwrite an
existing profile's role from the app. If an existing account is still pending,
an administrator must approve it. For a new pet-owner account, use the exact
role `petOwner`:

```kotlin
val uid = FirebaseAuth.getInstance().currentUser?.uid
    ?: error("Sign in before creating a profile")
val userRef = FirebaseFirestore.getInstance()
    .collection("users").document(uid)

userRef.get()
    .addOnSuccessListener { profile ->
        if (!profile.exists()) {
            userRef.set(
                mapOf(
                    "fullName" to fullName,
                    "email" to FirebaseAuth.getInstance().currentUser?.email,
                    "role" to "petOwner",
                    "status" to "Active",
                    "createdAt" to FieldValue.serverTimestamp()
                )
            ).addOnFailureListener { error ->
                Log.e("SkinPawsible", "Could not create user profile", error)
            }
        }
    }
    .addOnFailureListener { error ->
        Log.e("SkinPawsible", "Could not read user profile", error)
    }
```

Wait for profile creation to succeed before writing pet or scan subcollection
documents. These examples assume the app has already added the Firebase
Authentication and Firestore Android SDKs.

For example, an Android app can save a pet record like this (Kotlin):

```kotlin
val uid = FirebaseAuth.getInstance().currentUser?.uid
    ?: error("Sign in before saving pet records")

FirebaseFirestore.getInstance()
    .collection("users").document(uid)
    .collection("pets")
    .add(
        mapOf(
            "petName" to petName,
            "breed" to breed,
            "age" to age,
            "sex" to sex,
            "createdAt" to FieldValue.serverTimestamp()
        )
    )
```

Save each scan result under that same user's `scans` subcollection. Use fields
such as `petId`, `petName`, `result`, `confidence`, `status`, `scanDate`, and
`imageUrl`. The web pages also recognize common alternatives such as
`prediction`, `condition`, `diagnosis`, `timestamp`, `imageBase64`, and older
snake-case pet fields. Prefer storing scan images in Firebase Storage and
writing the resulting download URL as `imageUrl`; large Base64 images should
not be stored in Firestore documents. Firebase Storage has its own security
rules; configure those to restrict uploads and reads to the owning user (and
authorized staff) before storing private pet images there.

For example, after the Android app has finished analyzing the image:

```kotlin
FirebaseFirestore.getInstance()
    .collection("users").document(uid)
    .collection("scans")
    .add(
        mapOf(
            "petId" to petId,
            "petName" to petName,
            "result" to result,
            "confidence" to confidence,
            "status" to "Completed",
            "scanDate" to FieldValue.serverTimestamp(),
            "imageUrl" to imageUrl
        )
    )
```

The web console shows collection-group results from all users to authorized
staff and veterinarians. Pet owners can use the Android app for their own
records but cannot use the web console. Web accounts created through the
registration page are pending until an administrator approves their role and
status in **Users & Settings**. Only an administrator can change roles/status.
The **Users & Settings** page separates staff/veterinarian web accounts from
pet-owner app accounts: pending profiles are listed with pet owners and can
be approved as the app-only `petOwner` role or assigned the `staff`/`vet` role
while remaining pending until web access is activated. Both tables read
profile documents from `users/{uid}` so the Android app's existing profile
and pet-record paths remain compatible. Administrators can edit a profile's
`fullName` and `contactNumber` in the same document; the existing admin
Firestore rule already permits these updates, so no rules change is needed.
An Android account may create its own profile with role `petOwner`; it must not
set a web role such as `staff`, `vet`, or `admin`.

Deploy the Firestore rules after signing in to the Firebase CLI:

```sh
npx firebase-tools deploy --only firestore:rules --project skinpawsible
```

The first administrator must be assigned `role: "admin"` in
`users/{adminUid}` through the Firebase Console or a trusted administrative
process before using the role-management screen. Do not let a client app create
or change its own web role.

## In-app chat notifications (Spark plan)

When a veterinarian sends a chat message from the web admin, `consultations.js`
writes
the message, updates the chat room preview, and creates an in-app notification
in one Firestore batch. The notification is scoped to the room's `petOwnerId`
and points the Android app to the `CHAT` screen and room. Its document also
contains `sourceMessageId`, which the Firestore rules use to verify that it
was created alongside the matching veterinarian message.

This frontend-only flow supports in-app notifications on the Spark plan; it
does not send an FCM system-tray push. The Android app should listen for
notifications where `userId` matches the signed-in user's UID.

Deploy the Firestore rules with the Firebase CLI:

```sh
npx firebase-tools deploy --only firestore:rules --project skinpawsible
```

The rules grant active admins and staff access to clinic chats. Pet owners can
read and write only their own room and messages. Vets can read standard chats,
but can write only while assigned to a chat whose `chat_status` is
`ESCALATED`. Escalation assigns one active vet, writes a system event, and
creates one in-app alert for that vet atomically. Vets subscribe only to their
own `VET_CHAT_ESCALATION` alerts, and the Firestore rules deny vet accounts
access to other notification records. When an escalated chat is
transferred back to `STANDARD` or marked `RESOLVED`, the vet becomes read-only;
owners can continue chatting with the front desk. Chats without `chat_status`
are treated as `STANDARD`, and the web staff page initializes that field when
staff opens a legacy chat. Ensure veterinarian accounts have the `vet` or
`veterinarian` role in their user profile.
If the `roles/vet` permission document already exists with
`consultations: false`, enable Consultations for the vet role in
**Roles & Permissions**.
When an owner sends a message to a staff-resolved room, the app sets
`needsStaffAttention: true` without reopening it. The web Resolved filter shows
an attention dot until staff/admin reopens the room, which clears the flag.

The vet inbox uses the composite `chatRooms` index in
`firestore.indexes.json`. Deploy both the rules and indexes before using the
escalation workflow:

```sh
npx firebase-tools deploy --only firestore:rules,firestore:indexes --project skinpawsible
```
