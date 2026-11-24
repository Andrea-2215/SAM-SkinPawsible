import {
  EmailAuthProvider,
  getIdTokenResult,
  reauthenticateWithCredential
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";

const RECENT_LOGIN_WINDOW_MS = 5 * 60 * 1000;
const CLIENT_SAFETY_MARGIN_MS = 15 * 1000;

function requestPassword(user, purpose) {
  if (!user.email || !user.providerData.some(({ providerId }) => providerId === "password")) {
    throw new Error("Please sign out and sign in again before continuing.");
  }

  return new Promise((resolve, reject) => {
    const dialog = document.createElement("dialog");
    dialog.className = "reauth-dialog";
    dialog.setAttribute("aria-labelledby", "reauthTitle");
    dialog.innerHTML = `
      <form class="reauth-form">
        <h2 id="reauthTitle">Confirm your identity</h2>
        <p class="reauth-purpose"></p>
        <label for="reauthPassword">Password</label>
        <input id="reauthPassword" type="password" autocomplete="current-password" required>
        <p class="reauth-error" role="alert" hidden></p>
        <div class="reauth-actions">
          <button type="button" class="reauth-cancel">Cancel</button>
          <button type="submit">Continue</button>
        </div>
      </form>
    `;

    const form = dialog.querySelector("form");
    const passwordInput = dialog.querySelector("#reauthPassword");
    const errorMessage = dialog.querySelector(".reauth-error");
    const continueButton = form.querySelector('[type="submit"]');
    dialog.querySelector(".reauth-purpose").textContent =
      `Enter your password to ${purpose}.`;

    const finish = (error) => {
      dialog.close();
      dialog.remove();
      if (error) reject(error);
      else resolve();
    };

    dialog.querySelector(".reauth-cancel").addEventListener("click", () => {
      finish(new Error("Recent sign-in confirmation was cancelled."));
    });

    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      finish(new Error("Recent sign-in confirmation was cancelled."));
    });

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      continueButton.disabled = true;
      errorMessage.hidden = true;

      try {
        await reauthenticateWithCredential(
          user,
          EmailAuthProvider.credential(user.email, passwordInput.value)
        );
        finish();
      } catch (error) {
        console.error("Could not confirm recent sign-in:", error);
        errorMessage.textContent = error.code === "auth/too-many-requests"
          ? "Too many attempts. Please wait and try again."
          : "Password could not be verified. Check it and try again.";
        errorMessage.hidden = false;
        passwordInput.value = "";
        passwordInput.select();
        continueButton.disabled = false;
      }
    });

    document.body.append(dialog);
    dialog.showModal();
    passwordInput.focus();
  });
}

export async function ensureRecentAuthentication(user, purpose) {
  if (!user) {
    throw new Error("A signed-in account is required.");
  }

  const token = await getIdTokenResult(user);
  const authTime = Date.parse(token.authTime);
  const maxAge = RECENT_LOGIN_WINDOW_MS - CLIENT_SAFETY_MARGIN_MS;

  if (Number.isFinite(authTime) && Date.now() - authTime < maxAge) {
    return;
  }

  await requestPassword(user, purpose);
}
