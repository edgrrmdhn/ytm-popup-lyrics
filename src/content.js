// content.js — YT Music Lyrics Popup
// Jalan di music.youtube.com. Mendeteksi lagu yang sedang diputar,
// meminta lirik ke background.js (yang fetch ke lrclib.net), lalu
// menampilkan panel lirik yang scroll otomatis mengikuti posisi lagu.

(function () {
  const STATE = {
    currentKey: null,
    lines: [], // [{ time: number(seconds), text: string }]
    plainText: null,
    activeIndex: -1,
    lineEls: null, // array of DOM elements (index-aligned dengan STATE.lines), diisi renderLines()
    activeLineEl: null, // elemen baris yang lagi "active", biar nggak perlu querySelector tiap update
    panelVisible: true,
    videoEl: null,
    rafId: null,
    fetchToken: 0,
    panelDoc: document, // dokumen tempat panel lirik saat ini berada (document biasa atau window PiP)
    ctxMenuCleanup: null,
    pipWindow: null,
    source: null, // { name, url } sumber lirik yang sedang ditampilkan
    textScale: 1, // skala ukuran teks lirik + judul, disimpan di chrome.storage.local
    viewMode: "lyrics", // "lyrics" | "settings"
    headerTitleText: "Lyrics", // judul terakhir (lagu), buat dipulihkan setelah keluar dari settings
    romajiEnabled: false,
    romajiMode: "ruby", // "ruby" | "default"
    romajiCache: new Map(), // teks baris -> array segmen {surface, romaji}
    forceSource: "auto",
    lastPlainScrollInteraction: 0,
    plainScrollOffset: 0,
    lastTimeUpdateVideoTime: 0,
    lastTimeUpdateSystemTime: 0,
    scrollAnimId: null,
    isUserScrolling: false,
    lyricsOffset: 0,
  };

  const TEXT_SCALE_MIN = 0.7;
  const TEXT_SCALE_MAX = 1.6;
  const TEXT_SCALE_STEP = 0.1;

  // ---------- Util ----------

  function qs(sel) {
    return document.querySelector(sel);
  }

  function qsPanel(sel) {
    return STATE.panelDoc.querySelector(sel);
  }

  function getSongInfo() {
    const titleEl = qs(".title.ytmusic-player-bar");
    const bylineEl = qs(".byline.ytmusic-player-bar");
    const title = titleEl?.textContent?.trim() || "";
    const byline = bylineEl?.textContent?.trim() || "";
    // byline biasanya format: "Nama Artis • Album • Tahun"
    const artist = byline.split("•")[0]?.trim() || "";
    const album = byline.split("•")[1]?.trim() || "";
    return { title, artist, album };
  }

  function getVideoEl() {
    return document.querySelector("video");
  }

  function getVideoId() {
    try {
      return new URLSearchParams(location.search).get("v") || null;
    } catch {
      return null;
    }
  }

  function parseLRC(lrc) {
    const lines = [];
    const re = /\[(\d{2}):(\d{2})(?:\.(\d{2,3}))?\]([^\[]*)/g;
    const wordRe = /<(\d{2}):(\d{2})(?:\.(\d{2,3}))?>([^<]*)/g;
    let match;
    while ((match = re.exec(lrc)) !== null) {
      const min = parseInt(match[1], 10);
      const sec = parseInt(match[2], 10);
      const ms = match[3] ? parseInt(match[3].padEnd(3, "0"), 10) : 0;
      const time = min * 60 + sec + ms / 1000;
      const rawText = match[4];
      
      const words = [];
      let wordMatch;
      let pureText = "";
      if (rawText.includes("<")) {
        // Handle text before the first < tag if any
        const firstBracket = rawText.indexOf("<");
        if (firstBracket > 0) {
          const initial = rawText.substring(0, firstBracket);
          if (initial.trim()) {
            words.push({ time: time, text: initial.trim() });
            pureText += initial;
          }
        }
        while ((wordMatch = wordRe.exec(rawText)) !== null) {
          const wMin = parseInt(wordMatch[1], 10);
          const wSec = parseInt(wordMatch[2], 10);
          const wMs = wordMatch[3] ? parseInt(wordMatch[3].padEnd(3, "0"), 10) : 0;
          const wTime = wMin * 60 + wSec + wMs / 1000;
          const wText = wordMatch[4];
          if (wText && wText.trim()) {
            words.push({ time: wTime, text: wText.trim() });
            pureText += wText;
          }
        }
      }
      
      if (words.length > 0) {
        lines.push({ time, text: pureText.trim(), words });
      } else {
        lines.push({ time, text: rawText.trim() });
      }
    }
    lines.sort((a, b) => a.time - b.time);
    return lines;
  }

  // ---------- UI ----------

  function getRightControlsButtons() {
    return (
      document.querySelector("ytmusic-player-bar #right-controls .right-controls-buttons") ||
      document.querySelector("ytmusic-player-bar .right-controls-buttons") ||
      document.querySelector(".right-controls-buttons")
    );
  }

  const LYRICS_ICON_SVG = `
    <svg viewBox="0 0 24 24" width="24" height="24" focusable="false">
      <path fill="currentColor" d="M9 3v10.55A4 4 0 1 0 11 17V7h4V3H9z"></path>
    </svg>
  `;

  // Icon kontrol pemutaran, diambil dari Material Symbols (Google, lisensi
  // Apache-2.0 / open source) — bentuknya sama dengan yang dipakai YT Music.
  const ICONS = {
    previous: `<svg viewBox="0 0 24 24" width="32" height="32" focusable="false"><path fill="currentColor" d="M6 6h2v12H6zm3.5 6l8.5 6V6z"/></svg>`,
    next: `<svg viewBox="0 0 24 24" width="32" height="32" focusable="false"><path fill="currentColor" d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/></svg>`,
    play: `<svg viewBox="0 0 24 24" width="32" height="32" focusable="false"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>`,
    pause: `<svg viewBox="0 0 24 24" width="32" height="32" focusable="false"><path fill="currentColor" d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>`,
    volumeUp: `<svg viewBox="0 0 24 24" width="32" height="32" focusable="false"><path fill="currentColor" d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>`,
    volumeMuted: `<svg viewBox="0 0 24 24" width="32" height="32" focusable="false"><path fill="currentColor" d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.8L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/></svg>`,
    scaleDown: `<svg viewBox="0 0 24 24" width="20" height="20" focusable="false"><path fill="currentColor" d="M5 11h14v2H5z"/></svg>`,
    scaleUp: `<svg viewBox="0 0 24 24" width="20" height="20" focusable="false"><path fill="currentColor" d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z"/></svg>`,
    back: `<svg viewBox="0 0 24 24" width="20" height="20" focusable="false"><path fill="currentColor" d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg>`,
  };

  // ---------- Custom modern dropdown wrapper ----------
  function applyModernDropdown(selectEl) {
    if (!selectEl) return;
    
    let wrapper = selectEl.nextSibling;
    if (wrapper && wrapper.classList && wrapper.classList.contains("ytm-custom-dropdown-container")) {
      updateCustomOptions(selectEl, wrapper);
      return;
    }
    
    selectEl.style.display = "none";
    
    const doc = selectEl.ownerDocument;
    wrapper = doc.createElement("div");
    wrapper.className = "ytm-custom-dropdown-container";
    
    const btn = doc.createElement("div");
    btn.className = "ytm-custom-dropdown-btn";
    
    const menu = doc.createElement("div");
    menu.className = "ytm-custom-dropdown-menu ytm-lyrics-hidden";
    
    wrapper.appendChild(btn);
    wrapper.appendChild(menu);
    selectEl.parentNode.insertBefore(wrapper, selectEl.nextSibling);
    
    updateCustomOptions(selectEl, wrapper);
    selectEl.addEventListener("change", () => updateCustomOptions(selectEl, wrapper));
    
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (selectEl.disabled) return;
      const ownerDoc = selectEl.ownerDocument;
      const isHidden = menu.classList.contains("ytm-lyrics-hidden");
      
      ownerDoc.querySelectorAll(".ytm-custom-dropdown-menu").forEach(m => m.classList.add("ytm-lyrics-hidden"));
      
      if (isHidden) {
        menu.classList.remove("ytm-lyrics-hidden");
        const onOutsideClick = (evt) => {
          if (!wrapper.contains(evt.target)) {
            menu.classList.add("ytm-lyrics-hidden");
            ownerDoc.removeEventListener("click", onOutsideClick);
          }
        };
        setTimeout(() => {
          ownerDoc.addEventListener("click", onOutsideClick);
        }, 0);
      }
    });
  }

  function updateCustomOptions(selectEl, wrapper) {
    const doc = selectEl.ownerDocument;
    const btn = wrapper.querySelector(".ytm-custom-dropdown-btn");
    const menu = wrapper.querySelector(".ytm-custom-dropdown-menu");
    
    menu.innerHTML = "";
    const selectedOption = selectEl.options[selectEl.selectedIndex];
    btn.textContent = selectedOption ? selectedOption.text : "";
    
    if (selectEl.disabled) {
      btn.classList.add("disabled");
    } else {
      btn.classList.remove("disabled");
    }
    
    Array.from(selectEl.options).forEach(opt => {
      if (opt.style.display === "none") return;
      
      const item = doc.createElement("div");
      item.className = "ytm-custom-dropdown-item";
      if (opt.selected) item.classList.add("selected");
      item.textContent = opt.text;
      item.dataset.value = opt.value;
      item.addEventListener("click", (e) => {
        e.stopPropagation();
        selectEl.value = opt.value;
        selectEl.dispatchEvent(new Event("change"));
        menu.classList.add("ytm-lyrics-hidden");
        updateCustomOptions(selectEl, wrapper);
      });
      menu.appendChild(item);
    });
  }

  function updateLyricsSourceOverrideOptions() {
    const select = qsPanel("#ytm-lyrics-source-override");
    if (!select) return;

    try {
      chrome.storage.local.get(["ytmLyricsSourceOrder"], (res) => {
        const order = ytmNormalizeSourceOrder(res?.ytmLyricsSourceOrder);
        Array.from(select.options).forEach(opt => {
          if (opt.value === "auto") {
            opt.style.display = "";
            return;
          }
          const entry = order.find(o => o.id === opt.value);
          if (entry && entry.enabled) {
            opt.style.display = "";
          } else {
            opt.style.display = "none";
          }
        });
        
        const selectedOpt = select.options[select.selectedIndex];
        if (selectedOpt && selectedOpt.style.display === "none") {
          select.value = "auto";
          STATE.forceSource = "auto";
          select.dispatchEvent(new Event("change"));
        }
        
        applyModernDropdown(select);
      });
    } catch (e) {
      // Fallback
    }
  }

  function injectToggleButton() {
    if (document.getElementById("ytm-lyrics-toggle")) return true;

    const container = getRightControlsButtons();
    if (!container) return false;

    const toggleBtn = document.createElement("button");
    toggleBtn.id = "ytm-lyrics-toggle";
    toggleBtn.className = "ytm-lyrics-native-btn";
    toggleBtn.type = "button";
    toggleBtn.title = "Show/hide pop-up lyrics";
    toggleBtn.setAttribute("aria-label", "Show/hide pop-up lyrics");
    toggleBtn.innerHTML = LYRICS_ICON_SVG;
    toggleBtn.addEventListener("click", () => toggleLyricsPanel());

    // Taruh di paling kanan deretan kontrol (setelah tombol shuffle).
    container.appendChild(toggleBtn);
    return true;
  }

  function ensureUI() {
    injectToggleButton();

    if (qs("#ytm-lyrics-panel")) return;

    if (!document.getElementById("ytm-popup-injected-bridge")) {
      const bridgeScript = document.createElement("script");
      bridgeScript.id = "ytm-popup-injected-bridge";
      bridgeScript.src = chrome.runtime.getURL("src/injected.js");
      (document.head || document.documentElement).appendChild(bridgeScript);
    }

    const panel = document.createElement("div");
    panel.id = "ytm-lyrics-panel";
    panel.innerHTML = `
      <div id="ytm-lyrics-header" style="position: relative; display: flex; align-items: center; justify-content: flex-start;">
        <button id="ytm-lyrics-settings-back" type="button" title="Back to lyrics" style="display:none;">${ICONS.back}</button>
        <span id="ytm-lyrics-header-title" style="flex: 1; text-align: left;">Lyrics</span>
        <div id="ytm-custom-source-wrapper">
          <select id="ytm-lyrics-source-override" title="Force Lyrics Source" class="ytm-setting-select">
            <option value="auto">Auto (Priority)</option>
            <option value="betterlyrics">Better Lyrics</option>
            <option value="lrclib">LRCLIB</option>
            <option value="lrcmux">Lrcmux</option>
          </select>
        </div>
      </div>
      <div id="ytm-lyrics-body" style="position: relative;">
        <div id="ytm-lyrics-status">Waiting for song to play…</div>
        <div id="ytm-lyrics-lines">
          <div id="ytm-lyrics-source" class="ytm-lyrics-hidden"></div>
        </div>
      </div>
      <div id="ytm-scrollbar-hover-zone"></div>
      <div id="ytm-custom-scrollbar">
        <div id="ytm-custom-scrollbar-thumb"></div>
      </div>
      <div id="ytm-lyrics-settings-view" class="ytm-lyrics-hidden">
        <div class="ytm-settings-section">
          <label class="ytm-setting-row ytm-setting-row-toggle">
            <span>Show romaji on Japanese lyrics</span>
            <span class="ytm-toggle-switch">
              <input type="checkbox" id="ytm-setting-romaji-enabled" />
              <span class="ytm-toggle-slider"></span>
            </span>
          </label>
          <label class="ytm-setting-row ytm-setting-row-select">
            <span>Romaji Display Mode</span>
            <select id="ytm-setting-romaji-mode" class="ytm-setting-select">
              <option value="ruby">ruby text</option>
              <option value="default">default</option>
            </select>
          </label>
        </div>
        <hr class="ytm-settings-divider" />
        <div class="ytm-settings-section">
          <div class="ytm-settings-section-title">SOURCES (PRIORITY)</div>
          <p class="ytm-settings-hint">Drag to reorder priority. Higher sources are tried first. Uncheck to disable.</p>
          <div id="ytm-lyrics-sources-list" class="ytm-source-list"></div>
        </div>
      </div>
      <div id="ytm-lyrics-controls">
        <div id="ytm-ctrl-buttons-row">
          <div id="ytm-ctrl-left">
            <button id="ytm-ctrl-prev" class="ytm-ctrl-btn" type="button" title="Previous">${ICONS.previous}</button>
            <button id="ytm-ctrl-playpause" class="ytm-ctrl-btn ytm-ctrl-btn-main" type="button" title="Play/pause">${ICONS.play}</button>
            <button id="ytm-ctrl-next" class="ytm-ctrl-btn" type="button" title="Next">${ICONS.next}</button>
          </div>
          <div id="ytm-ctrl-right">
            <div id="ytm-ctrl-volume-wrap">
              <input id="ytm-ctrl-volume-slider" type="range" min="0" max="100" value="100" />
              <button id="ytm-ctrl-volume-btn" class="ytm-ctrl-btn ytm-ctrl-btn-small" type="button" title="Mute/unmute">${ICONS.volumeUp}</button>
            </div>
            <div id="ytm-ctrl-scale">
              <button id="ytm-ctrl-scale-minus" class="ytm-ctrl-btn ytm-ctrl-btn-small" type="button" title="Decrease lyrics size">${ICONS.scaleDown}</button>
              <button id="ytm-ctrl-scale-plus" class="ytm-ctrl-btn ytm-ctrl-btn-small" type="button" title="Increase lyrics size">${ICONS.scaleUp}</button>
            </div>
          </div>
        </div>
        <div id="ytm-ctrl-seek-wrap">
          <div id="ytm-seek-tooltip" class="ytm-seek-tooltip">0:00</div>
          <input id="ytm-ctrl-seek-slider" type="range" min="0" max="100" step="0.1" value="0" />
          <div id="ytm-ctrl-offset-wrap">
            <button id="ytm-ctrl-offset-minus" class="ytm-ctrl-offset-btn" type="button" title="offset lyrics timing">- 0s</button>
            <button id="ytm-ctrl-offset-plus" class="ytm-ctrl-offset-btn" type="button" title="offset lyrics timing">+ 0s</button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(panel);

    applyTextScale(panel);
    loadTextScale(panel);
    wirePlaybackControls(panel);
    wireContextMenu(panel);
    wireRomajiSettings(panel);
    updateOffsetUI();
    panel.querySelector("#ytm-lyrics-settings-back").addEventListener("click", () => hideSettingsView());
    STATE.panelDoc = document;

    const sourceOverrideEl = panel.querySelector("#ytm-lyrics-source-override");
    sourceOverrideEl.addEventListener("change", (e) => {
      STATE.forceSource = e.target.value;
      const video = STATE.videoEl || getVideoEl();
      const { title, artist, album } = getSongInfo();
      const duration = video?.duration || 0;
      if (title) fetchLyricsFor(title, artist, album, duration, getVideoId());
    });
    updateLyricsSourceOverrideOptions();
    
    setPanelVisible(false);
  }

  // ---------- Skala teks lirik & judul ----------
  // Disimpan di chrome.storage.local supaya preferensi ukuran teks
  // konsisten di semua tab/sesi, bukan cuma per-halaman.

  function applyTextScale(panel) {
    const el = panel || qsPanel("#ytm-lyrics-panel") || qs("#ytm-lyrics-panel");
    if (!el) return;
    el.style.setProperty("--ytm-lyrics-scale", STATE.textScale.toFixed(2));
    updateScaleButtonsState();
  }

  function updateScaleButtonsState() {
    const minus = qsPanel("#ytm-ctrl-scale-minus");
    const plus = qsPanel("#ytm-ctrl-scale-plus");
    if (minus) minus.disabled = STATE.textScale <= TEXT_SCALE_MIN + 1e-9;
    if (plus) plus.disabled = STATE.textScale >= TEXT_SCALE_MAX - 1e-9;
  }

  function setTextScale(delta) {
    let next = Math.round((STATE.textScale + delta) * 100) / 100;
    next = Math.min(TEXT_SCALE_MAX, Math.max(TEXT_SCALE_MIN, next));
    if (next === STATE.textScale) return;
    STATE.textScale = next;
    applyTextScale();
    try {
      chrome.storage?.local?.set({ ytmLyricsTextScale: next });
    } catch (e) {
      // storage nggak tersedia, abaikan aja
    }
  }

  function loadTextScale(panel) {
    try {
      chrome.storage?.local?.get(["ytmLyricsTextScale"], (res) => {
        if (res && typeof res.ytmLyricsTextScale === "number") {
          STATE.textScale = Math.min(TEXT_SCALE_MAX, Math.max(TEXT_SCALE_MIN, res.ytmLyricsTextScale));
          applyTextScale(panel);
        }
      });
    } catch (e) {
      // storage nggak tersedia, pakai default
    }
  }

  // ---------- Romaji (lirik Jepang) ----------
  // Romaji dibuat online lewat background.js (trik Google Translate ja->ja
  // dengan dt=rm, tanpa API key sama sekali) dan disegmentasi per-kata,
  // jadi teksnya bisa muncul tepat di atas kata Jepang yang bersangkutan
  // (hiragana, katakana, maupun kanji) mirip ruby/furigana, tapi pakai
  // alfabet Latin. Hasilnya di-cache per baris teks di memori
  // (STATE.romajiCache) biar baris yang sama (misalnya reff yang berulang)
  // nggak minta ulang ke background.

  function hasJapanese(text) {
    return /[\u3040-\u30ff\u30a0-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/.test(text || "");
  }

  function wireRomajiSettings(panel) {
    const enabledEl = panel.querySelector("#ytm-setting-romaji-enabled");
    const modeEl = panel.querySelector("#ytm-setting-romaji-mode");

    try {
      chrome.storage?.local?.get(["ytmRomajiEnabled", "ytmRomajiMode"], (res) => {
        STATE.romajiEnabled = Boolean(res?.ytmRomajiEnabled);
        STATE.romajiMode = res?.ytmRomajiMode || "ruby";
        if (enabledEl) enabledEl.checked = STATE.romajiEnabled;
        if (modeEl) {
          modeEl.value = STATE.romajiMode;
          modeEl.disabled = !STATE.romajiEnabled;
        }
        applyModernDropdown(modeEl);
        if (STATE.romajiEnabled) renderLines();
      });
    } catch (e) {
      // storage nggak tersedia, romaji tetap off
    }

    enabledEl?.addEventListener("change", () => {
      STATE.romajiEnabled = enabledEl.checked;
      if (modeEl) {
        modeEl.disabled = !STATE.romajiEnabled;
        applyModernDropdown(modeEl);
      }
      try {
        chrome.storage?.local?.set({ ytmRomajiEnabled: STATE.romajiEnabled });
      } catch (e) {
        // abaikan
      }
      renderLines();
    });

    modeEl?.addEventListener("change", () => {
      STATE.romajiMode = modeEl.value;
      try {
        chrome.storage?.local?.set({ ytmRomajiMode: STATE.romajiMode });
      } catch (e) {
        // abaikan
      }
      renderLines();
    });
  }

  function renderRubyIntoDiv(div, segments) {
    const doc = STATE.panelDoc;
    div.textContent = "";

    if (STATE.romajiMode === "default") {
      const origText = segments.map(seg => seg.surface).join("");
      div.appendChild(doc.createTextNode(origText));

      let romajiText = "";
      for (const seg of segments) {
        const part = (seg.romaji || seg.surface || "").trim();
        if (!part) continue;

        const isWord = /[a-zA-Z0-9\u3040-\u30ff\u30a0-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/.test(part);

        if (isWord) {
          if (romajiText.length > 0 && !romajiText.endsWith(" ")) {
            romajiText += " ";
          }
          romajiText += part;
        } else {
          romajiText += part;
        }
      }
      romajiText = romajiText.replace(/\s+/g, " ").trim().toLowerCase();

      const bubble = doc.createElement("div");
      bubble.className = "ytm-lyric-romaji-bubble";
      bubble.textContent = romajiText;
      div.appendChild(bubble);

      div.classList.add("ytm-lyric-line-romaji-default");
      div.classList.remove("ytm-lyric-line-romaji-ruby");
    } else {
      for (const seg of segments) {
        if (seg.romaji) {
          const ruby = doc.createElement("ruby");
          ruby.appendChild(doc.createTextNode(seg.surface));
          const rt = doc.createElement("rt");
          rt.textContent = seg.romaji;
          ruby.appendChild(rt);
          div.appendChild(ruby);
        } else {
          div.appendChild(doc.createTextNode(seg.surface));
        }
      }
      div.classList.add("ytm-lyric-line-romaji-ruby");
      div.classList.remove("ytm-lyric-line-romaji-default");
    }
  }

  function requestRomaji(texts) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(
          { type: "FETCH_ROMAJI", payload: { lines: texts } },
          (response) => {
            if (chrome.runtime.lastError || !response?.ok) {
              resolve(texts.map(() => null));
              return;
            }
            resolve(response.result || texts.map(() => null));
          }
        );
      } catch (e) {
        resolve(texts.map(() => null));
      }
    });
  }

  // Dipanggil sesudah renderLines(): cari baris berbahasa Jepang yang belum
  // punya romaji di cache, minta ke background (satu request per baris
  // unik, dijalankan paralel), lalu suntikkan hasilnya begitu balik —
  // supaya render awal (teks polos) tetap instan dan romaji-nya nyusul.
  function annotateRomaji(fetchToken) {
    if (!STATE.romajiEnabled) return;

    const container = qsPanel("#ytm-lyrics-lines");
    if (!container) return;
    const lineDivs = Array.from(container.querySelectorAll(".ytm-lyric-line"));

    const uniqueTexts = [];
    for (const div of lineDivs) {
      const text = div.dataset.rawText || "";
      if (!hasJapanese(text)) continue;
      if (STATE.romajiCache.has(text)) {
        renderRubyIntoDiv(div, STATE.romajiCache.get(text));
        continue;
      }
      if (!uniqueTexts.includes(text)) uniqueTexts.push(text);
    }
    if (uniqueTexts.length === 0) return;

    requestRomaji(uniqueTexts).then((results) => {
      if (fetchToken !== STATE.fetchToken) return; // lagu udah ganti, buang hasil basi
      uniqueTexts.forEach((text, i) => {
        const segments = results[i];
        if (!segments) return;
        STATE.romajiCache.set(text, segments);
      });
      const freshContainer = qsPanel("#ytm-lyrics-lines");
      if (!freshContainer) return;
      freshContainer.querySelectorAll(".ytm-lyric-line").forEach((div) => {
        const text = div.dataset.rawText || "";
        if (STATE.romajiCache.has(text)) {
          renderRubyIntoDiv(div, STATE.romajiCache.get(text));
        }
      });
    });
  }

  // ---------- Kontrol pemutaran (prev/play-pause/next/volume) ----------
  // Prev/next meneruskan klik ke tombol asli YT Music (supaya logic
  // playlist/queue-nya tetap konsisten), sedangkan play/pause & volume
  // langsung mengontrol elemen <video> yang sama.

  function clickNativeButton(selectors) {
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) {
        el.click();
        return true;
      }
    }
    return false;
  }

  function updatePlayPauseIcon() {
    const btn = qsPanel("#ytm-ctrl-playpause");
    if (!btn) return;
    const video = STATE.videoEl || getVideoEl();
    const playing = Boolean(video && !video.paused && !video.ended);
    btn.innerHTML = playing ? ICONS.pause : ICONS.play;
  }

  function updateVolumeSliderBackground(slider) {
    if (!slider) return;
    const val = Number(slider.value) || 0;
    const min = Number(slider.min) || 0;
    const max = Number(slider.max) || 100;
    const pct = ((val - min) / (max - min)) * 100;
    slider.style.setProperty("--ytm-volume-pct", `${pct}%`);
  }

  document.addEventListener("ytm-popup-volume-update", (e) => {
    if (e.detail.volume > 0) {
      // Pemetaan invers kuadratis untuk visual slider di ekstensi
      STATE.currentVolumePct = Math.round(Math.sqrt(e.detail.volume / 100) * 100);
    }
    STATE.currentMuted = e.detail.muted;
    updateVolumeUI();
  });

  function updateVolumeUI() {
    const btn = qsPanel("#ytm-ctrl-volume-btn");
    const slider = qsPanel("#ytm-ctrl-volume-slider");
    const video = STATE.videoEl || getVideoEl();
    const muted = typeof STATE.currentMuted === "boolean" ? STATE.currentMuted : (video ? (video.muted || video.volume === 0) : false);
    
    // Visually, if muted, the slider should be at 0. Otherwise, use currentVolumePct.
    const volPct = muted ? 0 : (typeof STATE.currentVolumePct === "number" ? STATE.currentVolumePct : (video ? Math.round(Math.sqrt(video.volume) * 100) : 100));

    if (btn) btn.innerHTML = muted ? ICONS.volumeMuted : ICONS.volumeUp;
    if (slider) {
      const activeDoc = STATE.panelDoc || document;
      if (!STATE.isDraggingVolume && activeDoc.activeElement !== slider) {
        slider.value = String(Math.round(volPct));
        updateVolumeSliderBackground(slider);
      }
    }
  }

  function formatTime(seconds) {
    if (!seconds || isNaN(seconds) || !isFinite(seconds)) return "0:00";
    const totalSec = Math.floor(seconds);
    const mins = Math.floor(totalSec / 60);
    const secs = totalSec % 60;
    return `${mins}:${secs < 10 ? "0" : ""}${secs}`;
  }

  function updateSeekSliderBackground(slider) {
    if (!slider) return;
    const val = Number(slider.value) || 0;
    const min = Number(slider.min) || 0;
    const max = Number(slider.max) || 100;
    const pct = max > min ? ((val - min) / (max - min)) * 100 : 0;
    slider.style.setProperty("--ytm-seek-pct", `${pct}%`);
  }

  function updatePlainLyricsScroll(currentTime, duration, isFrame) {
    if (!duration || isNaN(duration) || duration <= 0) return;
    const body = qsPanel("#ytm-lyrics-body");
    if (!body) return;

    // Jika sedang di-drag/scroll oleh user atau dalam masa cooldown 1 detik, abaikan auto-scroll
    if (STATE.isUserScrolling || Date.now() - (STATE.lastPlainScrollInteraction || 0) < 1000) return;

    const maxScroll = body.scrollHeight - body.clientHeight;
    if (maxScroll <= 0) return;

    const offsetSec = (STATE.lyricsOffset || 0) / 1000;
    const adjustedTime = currentTime - offsetSec;

    const ratio = Math.min(1, Math.max(0, adjustedTime / duration));
    const baseScroll = ratio * maxScroll;
    const desiredScrollTop = Math.max(0, Math.min(maxScroll, baseScroll + (STATE.plainScrollOffset || 0)));

    if (isFrame) {
      body.scrollTop = desiredScrollTop;
    } else {
      body.scrollTo({
        top: desiredScrollTop,
        behavior: "smooth"
      });
    }
  }

  let lastFrameTime = 0;
  function plainScrollAnimationLoop(timestamp) {
    if (!STATE.panelVisible || !STATE.plainText) {
      STATE.scrollAnimId = null;
      return;
    }

    if (!lastFrameTime) lastFrameTime = timestamp;
    const elapsed = timestamp - lastFrameTime;

    if (elapsed >= 33.33) { // Pembatasan 30 FPS (1000ms / 30 = 33.33ms)
      lastFrameTime = timestamp - (elapsed % 33.33);

      const video = STATE.videoEl || getVideoEl();
      if (video) {
        const now = performance.now();
        const lastUpdate = STATE.lastTimeUpdateSystemTime || now;
        const lastVideoTime = STATE.lastTimeUpdateVideoTime || video.currentTime;
        let est = lastVideoTime;
        if (!video.paused) {
          est += (now - lastUpdate) / 1000 * (video.playbackRate || 1);
        }
        updatePlainLyricsScroll(est, video.duration, true);
      }
    }

    STATE.scrollAnimId = requestAnimationFrame(plainScrollAnimationLoop);
  }

  function updateCustomScrollbar() {
    const body = qsPanel("#ytm-lyrics-body");
    const thumb = qsPanel("#ytm-custom-scrollbar-thumb");
    const track = qsPanel("#ytm-custom-scrollbar");
    if (!body || !thumb || !track) return;

    const scrollHeight = body.scrollHeight;
    const clientHeight = body.clientHeight;

    if (scrollHeight <= clientHeight) {
      track.style.display = "none";
      return;
    }
    track.style.display = "block";

    const trackHeight = track.clientHeight;
    const thumbHeight = Math.max(20, (clientHeight / scrollHeight) * trackHeight);
    thumb.style.height = `${thumbHeight}px`;

    const scrollTop = body.scrollTop;
    const maxScrollTop = scrollHeight - clientHeight;
    const maxTrackScroll = trackHeight - thumbHeight;

    const thumbTop = maxScrollTop > 0 ? (scrollTop / maxScrollTop) * maxTrackScroll : 0;
    thumb.style.top = `${thumbTop}px`;
  }

  function updateOffsetUI() {
    const btnMinus = qsPanel("#ytm-ctrl-offset-minus");
    const btnPlus = qsPanel("#ytm-ctrl-offset-plus");
    if (!btnMinus || !btnPlus) return;

    const val = STATE.lyricsOffset || 0;
    if (val === 0) {
      btnMinus.textContent = "- 0s";
      btnPlus.textContent = "+ 0s";
    } else if (val > 0) {
      btnMinus.textContent = "- 0s";
      btnPlus.textContent = `+ ${val / 1000}s`;
    } else {
      btnMinus.textContent = `- ${Math.abs(val / 1000)}s`;
      btnPlus.textContent = "+ 0s";
    }
  }

  function updateSeekUI() {
    const video = STATE.videoEl || getVideoEl();
    if (!video) return;
    const seekSlider = qsPanel("#ytm-ctrl-seek-slider");
    const tooltip = qsPanel("#ytm-seek-tooltip");
    if (!seekSlider || STATE.isDraggingSeek || document.activeElement === seekSlider) return;

    const cur = video.currentTime || 0;
    const dur = video.duration || 0;
    seekSlider.max = dur > 0 ? String(dur) : "100";
    seekSlider.value = String(cur);
    updateSeekSliderBackground(seekSlider);
    if (tooltip && !STATE.isHoveringSeek && !STATE.isDraggingSeek) {
      tooltip.textContent = formatTime(cur);
      const pct = dur > 0 ? (cur / dur) * 100 : 0;
      tooltip.style.left = `${pct}%`;
    }

    if (STATE.plainText) {
      if (!STATE.scrollAnimId) {
        lastFrameTime = 0;
        STATE.scrollAnimId = requestAnimationFrame(plainScrollAnimationLoop);
      }
      if (video.paused) {
        updatePlainLyricsScroll(cur, dur, true);
      }
    }
  }

  function wireVideoEvents(video) {
    if (!video || video.__ytmLyricsWired) return;
    video.__ytmLyricsWired = true;
    video.addEventListener("play", updatePlayPauseIcon);
    video.addEventListener("pause", updatePlayPauseIcon);
    video.addEventListener("volumechange", updateVolumeUI);
    video.addEventListener("timeupdate", () => {
      STATE.lastTimeUpdateVideoTime = video.currentTime;
      STATE.lastTimeUpdateSystemTime = performance.now();
      updateSeekUI();
    });
    video.addEventListener("durationchange", updateSeekUI);
    updatePlayPauseIcon();
    updateVolumeUI();
    updateSeekUI();
  }

  function wirePlaybackControls(panel) {
    panel.querySelector("#ytm-ctrl-prev").addEventListener("click", () => {
      clickNativeButton([
        ".previous-button.ytmusic-player-bar",
        ".previous-button",
        'tp-yt-paper-icon-button.previous-button',
        '[aria-label*="previous" i]',
        '[aria-label*="sebelumnya" i]',
      ]);
    });

    panel.querySelector("#ytm-ctrl-next").addEventListener("click", () => {
      clickNativeButton([
        ".next-button.ytmusic-player-bar",
        ".next-button",
        'tp-yt-paper-icon-button.next-button',
        '[aria-label*="next" i]',
        '[aria-label*="berikutnya" i]',
      ]);
    });

    panel.querySelector("#ytm-ctrl-playpause").addEventListener("click", () => {
      const video = STATE.videoEl || getVideoEl();
      if (!video) return;
      if (video.paused) video.play().catch(() => {});
      else video.pause();
    });

    panel.querySelector("#ytm-ctrl-volume-btn").addEventListener("click", () => {
      const video = STATE.videoEl || getVideoEl();
      const newMuted = typeof STATE.currentMuted === "boolean" ? !STATE.currentMuted : (video ? !video.muted : true);
      let curVol = typeof STATE.currentVolumePct === "number" ? STATE.currentVolumePct : (video ? Math.round(video.volume * 100) : 100);
      
      // Jika di-unmute dan volume sebelumnya sangat rendah/nol, setel ke default 50%
      if (!newMuted && curVol <= 5) {
        curVol = 50;
        STATE.currentVolumePct = 50;
      }
      
      STATE.currentMuted = newMuted;

      // Pemetaan kuadratis untuk akurasi volume
      const actualVol = curVol <= 0 ? 0 : Math.max(1, Math.round(Math.pow(curVol / 100, 2) * 100));
      document.dispatchEvent(new CustomEvent("ytm-popup-set-volume", { detail: { volume: actualVol, muted: newMuted } }));
      updateVolumeUI();
    });

    const volSlider = panel.querySelector("#ytm-ctrl-volume-slider");
    if (volSlider) {
      const startVolDrag = () => { STATE.isDraggingVolume = true; };
      const endVolDrag = () => {
        STATE.isDraggingVolume = false;
        volSlider.blur();
      };
      volSlider.addEventListener("pointerdown", startVolDrag);
      volSlider.addEventListener("mousedown", startVolDrag);
      volSlider.addEventListener("pointerup", endVolDrag);
      volSlider.addEventListener("mouseup", endVolDrag);
      volSlider.addEventListener("blur", endVolDrag);
      volSlider.addEventListener("change", endVolDrag);
      window.addEventListener("pointerup", endVolDrag);
      window.addEventListener("mouseup", endVolDrag);

      volSlider.addEventListener("input", (e) => {
        STATE.isDraggingVolume = true;
        const val = Number(e.target.value);
        STATE.currentVolumePct = val;
        STATE.currentMuted = val === 0;
        updateVolumeSliderBackground(e.target);

        // Pemetaan kuadratis untuk akurasi volume
        const actualVol = val <= 0 ? 0 : Math.max(1, Math.round(Math.pow(val / 100, 2) * 100));
        document.dispatchEvent(new CustomEvent("ytm-popup-set-volume", { detail: { volume: actualVol, muted: val === 0 } }));
      });
    }

    const volWrap = panel.querySelector("#ytm-ctrl-volume-wrap");
    if (volWrap) {
      volWrap.addEventListener("mouseenter", () => {
        document.dispatchEvent(new CustomEvent("ytm-popup-request-volume"));
      });
    }

    const seekSlider = panel.querySelector("#ytm-ctrl-seek-slider");
    const seekWrap = panel.querySelector("#ytm-ctrl-seek-wrap");
    const seekTooltip = panel.querySelector("#ytm-seek-tooltip");
    if (seekSlider && seekWrap) {
      const startSeekDrag = () => {
        STATE.isDraggingSeek = true;
        seekWrap.classList.add("is-scrubbing");
      };
      const endSeekDrag = () => {
        STATE.isDraggingSeek = false;
        seekWrap.classList.remove("is-scrubbing");
        seekSlider.blur();
      };
      seekSlider.addEventListener("pointerdown", startSeekDrag);
      seekSlider.addEventListener("mousedown", startSeekDrag);
      seekSlider.addEventListener("pointerup", endSeekDrag);
      seekSlider.addEventListener("mouseup", endSeekDrag);
      seekSlider.addEventListener("blur", endSeekDrag);
      window.addEventListener("pointerup", endSeekDrag);
      window.addEventListener("mouseup", endSeekDrag);

      const updateTooltipPos = (clientX, valSec) => {
        if (!seekTooltip) return;
        const dur = Number(seekSlider.max) || 1;
        let timeSec = valSec;
        let leftPct = 0;

        const rectSlider = seekSlider.getBoundingClientRect();
        const rectWrap = seekWrap.getBoundingClientRect();
        const sliderWidth = rectSlider.width;
        const sliderLeftOffset = rectSlider.left - rectWrap.left;

        if (typeof valSec === "number") {
          timeSec = valSec;
          leftPct = ((sliderLeftOffset + (valSec / dur) * sliderWidth) / (rectWrap.width || 1)) * 100;
        } else if (clientX !== undefined) {
          const ratio = Math.max(0, Math.min(1, (clientX - rectSlider.left) / (sliderWidth || 1)));
          timeSec = ratio * dur;
          leftPct = ((sliderLeftOffset + ratio * sliderWidth) / (rectWrap.width || 1)) * 100;
        }
        seekTooltip.textContent = formatTime(timeSec);
        seekTooltip.style.left = `${leftPct}%`;
      };

      seekWrap.addEventListener("pointerenter", () => { STATE.isHoveringSeek = true; });
      seekWrap.addEventListener("pointerleave", () => { STATE.isHoveringSeek = false; });
      seekWrap.addEventListener("pointermove", (e) => {
        if (!STATE.isDraggingSeek) updateTooltipPos(e.clientX);
      });

      seekSlider.addEventListener("input", (e) => {
        STATE.isDraggingSeek = true;
        seekWrap.classList.add("is-scrubbing");
        const seconds = Number(e.target.value);
        updateSeekSliderBackground(e.target);
        updateTooltipPos(undefined, seconds);
      });

      seekSlider.addEventListener("change", (e) => {
        endSeekDrag();
        const seconds = Number(e.target.value);
        const video = STATE.videoEl || getVideoEl();
        if (video) video.currentTime = seconds;
        document.dispatchEvent(new CustomEvent("ytm-popup-seek-to", { detail: { seconds } }));
      });
    }

    panel.querySelector("#ytm-ctrl-scale-minus").addEventListener("click", () => {
      setTextScale(-TEXT_SCALE_STEP);
    });

    panel.querySelector("#ytm-ctrl-scale-plus").addEventListener("click", () => {
      setTextScale(TEXT_SCALE_STEP);
    });

    panel.querySelector("#ytm-ctrl-offset-minus").addEventListener("click", () => {
      STATE.lyricsOffset -= 500;
      updateOffsetUI();
      const video = STATE.videoEl || getVideoEl();
      if (video) {
        if (STATE.lines.length > 0) {
          STATE.activeIndex = -1;
          updateActiveLine(video.currentTime);
        } else if (STATE.plainText) {
          STATE.isUserScrolling = false;
          STATE.lastPlainScrollInteraction = 0;
          updatePlainLyricsScroll(getEstimatedTime(), video.duration, false);
        }
      }
    });

    panel.querySelector("#ytm-ctrl-offset-plus").addEventListener("click", () => {
      STATE.lyricsOffset += 500;
      updateOffsetUI();
      const video = STATE.videoEl || getVideoEl();
      if (video) {
        if (STATE.lines.length > 0) {
          STATE.activeIndex = -1;
          updateActiveLine(video.currentTime);
        } else if (STATE.plainText) {
          STATE.isUserScrolling = false;
          STATE.lastPlainScrollInteraction = 0;
          updatePlainLyricsScroll(getEstimatedTime(), video.duration, false);
        }
      }
    });

    const body = panel.querySelector("#ytm-lyrics-body");
    const scrollbar = panel.querySelector("#ytm-custom-scrollbar");
    const thumb = panel.querySelector("#ytm-custom-scrollbar-thumb");
    const hoverZone = panel.querySelector("#ytm-scrollbar-hover-zone");

    if (body && scrollbar && thumb) {
      let isDraggingThumb = false;
      let startY = 0;
      let startScrollTop = 0;
      let userScrollTimeout = null;
      let hideScrollbarTimeout = null;

      const recordInteraction = () => {
        STATE.lastPlainScrollInteraction = Date.now();
        STATE.isUserScrolling = true;
        
        if (userScrollTimeout) clearTimeout(userScrollTimeout);
        userScrollTimeout = setTimeout(() => {
          STATE.isUserScrolling = false;
          if (hideScrollbarTimeout) clearTimeout(hideScrollbarTimeout);
          hideScrollbarTimeout = setTimeout(() => {
            if (!isDraggingThumb) {
              scrollbar.classList.remove("visible");
            }
          }, 800);
        }, 150);
      };

      body.addEventListener("wheel", recordInteraction, { passive: true });
      body.addEventListener("touchmove", recordInteraction, { passive: true });
      body.addEventListener("pointerdown", recordInteraction, { passive: true });

      body.addEventListener("scroll", () => {
        updateCustomScrollbar();

        if (STATE.isUserScrolling) {
          scrollbar.classList.add("visible");
          if (hideScrollbarTimeout) clearTimeout(hideScrollbarTimeout);

          if (STATE.plainText) {
            const video = STATE.videoEl || getVideoEl();
            if (video && video.duration > 0) {
              const maxScroll = body.scrollHeight - body.clientHeight;
              if (maxScroll > 0) {
                if (body.scrollTop <= 2) {
                  STATE.plainScrollOffset = 0;
                } else {
                  const ratio = Math.min(1, Math.max(0, video.currentTime / video.duration));
                  STATE.plainScrollOffset = body.scrollTop - (ratio * maxScroll);
                }
              }
            }
          }
        }
      }, { passive: true });

      // Meneruskan wheel scroll dari area scrollbar ke body agar lirik tetap tergulir
      const redirectWheel = (e) => {
        body.scrollTop += e.deltaY;
        recordInteraction();
      };
      scrollbar.addEventListener("wheel", redirectWheel, { passive: true });
      if (hoverZone) {
        hoverZone.addEventListener("wheel", redirectWheel, { passive: true });
      }

      // Wiring fungsionalitas drag scrollbar kustom secara statis ke panel kontainer
      // untuk kestabilan event di jendela Document Picture-in-Picture (PiP).
      thumb.addEventListener("pointerdown", (e) => {
        e.stopPropagation();
        isDraggingThumb = true;
        startY = e.clientY;
        startScrollTop = body.scrollTop;
        STATE.lastPlainScrollInteraction = Date.now();
        STATE.isUserScrolling = true;
        scrollbar.classList.add("visible");
        
        try {
          thumb.setPointerCapture(e.pointerId);
        } catch (err) {}
      });

      thumb.addEventListener("pointermove", (e) => {
        if (!isDraggingThumb) return;
        STATE.lastPlainScrollInteraction = Date.now();
        STATE.isUserScrolling = true;

        const deltaY = e.clientY - startY;
        const trackHeight = scrollbar.clientHeight;
        const thumbHeight = thumb.offsetHeight;
        const maxTrackScroll = trackHeight - thumbHeight;
        const maxScrollTop = body.scrollHeight - body.clientHeight;

        const scrollDelta = maxTrackScroll > 0 ? (deltaY / maxTrackScroll) * maxScrollTop : 0;
        body.scrollTop = startScrollTop + scrollDelta;
      });

      const stopDragging = (e) => {
        if (isDraggingThumb) {
          isDraggingThumb = false;
          scrollbar.classList.remove("visible");
          STATE.isUserScrolling = false;
          STATE.lastPlainScrollInteraction = Date.now();
          try {
            thumb.releasePointerCapture(e.pointerId);
          } catch (err) {}
        }
      };

      thumb.addEventListener("pointerup", stopDragging);
      thumb.addEventListener("pointercancel", stopDragging);

      const handleScrollbarClick = (e) => {
        if (e.target === thumb) return;

        STATE.lastPlainScrollInteraction = Date.now();
        STATE.isUserScrolling = true;
        scrollbar.classList.add("visible");
        e.preventDefault();

        const rect = hoverZone ? hoverZone.getBoundingClientRect() : scrollbar.getBoundingClientRect();
        const clickY = e.clientY - rect.top;
        const trackHeight = hoverZone ? hoverZone.clientHeight : scrollbar.clientHeight;
        const thumbHeight = thumb.offsetHeight;
        const maxTrackScroll = trackHeight - thumbHeight;
        const maxScrollTop = body.scrollHeight - body.clientHeight;

        const desiredThumbTop = clickY - (thumbHeight / 2);
        const ratio = maxTrackScroll > 0 ? Math.min(1, Math.max(0, desiredThumbTop / maxTrackScroll)) : 0;
        
        body.scrollTop = ratio * maxScrollTop;

        isDraggingThumb = true;
        startY = e.clientY;
        startScrollTop = body.scrollTop;
        try {
          thumb.setPointerCapture(e.pointerId);
        } catch (err) {}
      };

      if (hoverZone) {
        hoverZone.addEventListener("pointerdown", handleScrollbarClick);
      }
      scrollbar.addEventListener("pointerdown", handleScrollbarClick);
    }
  }

  function setPanelVisible(visible) {
    STATE.panelVisible = visible;
    const panel = qsPanel("#ytm-lyrics-panel");
    if (panel) panel.classList.toggle("ytm-lyrics-hidden", !visible);
    const btn = document.getElementById("ytm-lyrics-toggle");
    if (btn) btn.classList.toggle("active", visible);
  }

  function setStatus(text) {
    const el = qsPanel("#ytm-lyrics-status");
    if (el) {
      el.textContent = text;
      el.style.display = text ? "block" : "none";
    }
  }

  function setSource(source, sourceId) {
    let sId = sourceId || (source && typeof source === "object" ? source.id : typeof source === "string" ? source : null);
    let sName = source && typeof source === "object" ? source.name : typeof source === "string" ? source : null;
    let sUrl = source && typeof source === "object" ? source.url : null;

    if (sId && window.ytmGetSourceMeta) {
      const meta = window.ytmGetSourceMeta(sId);
      if (!sName && meta?.name) sName = meta.name;
      if (!sUrl && meta?.url) sUrl = meta.url;
    }
    if (!sName && sId) sName = sId.toUpperCase();

    let resolved = null;
    if (sName) {
      resolved = { name: sName, id: sId || sName.toLowerCase(), url: sUrl || null };
    }
    STATE.source = resolved;

    const doc = STATE.panelDoc || document;
    let el = qsPanel("#ytm-lyrics-source");
    if (!el) {
      el = doc.createElement("div");
      el.id = "ytm-lyrics-source";
      el.className = "ytm-lyrics-hidden";
    }

    const linesContainer = qsPanel("#ytm-lyrics-lines");
    if (!resolved) {
      el.classList.add("ytm-lyrics-hidden");
      el.innerHTML = "";
      if (linesContainer && el.parentElement !== linesContainer) {
        linesContainer.appendChild(el);
      }
      return;
    }

    el.classList.remove("ytm-lyrics-hidden");
    el.innerHTML = "";

    const label = doc.createElement(resolved.url ? "a" : "span");
    label.className = "ytm-lyrics-source-label";
    label.textContent = `Source: ${resolved.name}`;
    if (resolved.url) {
      label.href = resolved.url;
      label.target = "_blank";
      label.rel = "noopener noreferrer";
    }
    el.appendChild(label);

    if (linesContainer) {
      linesContainer.appendChild(el);
    }
  }

  function renderLines() {
    const container = qsPanel("#ytm-lyrics-lines");
    if (!container) return;
    const sourceEl = qsPanel("#ytm-lyrics-source");
    container.innerHTML = "";
    container.style.transition = "none";
    container.style.transform = "translateY(0px)";
    STATE.lineEls = null;
    STATE.activeLineEl = null;
    const doc = STATE.panelDoc;

    if (STATE.lines.length > 0) {
      // Bikin semua elemen dulu di DocumentFragment (satu kali reflow pas
      // di-append ke container), bukan appendChild satu-satu per baris.
      const fragment = doc.createDocumentFragment();
      const lineEls = new Array(STATE.lines.length);
      STATE.lines.forEach((line, i) => {
        const div = doc.createElement("div");
        div.className = "ytm-lyric-line";
        div.dataset.index = String(i);
        div.dataset.rawText = line.text || "";
        if (line.words && line.words.length > 0) {
          line.words.forEach(w => {
            const span = doc.createElement("span");
            span.className = "ytm-lyric-word";
            span.dataset.time = w.time;
            span.textContent = w.text.trim();
            div.appendChild(span);
          });
        } else {
          div.textContent = line.text || "♪";
        }
        div.addEventListener("click", () => seekToLine(line));
        lineEls[i] = div;
        fragment.appendChild(div);
      });
      container.appendChild(fragment);
      if (STATE.source) setSource(STATE.source);
      STATE.lineEls = lineEls;
      setStatus("");
      annotateRomaji(STATE.fetchToken);
    } else if (STATE.plainText) {
      const wrap = doc.createElement("div");
      wrap.className = "ytm-lyric-plain";
      const fragment = doc.createDocumentFragment();
      STATE.plainText.split("\n").forEach((text) => {
        const div = doc.createElement("div");
        div.className = "ytm-lyric-line ytm-lyric-line-plain";
        const trimmed = text.trim();
        div.dataset.rawText = trimmed;
        div.textContent = trimmed || "\u00A0";
        fragment.appendChild(div);
      });
      wrap.appendChild(fragment);
      container.appendChild(wrap);
      if (STATE.source) setSource(STATE.source);
      setStatus("");
      annotateRomaji(STATE.fetchToken);
    } else {
      setStatus("Lyrics doesn't found for this music.");
    }
    updateCustomScrollbar();
  }

  function seekToLine(line) {
    const video = STATE.videoEl || getVideoEl();
    if (!video || typeof line.time !== "number") return;
    const offsetSec = (STATE.lyricsOffset || 0) / 1000;
    video.currentTime = Math.max(0, Math.min(video.duration || Infinity, line.time + offsetSec));
    if (video.paused) {
      video.play().catch(() => {});
    }
  }

  function updateActiveLine(currentTime) {
    const lines = STATE.lines;
    if (lines.length === 0) return;

    const offsetSec = (STATE.lyricsOffset || 0) / 1000;
    const adjustedTime = currentTime - offsetSec;

    // Playback normalnya maju terus, jadi kalau baris aktif saat ini masih
    // valid (waktunya belum lewat adjustedTime), lanjutkan scan dari situ
    // saja alih-alih dari awal — cuma perlu geser beberapa baris per tick,
    // bukan re-scan semua baris. Kalau ada seek mundur (waktu baris aktif
    // sekarang sudah "di masa depan" relatif ke adjustedTime), baru scan
    // ulang dari awal.
    const start =
      STATE.activeIndex >= 0 && lines[STATE.activeIndex].time <= adjustedTime + 0.05
        ? STATE.activeIndex
        : 0;

    let idx = start === 0 ? -1 : start;
    for (let i = start; i < lines.length; i++) {
      if (lines[i].time <= adjustedTime + 0.05) {
        idx = i;
      } else {
        break;
      }
    }

    if (idx !== STATE.activeIndex) {
      if (STATE.lineEls) {
        for (let i = 0; i < STATE.lineEls.length; i++) {
          const el = STATE.lineEls[i];
          if (!el) continue;
          if (i < idx) {
            el.classList.add("past");
            el.classList.remove("active");
          } else if (i === idx) {
            el.classList.add("active");
            el.classList.remove("past");
          } else {
            el.classList.remove("active", "past");
          }
        }
      }
      const next = STATE.lineEls && idx >= 0 ? STATE.lineEls[idx] : null;
      if (next) {
        const body = qsPanel("#ytm-lyrics-body");
        const linesContainer = qsPanel("#ytm-lyrics-lines");
        if (body && linesContainer) {
          const oldScrollTop = body.scrollTop;
          const panel = qsPanel("#ytm-lyrics-panel");
          const header = qsPanel("#ytm-lyrics-header");
          const panelHeight = panel ? panel.clientHeight : body.clientHeight;
          const headerHeight = header ? header.offsetHeight : 0;
          const desiredOffsetInBody = (panelHeight / 2) - headerHeight;
          const desiredScrollTop = Math.max(0, next.offsetTop - desiredOffsetInBody + (next.offsetHeight / 2));
          linesContainer.style.transition = "none";
          body.scrollTop = desiredScrollTop;
          const actualNewScrollTop = body.scrollTop;
          const actualDelta = actualNewScrollTop - oldScrollTop;
          if (Math.abs(actualDelta) > 1) {
            let currentOffsetY = 0;
            const comp = window.getComputedStyle(linesContainer).transform;
            if (comp && comp !== "none") {
              const matrix = new DOMMatrixReadOnly(comp);
              currentOffsetY = matrix.m42 || 0;
            }
            linesContainer.style.transform = `translateY(${actualDelta + currentOffsetY}px)`;
            void linesContainer.offsetHeight; // force reflow
            linesContainer.style.transition = "transform 0.55s cubic-bezier(0.22, 1, 0.36, 1)";
            linesContainer.style.transform = "translateY(0px)";
          }
        } else {
          next.scrollIntoView({ behavior: "smooth", block: "center" });
        }
      }
      STATE.activeLineEl = next || null;
      STATE.activeIndex = idx;
    }
    
    // Update word-level highlighting
    if (STATE.activeLineEl && STATE.lines[STATE.activeIndex] && STATE.lines[STATE.activeIndex].words) {
      const wordSpans = STATE.activeLineEl.querySelectorAll(".ytm-lyric-word");
      for (const span of wordSpans) {
        const wTime = parseFloat(span.dataset.time);
        if (adjustedTime >= wTime) {
          span.classList.add("active-word");
        } else {
          span.classList.remove("active-word");
        }
      }
    }
  }

  function tick() {
    if (!STATE.panelVisible) return;
    const video = STATE.videoEl;
    if (video && !video.paused) {
      if (STATE.lines.length > 0) {
        updateActiveLine(video.currentTime);
      }
      updateSeekUI();
    }
  }

  // ---------- Lyrics fetching ----------

  function clearLyricsLines() {
    const container = qsPanel("#ytm-lyrics-lines");
    if (container) {
      container.innerHTML = "";
      container.style.transition = "none";
      container.style.transform = "translateY(0px)";
    }
    STATE.lineEls = null;
    STATE.activeLineEl = null;
  }

  function fetchLyricsFor(title, artist, album, duration, videoId) {
    const token = ++STATE.fetchToken;
    STATE.lines = [];
    STATE.plainText = null;
    STATE.activeIndex = -1;
    STATE.plainScrollOffset = 0;
    STATE.lyricsOffset = 0;
    updateOffsetUI();
    setSource(null);
    clearLyricsLines();
    setStatus("Searching for lyrics...");

    chrome.runtime.sendMessage(
      {
        type: "FETCH_LYRICS",
        payload: { track: title, artist, album, duration, videoId, forceSource: STATE.forceSource },
      },
      (response) => {
        if (token !== STATE.fetchToken) return; // song already changed before response arrived
        if (!response?.ok || !response.result?.found) {
          setStatus("Lyrics doesn't found for this music.");
          return;
        }
        const { syncedLyrics, plainLyrics, instrumental, source, sourceId, sourceUrl } = response.result;
        if (instrumental) {
          setStatus("Instrumental track (no lyrics).");
          return;
        }
        if (syncedLyrics) {
          STATE.lines = parseLRC(syncedLyrics);
          setSource({ name: source || sourceId, id: sourceId, url: sourceUrl }, sourceId);
          renderLines();
        } else if (plainLyrics) {
          STATE.plainText = plainLyrics;
          setSource({ name: source || sourceId, id: sourceId, url: sourceUrl }, sourceId);
          renderLines();
        } else {
          setStatus("Lyrics doesn't found for this music.");
        }
      }
    );
  }

  function handlePossibleSongChange() {
    const { title, artist, album } = getSongInfo();
    if (!title) return;

    const video = getVideoEl();
    STATE.videoEl = video || STATE.videoEl;
    wireVideoEvents(STATE.videoEl);

    const key = `${title}::${artist}`;
    if (key === STATE.currentKey) return;
    STATE.currentKey = key;
    STATE.plainScrollOffset = 0;

    const headerTitle = qsPanel("#ytm-lyrics-header-title");
    STATE.headerTitleText = artist ? `${title} — ${artist}` : title;
    if (headerTitle && STATE.viewMode !== "settings") headerTitle.textContent = STATE.headerTitleText;

    const fetchWithDuration = () => {
      const duration = video?.duration || 0;
      fetchLyricsFor(title, artist, album, duration, getVideoId());
    };

    if (video && (isNaN(video.duration) || video.duration === 0)) {
      const onLoadedMetadata = () => {
        video.removeEventListener("loadedmetadata", onLoadedMetadata);
        const current = getSongInfo();
        if (current.title === title && current.artist === artist) {
          fetchWithDuration();
        }
      };
      video.addEventListener("loadedmetadata", onLoadedMetadata);
      setTimeout(() => {
        video.removeEventListener("loadedmetadata", onLoadedMetadata);
        const current = getSongInfo();
        if (current.title === title && current.artist === artist) {
          fetchWithDuration();
        }
      }, 1000);
    } else {
      fetchWithDuration();
    }
  }

  // ---------- Picture-in-Picture (always on top) ----------

  async function toggleLyricsPanel() {
    // Kalau window PiP sedang terbuka, klik lagi = tutup.
    if (STATE.pipWindow && !STATE.pipWindow.closed) {
      STATE.pipWindow.close();
      return;
    }

    // Kalau browser tidak mendukung Picture-in-Picture, fallback ke panel
    // biasa yang mengambang di dalam tab.
    if (!("documentPictureInPicture" in window)) {
      setPanelVisible(!STATE.panelVisible);
      if (STATE.panelVisible) {
        updatePlayPauseIcon();
        updateVolumeUI();
      }
      return;
    }

    // Kalau panel fallback lagi kebuka di dalam tab, tutup dulu.
    if (STATE.panelVisible && STATE.panelDoc === document) {
      setPanelVisible(false);
    }

    const panel = qsPanel("#ytm-lyrics-panel");
    if (!panel) return;

    const pipWindow = await window.documentPictureInPicture.requestWindow({
      width: 340,
      height: 460,
    });
    STATE.pipWindow = pipWindow;

    // Muat ulang style.css di dalam window PiP (dokumen baru, kosong)
    const link = pipWindow.document.createElement("link");
    link.rel = "stylesheet";
    link.href = chrome.runtime.getURL("styles/style.css");
    pipWindow.document.head.appendChild(link);
    pipWindow.document.title = "Lyrics — YT Music";

    // Reset total supaya dokumen PiP sendiri tidak ikut nampilin scrollbar
    // (yang mau di-scroll cuma #ytm-lyrics-body di dalam panel).
    const resetStyle = pipWindow.document.createElement("style");
    resetStyle.textContent = `
      html, body {
        margin: 0;
        padding: 0;
        height: 100%;
        overflow: hidden;
        background: #0f0f0f;
        scrollbar-width: none;
      }
      html::-webkit-scrollbar, body::-webkit-scrollbar {
        display: none;
        width: 0;
        height: 0;
      }
      * { box-sizing: border-box; }
    `;
    pipWindow.document.head.appendChild(resetStyle);

    // Pindahkan panel ke window PiP
    panel.classList.remove("ytm-lyrics-hidden");
    panel.style.position = "static";
    panel.style.width = "100%";
    panel.style.height = "100vh";
    panel.style.maxHeight = "none";
    panel.style.borderRadius = "0";
    pipWindow.document.body.appendChild(panel);
    STATE.panelDoc = pipWindow.document;
    updateOffsetUI();

    STATE.panelVisible = true;
    const btn = document.getElementById("ytm-lyrics-toggle");
    if (btn) btn.classList.add("active");
    updatePlayPauseIcon();
    document.dispatchEvent(new CustomEvent("ytm-popup-request-volume"));

    pipWindow.addEventListener("pagehide", () => {
      // Window PiP ditutup -> pindahkan panel balik ke tab utama (tersembunyi)
      hideLyricsContextMenu();
      panel.style.position = "";
      panel.style.width = "";
      panel.style.height = "";
      panel.style.maxHeight = "";
      panel.style.borderRadius = "";
      panel.classList.add("ytm-lyrics-hidden");
      document.body.appendChild(panel);
      STATE.panelDoc = document;
      updateOffsetUI();
      STATE.pipWindow = null;
      STATE.panelVisible = false;

      const btnBack = document.getElementById("ytm-lyrics-toggle");
      if (btnBack) btnBack.classList.remove("active");
    });
  }

  // ---------- Menu klik-kanan (copy lirik / settings) ----------

  function copyTextToClipboard(text, sourceWindow) {
    const win = sourceWindow || window;
    const tryModern = () =>
      win.navigator?.clipboard?.writeText
        ? win.navigator.clipboard.writeText(text)
        : Promise.reject(new Error("Clipboard API unavailable"));

    tryModern().catch(() => {
      // Fallback untuk kasus API modern gagal/nggak tersedia (misalnya
      // dokumen tidak dianggap "focused" oleh browser).
      try {
        const doc = win.document;
        const ta = doc.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        doc.body.appendChild(ta);
        ta.focus();
        ta.select();
        doc.execCommand("copy");
        doc.body.removeChild(ta);
      } catch (e) {
        // nggak ada cara lain, diamkan aja
      }
    });
  }

  function copySelectedLyrics(text, menuItemEl) {
    if (!text) return;
    const win = STATE.pipWindow && !STATE.pipWindow.closed ? STATE.pipWindow : window;
    copyTextToClipboard(text, win);
    if (menuItemEl) {
      menuItemEl.textContent = "Copied!";
      setTimeout(() => hideLyricsContextMenu(), 650);
    }
  }

  function showSettingsView() {
    STATE.viewMode = "settings";
    const body = qsPanel("#ytm-lyrics-body");
    const controls = qsPanel("#ytm-lyrics-controls");
    const settingsView = qsPanel("#ytm-lyrics-settings-view");
    const title = qsPanel("#ytm-lyrics-header-title");
    const backBtn = qsPanel("#ytm-lyrics-settings-back");
    const sourceWrapper = qsPanel("#ytm-custom-source-wrapper");
    if (body) body.style.display = "none";
    if (controls) controls.style.display = "none";
    if (sourceWrapper) sourceWrapper.style.display = "none";
    if (settingsView) settingsView.classList.remove("ytm-lyrics-hidden");
    if (title) title.textContent = "Settings";
    if (backBtn) backBtn.style.display = "inline-flex";

    const sourcesList = qsPanel("#ytm-lyrics-sources-list");
    if (sourcesList) ytmRenderSourceList(sourcesList, STATE.panelDoc);
  }

  function hideSettingsView() {
    STATE.viewMode = "lyrics";
    const body = qsPanel("#ytm-lyrics-body");
    const controls = qsPanel("#ytm-lyrics-controls");
    const settingsView = qsPanel("#ytm-lyrics-settings-view");
    const title = qsPanel("#ytm-lyrics-header-title");
    const backBtn = qsPanel("#ytm-lyrics-settings-back");
    const sourceWrapper = qsPanel("#ytm-custom-source-wrapper");
    if (body) body.style.display = "";
    if (controls) controls.style.display = "";
    if (sourceWrapper) sourceWrapper.style.display = "";
    if (settingsView) settingsView.classList.add("ytm-lyrics-hidden");
    if (title) title.textContent = STATE.headerTitleText || "Lyrics";
    if (backBtn) backBtn.style.display = "none";
    
    updateLyricsSourceOverrideOptions();
  }

  function hideLyricsContextMenu() {
    const existing = STATE.panelDoc.getElementById
      ? STATE.panelDoc.getElementById("ytm-lyrics-contextmenu")
      : STATE.panelDoc.querySelector("#ytm-lyrics-contextmenu");
    if (existing) existing.remove();
    if (STATE.ctxMenuCleanup) {
      STATE.ctxMenuCleanup();
      STATE.ctxMenuCleanup = null;
    }
  }

  function showLyricsContextMenu(clientX, clientY) {
    hideLyricsContextMenu();
    const doc = STATE.panelDoc;

    // Clear any mouse-drag text highlight — copying is based on which
    // line the cursor is hovering/right-clicking on, not on selected text.
    const sel = doc.getSelection ? doc.getSelection() : null;
    if (sel && sel.removeAllRanges) sel.removeAllRanges();

    const hoveredEl = doc.elementFromPoint
      ? doc.elementFromPoint(clientX, clientY)
      : null;
    const hoveredLine = hoveredEl ? hoveredEl.closest(".ytm-lyric-line") : null;
    const hoveredText = hoveredLine ? (hoveredLine.dataset.rawText ?? hoveredLine.textContent.trim()) : "";
    const canCopy = Boolean(hoveredText);

    const menu = doc.createElement("div");
    menu.id = "ytm-lyrics-contextmenu";
    menu.innerHTML = `
      ${canCopy ? '<button type="button" class="ytm-ctxmenu-item" data-action="copy">Copy line</button>' : ""}
      <button type="button" class="ytm-ctxmenu-item" data-action="settings">Settings</button>
    `;
    doc.body.appendChild(menu);

    // Posisikan di titik klik, tapi jangan sampai kepotong tepi window.
    const win = doc.defaultView;
    const menuRect = menu.getBoundingClientRect();
    const maxLeft = Math.max(4, win.innerWidth - menuRect.width - 4);
    const maxTop = Math.max(4, win.innerHeight - menuRect.height - 4);
    menu.style.left = `${Math.min(clientX, maxLeft)}px`;
    menu.style.top = `${Math.min(clientY, maxTop)}px`;

    if (canCopy) {
      menu.querySelector('[data-action="copy"]').addEventListener("click", (e) => {
        copySelectedLyrics(hoveredText, e.currentTarget);
      });
    }
    menu.querySelector('[data-action="settings"]').addEventListener("click", () => {
      showSettingsView();
      hideLyricsContextMenu();
    });

    const onOutsideClick = (e) => {
      if (!menu.contains(e.target)) hideLyricsContextMenu();
    };
    const onEscape = (e) => {
      if (e.key === "Escape") hideLyricsContextMenu();
    };
    // Pakai setTimeout supaya klik-kanan yang lagi membuka menu ini nggak
    // langsung ke-detect sebagai "klik di luar" dan menutup menu itu sendiri.
    setTimeout(() => {
      doc.addEventListener("click", onOutsideClick);
      doc.addEventListener("contextmenu", onOutsideClick);
      doc.addEventListener("keydown", onEscape);
    }, 0);

    STATE.ctxMenuCleanup = () => {
      doc.removeEventListener("click", onOutsideClick);
      doc.removeEventListener("contextmenu", onOutsideClick);
      doc.removeEventListener("keydown", onEscape);
    };
  }

  function wireContextMenu(panel) {
    panel.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      showLyricsContextMenu(e.clientX, e.clientY);
    });
  }

  // ---------- Better Lyrics Turnstile ----------

  function handleTurnstile() {
    const iframe = document.createElement("iframe");
    iframe.src = "https://lyrics.api.dacubeking.com/challenge";
    iframe.style.display = "none";
    document.body.appendChild(iframe);

    const onMessage = (event) => {
      if (event.data && event.data.type === "turnstile-token") {
        try {
          chrome.storage?.local?.set({ jwtTokenBetterLyrics: event.data.token });
        } catch (e) {}
      }
    };
    window.addEventListener("message", onMessage);

    setTimeout(() => {
      window.removeEventListener("message", onMessage);
      if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
      handleTurnstile();
    }, 1000 * 60 * 5); // Refresh every 5 minutes
  }

  // ---------- Init ----------

  function init() {
    ensureUI();
    handleTurnstile();
    document.dispatchEvent(new CustomEvent("ytm-popup-request-volume"));

    // Deteksi lagu & pastikan tombol ada, cukup lewat polling ringan
    // (menghindari MutationObserver di seluruh halaman yang berat di SPA ini).
    handlePossibleSongChange();
    setInterval(() => {
      handlePossibleSongChange();
      injectToggleButton();
      if (!STATE.videoEl) {
        const v = getVideoEl();
        if (v) {
          STATE.videoEl = v;
          wireVideoEvents(v);
        }
      }
      if (STATE.panelVisible) {
        document.dispatchEvent(new CustomEvent("ytm-popup-request-volume"));
      }
    }, 1500);

    if (!STATE.rafId) {
      STATE.rafId = setInterval(tick, 250);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
  // ---------- Better Lyrics Official API (Bypass CORS) ----------
  async function getJwtToken() {
    chrome.storage.local.set({ bl_debug_error: "Starting getJwtToken" });
    const data = await chrome.storage.local.get("bl_jwtToken");
    const token = data.bl_jwtToken;
    if (token && !isJwtExpired(token)) {
      chrome.storage.local.set({ bl_debug_error: "Using cached JWT token" });
      return token;
    }
    
    chrome.storage.local.set({ bl_debug_error: "Solving turnstile..." });
    const turnstileToken = await solveTurnstile();
    chrome.storage.local.set({ bl_debug_error: "Got turnstile token, verifying..." });
    
    const verifyRes = await fetch("https://lyrics.api.dacubeking.com/verify-turnstile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: turnstileToken }),
      credentials: "include"
    });
    
    if (!verifyRes.ok) {
      chrome.storage.local.set({ bl_debug_error: "Turnstile verify failed: " + verifyRes.status });
      throw new Error("Failed to verify Turnstile token");
    }
    const dataRes = await verifyRes.json();
    const jwtString = dataRes.jwt;
    await chrome.storage.local.set({ bl_jwtToken: jwtString });
    chrome.storage.local.set({ bl_debug_error: "Successfully fetched new JWT token" });
    return jwtString;
  }

  function isJwtExpired(token) {
    try {
      const payloadBase64Url = token.split(".")[1];
      if (!payloadBase64Url) return true;
      const payloadBase64 = payloadBase64Url.replace(/-/g, "+").replace(/_/g, "/");
      const decodedPayload = atob(payloadBase64);
      const payload = JSON.parse(decodedPayload);
      const expirationTimeInSeconds = payload.exp;
      return (Date.now() / 1000) > expirationTimeInSeconds;
    } catch (e) {
      return true;
    }
  }

  function solveTurnstile() {
    return new Promise((resolve, reject) => {
      const iframe = document.createElement("iframe");
      iframe.src = "https://lyrics.api.dacubeking.com/challenge";
      iframe.style.position = "fixed";
      iframe.style.bottom = "10px";
      iframe.style.right = "10px";
      iframe.style.width = "0px";
      iframe.style.height = "0px";
      iframe.style.border = "none";
      iframe.style.zIndex = "999999";
      document.body.appendChild(iframe);

      const cleanup = () => {
        window.removeEventListener("message", messageListener);
        if (document.body.contains(iframe)) document.body.removeChild(iframe);
      };

      const messageListener = (event) => {
        if (event.source !== iframe.contentWindow) return;
        switch (event.data.type) {
          case "turnstile-token":
            cleanup(); resolve(event.data.token); break;
          case "turnstile-error":
            cleanup(); reject(new Error(event.data.error)); break;
          case "turnstile-timeout":
            cleanup(); reject(new Error("timeout")); break;
          case "turnstile-expired":
            if (iframe.contentWindow) iframe.contentWindow.postMessage({ type: "reset-turnstile" }, "*");
            break;
        }
      };
      window.addEventListener("message", messageListener);
    });
  }

  async function fetchBetterLyricsAPI(payload) {
    try {
      chrome.storage.local.set({ bl_debug_error: "Starting fetchBetterLyricsAPI for " + payload.searchTrack });
      const { searchTrack, searchArtist, duration, videoId, album, targetProvider } = payload;
      const jwt = await getJwtToken();
      if (!jwt) {
        chrome.storage.local.set({ bl_debug_error: "JWT token is null" });
        return null;
      }

      const body = new URLSearchParams();
      if (videoId) body.append("videoId", videoId);
      if (searchTrack) body.append("song", searchTrack);
      if (searchArtist) body.append("artist", searchArtist);
      if (duration) body.append("duration", String(Math.round(duration)));
      if (album) body.append("album", album);
      body.append("alwaysFetchMetadata", "false");
      body.append("token", jwt);

      chrome.storage.local.set({ bl_debug_error: "Fetching v2/lyrics..." });
      const response = await fetch("https://lyrics.api.dacubeking.com/v2/lyrics", {
        method: "POST",
        body
      });

      if (!response.ok) {
        chrome.storage.local.set({ bl_debug_error: "v2/lyrics fetch failed: " + response.status });
        if (response.status === 403) chrome.storage.local.remove("bl_jwtToken");
        return null;
      }

      const reader = response.body?.getReader();
      if (!reader) {
        chrome.storage.local.set({ bl_debug_error: "No reader available" });
        return null;
      }
      
      const decoder = new TextDecoder();
      let buffer = "";
      chrome.storage.local.set({ bl_debug_error: "Reading stream..." });
      
      while (true) {
        const { done, value } = await reader.read();
        if (value) {
          buffer += decoder.decode(value, { stream: true });
          const messages = buffer.split(/\n\n|\r\n\r\n/);
          buffer = messages.pop() || "";
          
          for (const message of messages) {
            let currentEvent = "";
            let dataBuffer = "";
            for (const line of message.split(/\r?\n/)) {
              if (line.startsWith("event:")) currentEvent = line.substring(6).trim();
              else if (line.startsWith("data:")) dataBuffer += line.substring(5).trim();
            }
            
            if (dataBuffer && dataBuffer !== "[DONE]" && currentEvent === "provider") {
              try {
                const data = JSON.parse(dataBuffer);
                const provider = data.provider;
                if (targetProvider && provider !== targetProvider) {
                  continue;
                }
                const results = data.results;
                if (results) {
                  let parsedLrc = null;
                  let synced = false;
                  if (provider === "musixmatch") {
                    if (results.wordByWord) { parsedLrc = results.wordByWord; synced = true; }
                    else if (results.synced) { parsedLrc = results.synced; synced = true; }
                  } else if (provider === "lrclib") {
                    if (results.synced) { parsedLrc = results.synced; synced = true; }
                    else if (results.plain) { parsedLrc = results.plain; synced = false; }
                  } else if (provider === "kugou" && results.lyrics) {
                    try { parsedLrc = JSON.parse(results.lyrics).lyrics; synced = true; } catch (e) {}
                  }
                  
                  if (parsedLrc) {
                    reader.cancel();
                    chrome.storage.local.set({ bl_debug_error: "Lyrics found from " + provider });
                    return {
                      syncedLyrics: synced ? parsedLrc : null,
                      plainLyrics: synced ? null : parsedLrc,
                      instrumental: false,
                      sourceId: "betterlyrics",
                    };
                  }
                }
              } catch (e) {}
            }
          }
        }
        if (done) break;
      }
      chrome.storage.local.set({ bl_debug_error: "Stream ended without finding lyrics" });
      return null;
    } catch (e) {
      chrome.storage.local.set({ bl_debug_error: "Exception: " + e.message });
      return null;
    }
  }

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === "FETCH_BETTER_LYRICS_API") {
      fetchBetterLyricsAPI(request.payload).then(result => sendResponse({ result })).catch(() => sendResponse({ result: null }));
      return true;
    }
  });

})();

