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
      input.select();
      copied = document.execCommand("copy");
      input.remove();
    }

    if (!copied) return;
    window.clearTimeout(copyResetTimers.get(button));
    button.dataset.copied = "true";
    button.setAttribute("aria-label", "Command copied");
    const feedback = button.querySelector("[data-copy-feedback]");
    if (feedback) feedback.textContent = "Copied";
    copyResetTimers.set(button, window.setTimeout(() => {
      button.dataset.copied = "false";
      button.setAttribute("aria-label", "Copy command");
      if (feedback) feedback.textContent = "Copy command";
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
