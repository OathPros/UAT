(() => {
  const themes = [
    { id: "classic", name: "Classic", description: "Crisp red and blue" },
    { id: "dark", name: "Midnight", description: "A softer dark mode" },
    { id: "bubblegum", name: "Bubblegum", description: "Rose and plum" },
    { id: "ocean", name: "Ocean", description: "Cool blue and teal" },
    { id: "sage", name: "Sage", description: "Calm green and stone" },
  ];
  let selected = "classic";
  try {
    const saved = localStorage.getItem("halo.theme");
    if (themes.some((t) => t.id === saved)) selected = saved;
  } catch {
    /* Appearance is optional; saving results uses a separate store. */
  }
  document.documentElement.dataset.theme = selected;
  document.addEventListener("DOMContentLoaded", () => {
    const pickers = document.querySelectorAll("[data-theme-picker]");
    function apply(id) {
      selected = id;
      document.documentElement.dataset.theme = id;
      for (const input of document.querySelectorAll(
        "[data-theme-picker] input",
      ))
        input.checked = input.value === id;
      try {
        localStorage.setItem("halo.theme", id);
      } catch {
        /* Keep the selected theme for this page even if storage is blocked. */
      }
    }
    pickers.forEach((picker, index) => {
      for (const theme of themes) {
        const label = document.createElement("label");
        label.className = "theme-choice";
        const radio = document.createElement("input");
        radio.type = "radio";
        radio.name = "appearance-" + index;
        radio.value = theme.id;
        radio.checked = selected === theme.id;
        radio.setAttribute(
          "aria-label",
          theme.name + " — " + theme.description,
        );
        const swatch = document.createElement("span");
        swatch.className = "theme-swatch swatch-" + theme.id;
        swatch.setAttribute("aria-hidden", "true");
        const text = document.createElement("span");
        text.textContent = theme.name;
        label.append(radio, swatch, text);
        picker.append(label);
        radio.addEventListener("change", () => {
          if (radio.checked) apply(theme.id);
        });
      }
    });
    const dialog = document.getElementById("themeDialog");
    document
      .getElementById("themeButton")
      ?.addEventListener("click", () => dialog.showModal());
    document
      .getElementById("closeTheme")
      ?.addEventListener("click", () => dialog.close());
  });
})();
