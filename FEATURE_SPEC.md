# SkinPawsible Web App: Feature Spec (Consultations + RBAC)

Use this together with the prototype file `consultations.html`, which shows exactly how the chat UI should look and behave.

The prototype uses sample data. Rebuild them in our real stack with real data. Match the layout, colors, spacing and behavior. Keep the purple brand (primary `#6b3fa0`). Support light and dark mode and mobile screens.

---

## 1. Roles and access (RBAC)

| Role | What they can open |
|---|---|
| IT Administrator (superadmin) | ONLY: User accounts, Roles & permissions, Audit logs, System settings. No clinic data at all. |
| Administrator | Clinic management pages and oversight (read access to Consultations). |
| Staff | Consultations (main handlers), appointments, billing, patient records as permitted. |
| Veterinarian | Their own Appointments page, including "Questions from staff". NO Consultations tab. |

Rules:
1. Enforce access on the **server** (middleware or guard on every route and API endpoint), not just by hiding sidebar links. A direct URL or API call by the wrong role must return 403.
2. The IT Administrator must never be able to read patient records, appointments, billing or consultations, even by URL.
3. Permissions per role are stored in the database and checked on each request.
4. A user cannot change their own role or suspend themselves.

---

## 2. Consultations: how chat works

Layout: two panels in one rounded card. Left: conversation list (340px). Right: the open thread. On mobile show the list first, tapping a conversation opens the thread full screen with a Back button.

### 2.1 The core fix: who is "me" does not decide the side
**The bug today:** the side of a bubble is decided by comparing the sender to the logged-in user, so when you switch accounts, a coworker's replies appear as if the pet owner wrote them.

**The rule:** decide the side by the **sender's type**:
- `sender_type = owner` → always LEFT, grey bubble.
- `sender_type = clinic` (any staff or vet account) → always RIGHT, purple bubble.

Never use "is this message from the current user" to choose the side.

### 2.2 Sender labels on every clinic message
Above each right-side message show: **name · role** (for example "Julie · Staff") plus a small colored avatar circle with the sender's initial. Each staff member gets a stable color. Owner messages show the owner's name above them. Timestamp under each bubble.

### 2.3 Conversation list (left)
Each row: avatar, owner name, time of last message, a one-line preview, a tag showing the handler ("Staff Vet" or an orange "Unassigned" or a green "Resolved"), and "Pet: {name}". A purple dot appears for unread. The selected row has a tinted background and a purple left border. Search box filters by owner or pet name.

**Filter tabs (pills):**
- **Open** (default): all conversations that are not resolved.
- **Mine**: open conversations assigned to the logged-in account.
- **Unassigned**: open conversations with nobody handling them.
- **Resolved**: closed conversations only. Resolved chats do NOT show in the other tabs.

Empty state: "No conversations here. Try another filter."

### 2.4 Ownership: Assign to me, Take over, Release
Header of the thread shows: owner name, "Pet owner · Pet: {name} · Handled by {staff} (or Unassigned)".
- Unassigned chat: button **Assign to me**.
- Assigned to someone else: **Take over**.
- Assigned to me: **Release** (becomes unassigned).
- Replying to an unassigned chat as Staff automatically assigns it to that person.
- Every assign, take over and release is stored with who and when, and the handler is what the owner sees as "who they're talking to".

### 2.5 Mark resolved / Reopen
- **Mark resolved** sets status to resolved; the chat moves to the Resolved tab.
- The message box is replaced by "This conversation is resolved. Reopen it to reply." and a **Reopen** button appears.
- If the pet owner sends a new message in a resolved chat, automatically reopen it as unassigned and notify staff.

### 2.5b Presence
If another staff member has the same conversation open, show a thin bar under the header: "{name} is viewing this conversation". Use websockets or polling with a heartbeat. It prevents double replies.

### 2.6 Message composer
Above the text box are mode pills (only one active):
1. **Reply to owner** (default): sends a normal message. Legend: "You'll send as {name} · {role}".
2. **Internal note**: yellow box with a dashed border and a lock icon. Visible only to staff and vets, never to the owner. The input turns yellow.
3. **Ask vet**: sends an internal note starting with "@{vet name}:" AND creates a question for the vet (see 2.8).
4. **Cancel appointment**: see 2.7. The reason is required.

Enter sends. Shift+Enter makes a new line. Hint text under the box: "Enter to send, Shift + Enter for a new line."
Also keep the existing image and attachment buttons from the current app.

### 2.7 Appointment cards inside the chat
Appointment messages are **cards**, not plain text. Keep the existing approved-card design: a small calendar icon, the title in purple, a status badge, a divider, then labeled fields.

Three states:
- **Pending** (orange badge), title "Appointment Request": Pet, Requested date and time. Comes from the owner, shown on the left.
- **Approved** (green badge), title "Appointment Approved": Pet, Date and time. Sent by the clinic, shown on the right with the sender label.
- **Cancelled** (red badge), title "Appointment Cancelled": Pet, Date and time, plus a **"Reason for cancellation"** box (light background, red left border) showing the reason text.

Cancelling: the staff member picks the Cancel appointment mode, types a required reason and sends. This does three things: sets the appointment status to cancelled in the appointments table, stores the reason, and posts the cancelled card into the chat. The conversation-list preview for card messages reads "[Appointment Approved] Pet: Dio" (or Requested or Cancelled). Do not show the raw text and a card at the same time.

### 2.8 Ask vet (vets do NOT have the Consultations tab)
Flow:
1. Staff uses Ask vet mode and types a question. A row is created in `vet_questions` (conversation, asked by, question, answer = null) and an internal note "@Dr. Noe: ..." appears in the thread.
2. The vet logs in and sees their **Appointments** page. It contains a section **"Questions from staff"** with each open question: owner name, pet, who asked, the question text, an answer box and a **Send answer** button. Answered ones are listed below under "Answered". Empty state: "No open questions. You're all caught up."
3. When the vet sends an answer, it is saved on the question and posted into the original thread as an internal note from the vet ("Internal note · Dr. Jammy Noe · Veterinarian"). The chat is marked unread for the staff, who then relay the answer to the owner.
4. Vets never see owner conversations directly and never message owners.
5. Optional: a badge count on the vet's sidebar for open questions.

---

## 3. Data model (adapt to our database)

```
users            id, name, email, role, status (active|pending|suspended), last_active_at, created_at
roles            id, name
role_permissions role_id, permission_key, allowed (bool)

conversations    id, owner_id, pet_id, handler_id (nullable), status (open|resolved), last_message_at
messages         id, conversation_id,
                 sender_type (owner|clinic), sender_id, sender_role,
                 kind (text|note|appointment_card|system),
                 body, appointment_id (nullable), card_status (pending|approved|cancelled),
                 cancel_reason (nullable), created_at
vet_questions    id, conversation_id, asked_by, vet_id, question, answer, answered_at, created_at
```

Important: store `sender_type` and `sender_role` on **every** message. The UI side comes from `sender_type`. Never compute it from the logged-in user.

Existing messages: backfill `sender_type = owner` for messages written by pet-owner accounts and `clinic` for messages written by staff, vet or admin accounts. That fixes the old chats that look wrong.

Also: staff, vet and admin accounts cannot be the owner side of a conversation.

---

## 4. Notes for the build

Build in this order and test each step:
1. Server-side role checks and the IT Administrator restriction.
2. Message model change (`sender_type`, `sender_role`) and the backfill, then the left and right bubble rendering with sender labels.
3. Filters, assignment and resolve, then notes, then appointment cards (including cancel with reason).
4. Ask vet and the vet's "Questions from staff" section.
5. Presence indicator and polish: dark mode, mobile layout, empty states, toasts.

Acceptance checks:
- Log in as two different staff accounts: the same message appears on the same side, with the same sender label, in both.
- The IT Administrator gets 403 when opening any clinic URL.
- A vet cannot open Consultations by URL.
- Internal notes never appear in the owner's view or in any API response sent to the owner.
- A cancellation without a reason is rejected.
