// settings.js — halaman Options (dibuka lewat "Extension options" di
// chrome://extensions). Pakai chrome.storage.local yang sama dengan panel
// settings di dalam music.youtube.com, jadi keduanya selalu sinkron —
// termasuk urutan/prioritas sumber lirik (dirender lewat sources-ui.js,
// dipakai bareng dengan panel settings di content.js).

const enabledEl = document.getElementById("romaji-enabled");
const savedMsg = document.getElementById("saved-msg");
const sourcesListEl = document.getElementById("sources-list");

const modeEl = document.getElementById("romaji-mode");

chrome.storage.local.get(["ytmRomajiEnabled", "ytmRomajiMode"], (res) => {
  const enabled = Boolean(res?.ytmRomajiEnabled);
  enabledEl.checked = enabled;
  if (modeEl) {
    modeEl.value = res?.ytmRomajiMode || "ruby";
    modeEl.disabled = !enabled;
  }
});

ytmRenderSourceList(sourcesListEl, document);

function showSaved() {
  savedMsg.textContent = "Saved.";
  setTimeout(() => {
    savedMsg.textContent = "";
  }, 1200);
}

enabledEl.addEventListener("change", () => {
  if (modeEl) modeEl.disabled = !enabledEl.checked;
  chrome.storage.local.set({ ytmRomajiEnabled: enabledEl.checked }, showSaved);
});

modeEl.addEventListener("change", () => {
  chrome.storage.local.set({ ytmRomajiMode: modeEl.value }, showSaved);
});
