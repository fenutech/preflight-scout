(() => {
  const menuButton = document.querySelector("[data-menu-button]");
  const navigation = document.querySelector("#site-navigation");
  const copyResetTimers = new WeakMap();

  function setMenuOpen(open, returnFocus = false) {
    if (!menuButton || !navigation) return;
    menuButton.setAttribute("aria-expanded", String(open));
    navigation.classList.toggle("open", open);
    const label = menuButton.querySelector("[data-menu-label]");
    if (label) label.textContent = open ? "Close navigation" : "Open navigation";
    if (returnFocus) menuButton.focus();
  }

  async function copyCommand(button) {
    const command = button.dataset.copyCommand;
    if (!command) return;

    let copied = false;
    try {
      await navigator.clipboard.writeText(command);
      copied = true;
    } catch {
      const input = document.createElement("textarea");
      input.value = command;
      input.setAttribute("readonly", "");
      input.style.position = "fixed";
      input.style.opacity = "0";
      document.body.append(input);
      try {
        input.select();
        copied = document.execCommand("copy");
      } catch {
        copied = false;
      } finally {
        input.remove();
      }
    }

    const fallback = button.closest("[data-agent-setup]")?.querySelector("[data-copy-fallback]");
    const idleLabel = button.dataset.copyLabel || "Copy command";
    const successLabel = button.dataset.copySuccessLabel || "Command copied";
    if (!copied) {
      if (fallback) {
        fallback.hidden = false;
        fallback.open = true;
        const prompt = fallback.querySelector("textarea");
        prompt?.focus();
        prompt?.select();
      }
      return;
    }
    if (fallback) fallback.hidden = true;
    window.clearTimeout(copyResetTimers.get(button));
    button.dataset.copied = "true";
    button.setAttribute("aria-label", successLabel);
    const feedback = button.querySelector("[data-copy-feedback]");
    if (feedback) feedback.textContent = button.dataset.copySuccessLabel || "Copied";
    copyResetTimers.set(button, window.setTimeout(() => {
      button.dataset.copied = "false";
      button.setAttribute("aria-label", idleLabel);
      if (feedback) feedback.textContent = idleLabel;
    }, 1800));
  }

  document.addEventListener("click", (event) => {
    const copyButton = event.target.closest("[data-copy-command]");
    if (copyButton) {
      copyCommand(copyButton);
      return;
    }
    if (event.target.closest("[data-menu-button]")) {
      setMenuOpen(menuButton.getAttribute("aria-expanded") !== "true");
      return;
    }
    if (event.target.closest("#site-navigation a")) setMenuOpen(false);
  });

  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && menuButton?.getAttribute("aria-expanded") === "true") setMenuOpen(false, true);
  });
})();
