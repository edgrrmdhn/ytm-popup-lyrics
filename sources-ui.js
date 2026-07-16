// sources-ui.js — komponen UI "Lyric Source Priority" (list drag-to-reorder
// + toggle enable/disable per sumber), dipakai bareng oleh panel settings di
// content.js maupun halaman Options (settings.js). Ditaruh terpisah dari
// sources.js supaya sources.js tetap bisa di-importScripts() polos oleh
// background.js (service worker) tanpa bawa-bawa kode manipulasi DOM.
//
// Pakai native HTML5 Drag & Drop API (bukan reimplementasi manual pakai
// pointer events) — didukung penuh oleh Chromium, jadi urutan hasil drag
// langsung ditangani browser (indikator posisi drop, dsb).

(function (root) {
  function persistOrder(order) {
    try {
      chrome.storage.local.set({
        ytmLyricsSourceOrder: order.map((o) => ({ id: o.id, enabled: o.enabled })),
      });
    } catch (e) {
      // storage nggak tersedia, abaikan aja
    }
  }

  function loadOrder(cb) {
    try {
      chrome.storage.local.get(["ytmLyricsSourceOrder"], (res) => {
        cb(ytmNormalizeSourceOrder(res?.ytmLyricsSourceOrder));
      });
    } catch (e) {
      cb(YTM_DEFAULT_SOURCE_ORDER.slice());
    }
  }

  function makeToggle(doc, checked, onChange) {
    const label = doc.createElement("label");
    label.className = "ytm-toggle-switch";
    const input = doc.createElement("input");
    input.type = "checkbox";
    input.checked = checked;
    const slider = doc.createElement("span");
    slider.className = "ytm-toggle-slider";
    label.appendChild(input);
    label.appendChild(slider);
    input.addEventListener("change", () => onChange(input.checked));
    return { label, input };
  }

  // container: elemen tempat list dirender. doc: dokumen tempat elemen
  // dibuat (beda-beda kalau panel lagi dipindah ke window Picture-in-Picture).
  function ytmRenderSourceList(container, doc) {
    if (!container) return;
    doc = doc || container.ownerDocument || document;

    loadOrder((order) => {
      renderRows(container, doc, order);
    });
  }

  function renderRows(container, doc, order) {
    container.innerHTML = "";

    order.forEach((entry) => {
      const meta = ytmGetSourceMeta(entry.id);
      if (!meta || meta.hidden) return;

      const row = doc.createElement("div");
      row.className = "ytm-source-row";
      row.dataset.id = entry.id;
      if (!entry.enabled) row.classList.add("ytm-source-row-disabled");

      const handle = doc.createElement("span");
      handle.className = "ytm-source-drag-handle";
      handle.textContent = "⠿";
      handle.title = "Drag to reorder";
      row.appendChild(handle);

      const info = doc.createElement("div");
      info.className = "ytm-source-info";
      info.title = meta.about || "";

      const nameEl = doc.createElement("div");
      nameEl.className = "ytm-source-name";
      nameEl.textContent = meta.name;
      info.appendChild(nameEl);

      // Semua badge (LINE, Open source & legal, Eksperimental) sengaja
      // tidak ditampilkan lagi di list ini — cukup nama sumber + toggle.
      // Detail status legal/eksperimental tiap sumber tetap ada di
      // meta.about (muncul sebagai tooltip lewat `info.title` di atas).
      row.appendChild(info);

      const { label: toggleLabel } = makeToggle(doc, entry.enabled, (checked) => {
        entry.enabled = checked;
        row.classList.toggle("ytm-source-row-disabled", !checked);
        persistOrder(order);
      });
      row.appendChild(toggleLabel);

      // Drag cuma boleh dimulai lewat handle-nya (bukan dari mana aja di
      // baris), supaya klik toggle/teks nggak ke-anggap mulai drag.
      handle.addEventListener("mousedown", () => {
        row.draggable = true;
      });
      row.addEventListener("dragend", () => {
        row.draggable = false;
        row.classList.remove("ytm-source-row-dragging");
      });
      row.addEventListener("dragstart", (e) => {
        e.dataTransfer.effectAllowed = "move";
        // Firefox butuh setData supaya drag beneran jalan.
        try {
          e.dataTransfer.setData("text/plain", entry.id);
        } catch (err) {
          // abaikan
        }
        row.classList.add("ytm-source-row-dragging");
      });

      container.appendChild(row);
    });

    // Reorder berdasarkan posisi drop (dihitung dari titik tengah tiap
    // baris), lalu urutan baru langsung disimpan ke storage.
    container.addEventListener("dragover", (e) => {
      const draggingRow = container.querySelector(".ytm-source-row-dragging");
      if (!draggingRow) return;
      e.preventDefault();

      const rows = Array.from(container.querySelectorAll(".ytm-source-row:not(.ytm-source-row-dragging)"));
      let closest = null;
      let closestOffset = -Infinity;
      for (const r of rows) {
        const rect = r.getBoundingClientRect();
        const offset = e.clientY - (rect.top + rect.height / 2);
        if (offset < 0 && offset > closestOffset) {
          closestOffset = offset;
          closest = r;
        }
      }
      if (closest) {
        container.insertBefore(draggingRow, closest);
      } else {
        container.appendChild(draggingRow);
      }
    });

    container.addEventListener("drop", (e) => {
      e.preventDefault();
      const newOrder = Array.from(container.querySelectorAll(".ytm-source-row"))
        .map((r) => order.find((o) => o.id === r.dataset.id))
        .filter(Boolean);
      order.length = 0;
      order.push(...newOrder);
      persistOrder(order);
    });
  }

  root.ytmRenderSourceList = ytmRenderSourceList;
})(typeof globalThis !== "undefined" ? globalThis : this);
