const capsule = document.getElementById("capsule");
const label = capsule.querySelector(".label");

const LABELS = {
  resting: ["", "Murmur is idle"],
  listening: ["Listening", "Listening"],
  handsFree: ["Hands-free", "Listening hands-free"],
  processing: ["Writing…", "Processing dictation"],
  inserted: ["Done", "Text inserted"],
  error: ["Couldn’t paste — copied", "Error: text copied to clipboard"],
};

window.capsuleBridge.onState(({ state, seq }) => {
  capsule.className = state;
  const [text, aria] = LABELS[state] ?? [state, state];
  label.textContent = text;
  capsule.setAttribute("aria-label", aria);
  // Two frames: the first runs before paint, the second after the new state is on screen.
  requestAnimationFrame(() =>
    requestAnimationFrame(() => window.capsuleBridge.painted(seq)),
  );
});

// Click-through when idle: the window ignores the mouse except while the pointer is over the pill.
capsule.addEventListener("mouseenter", () =>
  window.capsuleBridge.setInteractive(true),
);
capsule.addEventListener("mouseleave", () =>
  window.capsuleBridge.setInteractive(false),
);
capsule.addEventListener("click", () => window.capsuleBridge.clicked());
