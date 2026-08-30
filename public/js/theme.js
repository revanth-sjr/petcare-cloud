/* =====================================================================
   theme.js — Pure Dark / Light theme toggle module.
   Pod B owns this file.
   ===================================================================== */

export function initTheme() {
  const toggleBtns = document.querySelectorAll(".theme-toggle-btn");

  function getEffectiveTheme() {
    const saved = localStorage.getItem("petcare.theme");
    if (saved === "dark" || saved === "light") return saved;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    updateButtons(theme);
  }

  function updateButtons(currentTheme) {
    toggleBtns.forEach((btn) => {
      const icon = currentTheme === "dark"
        ? '<img src="https://img.icons8.com/ios-filled/50/moon-symbol.png" alt="Dark" class="ui-icon">'
        : '<img src="https://img.icons8.com/ios-filled/50/sun.png" alt="Light" class="ui-icon">';
      const label = currentTheme === "dark" ? "Dark" : "Light";
      btn.innerHTML = `${icon} ${label}`;
      btn.title = `Current theme: ${currentTheme.toUpperCase()} (Click to toggle)`;
    });
  }

  toggleBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      const current = getEffectiveTheme();
      const next = current === "dark" ? "light" : "dark";
      localStorage.setItem("petcare.theme", next);
      applyTheme(next);
    });
  });

  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (e) => {
    if (!localStorage.getItem("petcare.theme")) {
      applyTheme(e.matches ? "dark" : "light");
    }
  });

  applyTheme(getEffectiveTheme());
}
