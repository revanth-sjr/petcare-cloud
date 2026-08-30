/* =====================================================================
   theme.js — Dark / Light / System theme toggle module.
   Pod B owns this file.
   ===================================================================== */

export function initTheme() {
  const toggleBtns = document.querySelectorAll(".theme-toggle-btn");

  function getTheme() {
    return localStorage.getItem("petcare.theme") || "system";
  }

  function applyTheme(theme) {
    if (theme === "dark" || theme === "light") {
      document.documentElement.setAttribute("data-theme", theme);
    } else {
      document.documentElement.removeAttribute("data-theme");
    }
    updateButtons();
  }

  function updateButtons() {
    const current = getTheme();
    toggleBtns.forEach((btn) => {
      btn.textContent = current === "dark" ? "🌙 Dark" : current === "light" ? "☀️ Light" : "💻 System";
      btn.title = `Theme: ${current.toUpperCase()} (Click to toggle Light / Dark / System)`;
    });
  }

  toggleBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      const current = getTheme();
      const next = current === "system" ? "light" : current === "light" ? "dark" : "system";
      localStorage.setItem("petcare.theme", next);
      applyTheme(next);
    });
  });

  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (getTheme() === "system") {
      updateButtons();
    }
  });

  applyTheme(getTheme());
}
