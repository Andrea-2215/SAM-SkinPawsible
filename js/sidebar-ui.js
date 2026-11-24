
/* SkinPawsible: render shared sidebar before Firebase modules load. */

(() => {
  const issues = new Map();
  let connectionMessage = "";
  let reconnectTimer = null;
  const status = document.createElement("div");
  status.className = "network-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  status.hidden = true;

  const message = document.createElement("span");
  const retryButton = document.createElement("button");
  retryButton.className = "btn btn-sm btn-outline-primary";
  retryButton.type = "button";
  retryButton.textContent = "Retry";
  retryButton.hidden = true;
  status.append(message, retryButton);
  document.body.prepend(status);

  const messageDialog = document.createElement("dialog");
  messageDialog.className = "app-message-dialog";
  messageDialog.setAttribute("aria-labelledby", "appMessageTitle");
  messageDialog.setAttribute("aria-describedby", "appMessageText");
  messageDialog.innerHTML = `
    <div class="app-message-content">
      <span class="app-message-icon" aria-hidden="true">
        <i class="bi bi-info-circle-fill"></i>
      </span>
      <h2 id="appMessageTitle"></h2>
      <p id="appMessageText"></p>
      <div class="app-message-actions"></div>
    </div>
  `;
  document.body.append(messageDialog);

  const messageTitle = messageDialog.querySelector("#appMessageTitle");
  const messageText = messageDialog.querySelector("#appMessageText");
  const messageActions = messageDialog.querySelector(".app-message-actions");
  const messageQueue = [];
  let activeMessage = null;

  function showNextMessage() {
    if (activeMessage || messageQueue.length === 0) return;

    activeMessage = messageQueue.shift();
    const request = activeMessage;
    messageTitle.textContent = request.title;
    messageText.textContent = request.message;
    messageText.classList.toggle("is-confirmation", request.confirm);
    messageDialog.classList.toggle("is-danger", request.tone === "danger");
    messageActions.replaceChildren();

    if (request.confirm) {
      const cancelButton = document.createElement("button");
      cancelButton.type = "button";
      cancelButton.className = "app-message-cancel";
      cancelButton.textContent = request.cancelText;
      cancelButton.addEventListener("click", () => messageDialog.close("cancel"));
      messageActions.append(cancelButton);
    }

    const confirmButton = document.createElement("button");
    confirmButton.type = "button";
    confirmButton.className = "app-message-submit";
    confirmButton.textContent = request.confirmText;
    confirmButton.addEventListener("click", () => messageDialog.close("confirm"));
    messageActions.append(confirmButton);

    messageDialog.addEventListener("close", () => {
      request.resolve(
        request.confirm ? messageDialog.returnValue === "confirm" : undefined
      );
      activeMessage = null;
      showNextMessage();
    }, { once: true });

    messageDialog.showModal();
    (request.confirm ? messageActions.firstElementChild : confirmButton).focus();
  }

  function enqueueMessage(request) {
    return new Promise((resolve) => {
      messageQueue.push({ ...request, resolve });
      showNextMessage();
    });
  }

  const dialogs = {
    alert(message, options = {}) {
      return enqueueMessage({
        message: String(message ?? ""),
        title: options.title || "Notice",
        confirm: false,
        confirmText: "OK"
      });
    },
    confirm(message, options = {}) {
      return enqueueMessage({
        message: String(message ?? ""),
        title: options.title || "Please confirm",
        confirm: true,
        confirmText: options.confirmText || "Continue",
        cancelText: options.cancelText || "Cancel",
        tone: options.tone || "primary"
      });
    }
  };

  window.SkinPawsibleDialogs = dialogs;
  window.alert = (message) => dialogs.alert(message);
  window.confirm = (message) => dialogs.confirm(message);

  function renderNetworkStatus() {
    const offline = !navigator.onLine;
    const issueMessages = [...issues.values()]
      .map((issue) => issue.message)
      .filter(Boolean);
    const text = offline
      ? "Connection lost. Keep this page open; unsaved actions may need to be retried after reconnecting."
      : issueMessages.join(" ") || connectionMessage;

    status.hidden = !text;
    status.classList.toggle("is-offline", offline);
    message.textContent = text;
    retryButton.hidden =
      offline || ![...issues.values()].some((issue) => issue.retry);
  }

  window.SkinPawsibleNetworkStatus = {
    setIssue(key, issueMessage, retry) {
      issues.set(key, { message: issueMessage, retry });
      connectionMessage = "";
      renderNetworkStatus();
    },
    clearIssue(key) {
      issues.delete(key);
      renderNetworkStatus();
    }
  };

  retryButton.addEventListener("click", async () => {
    const retries = new Set([...issues.values()]
      .map((issue) => issue.retry)
      .filter(Boolean));

    retryButton.disabled = true;
    retryButton.textContent = "Retrying...";
    try {
      await Promise.all([...retries].map((retry) => retry()));
    } catch (error) {
      console.error("A network recovery action failed:", error);
    } finally {
      retryButton.disabled = false;
      retryButton.textContent = "Retry";
      renderNetworkStatus();
    }
  });

  window.addEventListener("offline", () => {
    window.clearTimeout(reconnectTimer);
    connectionMessage = "";
    renderNetworkStatus();
  });

  window.addEventListener("online", () => {
    connectionMessage =
      "Network connection restored. Retry the action you were performing and confirm its result before submitting again.";
    renderNetworkStatus();
    window.clearTimeout(reconnectTimer);
    reconnectTimer = window.setTimeout(() => {
      connectionMessage = "";
      renderNetworkStatus();
    }, 8000);
  });

  renderNetworkStatus();

  const container = document.getElementById("sidebar-container");

  if (!container || document.getElementById("sidebar")) return;

  const sidebarClosed =
    sessionStorage.getItem("skinpawsible-sidebar-closed") === "true";

  document.documentElement.classList.add("sidebar-state-restoring");
  container.innerHTML = `
    <aside class="sidebar${sidebarClosed ? " closed" : ""}" id="sidebar">
      <div class="sidebar-brand">
        <img class="logo" src="../images/LOGO.jpg" alt="SkinPawsible">
        <div>
          <h5>SkinPawsible</h5>
          <small>Veterinary Clinic</small>
        </div>
      </div>

      <nav class="nav-menu">
        <div class="nav-section-title nav-section-main">Main</div>

        <div class="nav-item">
          <a href="dashboard.html" class="nav-link">
            <span class="icon"><i class="bi bi-grid-1x2-fill"></i></span>
            <span class="nav-text">Dashboard</span>
          </a>
        </div>

        <div class="nav-section-title nav-section-pet-management">Pet Management</div>

        <div class="nav-item">
          <a href="pet-records.html" class="nav-link">
            <span class="icon"><i class="bi bi-heart-fill"></i></span>
            <span class="nav-text">Pet Records</span>
          </a>
        </div>

        <div class="nav-item">
          <a href="pet-owners.html" class="nav-link">
            <span class="icon"><i class="bi bi-person-hearts"></i></span>
            <span class="nav-text">Pet Owners</span>
          </a>
        </div>

        <div class="nav-item">
          <a href="scan-records.html" class="nav-link">
            <span class="icon"><i class="bi bi-camera-fill"></i></span>
            <span class="nav-text">Scan Records</span>
          </a>
        </div>

        <div class="nav-item">
          <a href="appointments.html" class="nav-link">
            <span class="icon"><i class="bi bi-clipboard2-pulse-fill"></i></span>
            <span class="nav-text">Appointments</span>
          </a>
        </div>

        <div class="nav-section-title nav-section-communication">Communication</div>

        <div class="nav-item">
          <a href="consultations.html" class="nav-link">
            <span class="icon"><i class="bi bi-chat-dots-fill"></i></span>
            <span class="nav-text">Consultations</span>
          </a>
        </div>

        <div class="nav-item">
          <a href="sms-logs.html" class="nav-link">
            <span class="icon"><i class="bi bi-chat-square-text-fill"></i></span>
            <span class="nav-text">SMS Logs</span>
          </a>
        </div>

        <!-- Permission-controlled navigation -->
        <div id="adminNavigation">
          <div class="nav-section-title">Administration</div>

          <div class="nav-item">
            <a href="users.html" class="nav-link">
              <span class="icon"><i class="bi bi-people-fill"></i></span>
              <span class="nav-text">Users</span>
            </a>
          </div>

          <div class="nav-item">
            <a href="roles-permissions.html" class="nav-link">
              <span class="icon"><i class="bi bi-shield-lock-fill"></i></span>
              <span class="nav-text">Roles &amp; permissions</span>
            </a>
          </div>

          <div class="nav-item">
            <a href="audit-logs.html" class="nav-link">
              <span class="icon"><i class="bi bi-journal-text"></i></span>
              <span class="nav-text">Audit logs</span>
            </a>
          </div>

          <div class="nav-item">
            <a href="security-settings.html" class="nav-link">
              <span class="icon"><i class="bi bi-shield-check"></i></span>
              <span class="nav-text">Security settings</span>
            </a>
          </div>
        </div>

        <!-- Settings visible to all authorized staff roles -->
        <div class="nav-section-title">Account</div>

        <div class="nav-item">
          <a href="settings.html" class="nav-link">
            <span class="icon"><i class="bi bi-gear-fill"></i></span>
            <span class="nav-text">Settings</span>
          </a>
        </div>
      </nav>
    </aside>

    <button
      class="menu-toggle${sidebarClosed ? " closed" : ""}"
      id="menuToggle"
      type="button"
      aria-label="${sidebarClosed ? "Expand" : "Collapse"} navigation"
      aria-controls="sidebar"
      aria-expanded="${!sidebarClosed}"
    >
      <i class="bi bi-chevron-${sidebarClosed ? "right" : "left"}" aria-hidden="true"></i>
    </button>

    <section
      class="notification-panel"
      id="notificationPanel"
      aria-labelledby="notificationPanelTitle"
      hidden
    >
      <div class="notification-panel-header">
        <div>
          <h2 id="notificationPanelTitle">Notifications</h2>
          <p>New messages and appointment requests</p>
        </div>

        <button
          class="notification-close"
          id="notificationPanelClose"
          type="button"
          aria-label="Close notifications"
        >
          <i class="bi bi-x-lg" aria-hidden="true"></i>
        </button>
      </div>

      <div
        class="notification-list"
        id="notificationList"
        aria-live="polite"
      >
        <p class="notification-empty">No new notifications.</p>
      </div>
    </section>

    <div
      class="notification-toast-host"
      id="notificationToastHost"
      aria-live="polite"
      aria-atomic="false"
    ></div>
  `;

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      document.documentElement.classList.remove("sidebar-state-restoring");
    });
  });
})();
