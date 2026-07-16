// sources.js — daftar sumber lirik + util bersama.
// File ini dipakai di 3 tempat: background.js (service worker, lewat
// importScripts), content.js (panel di halaman music.youtube.com), dan
// settings.js (halaman Options) — supaya daftar sumber & urutan
// prioritasnya selalu sinkron di mana pun ditampilkan/dieksekusi, tanpa
// duplikasi data.
//
// Menambah sumber lirik baru di masa depan = tambah satu entri di
// YTM_LYRIC_SOURCES + satu fungsi fetch di background.js (lihat
// SOURCE_FETCHERS di sana), tanpa perlu ubah apa pun di UI.

(function (root) {
  const YTM_LYRIC_SOURCES = [
    {
      id: "betterlyrics",
      name: "Better Lyrics",
      sync: "WORD_OR_LINE",
      openSource: true,
      legalStatus: "fair_use",
      legalLabel: "FAIR USE / CLOUDFLARE",
      about:
        "API resmi dari ekstensi Better Lyrics yang melintasi Musixmatch, LRCLIB, QQ, dll lewat server-side proxy mereka. Dilindungi Cloudflare Turnstile, jadi ekstensi kita menangani captcha-nya diam-diam di background.",
      url: "https://github.com/boidushya/better-lyrics",
    },
    {
      id: "unison",
      name: "Better Lyrics (Unison)",
      sync: "LINE",
      openSource: true,
      legalStatus: "legal",
      legalLabel: "Open source & legal",
      hidden: true,
      about:
        "Database lirik komunitas milik proyek open-source Better Lyrics. Kode server MIT, endpoint baca publik tanpa API key. Data berlisensi ODbL — gratis dipakai untuk proyek non-komersial asal dicantumkan atribusi (makanya nama sumber selalu ditampilkan di bawah lirik).",
      url: "https://unison.boidu.dev/",
    },
    {
      id: "lrclib",
      name: "LRCLIB",
      sync: "LINE",
      openSource: true,
      legalStatus: "legal",
      legalLabel: "Open source & legal",
      about:
        "Database lirik terbuka (lrclib.net). API publik, gratis, tanpa API key. Kode & datanya open source.",
      url: "https://lrclib.net/",
    },
    {
      id: "lrcmux",
      name: "lrcmux",
      sync: "LINE",
      openSource: true,
      legalStatus: "legal",
      legalLabel: "Open source & legal",
      about:
        "Agregator lirik open source (MIT, github.com/f1nniboy/lrcmux). Instance publiknya di lrcmux.dev menembak beberapa provider sekaligus (a.l. LRCLIB, Musixmatch, Genius) lalu mengembalikan hasil terbaik — gratis, tanpa API key.",
      url: "https://lrcmux.dev/",
    },
  ];

  // Urutan default (index 0 = prioritas tertinggi, dicoba lebih dulu).
  const YTM_DEFAULT_SOURCE_ORDER = [
    { id: "betterlyrics", enabled: true },
    { id: "unison", enabled: true },
    { id: "lrclib", enabled: true },
    { id: "lrcmux", enabled: true },
  ];

  function ytmGetSourceMeta(id) {
    return YTM_LYRIC_SOURCES.find((s) => s.id === id) || null;
  }

  // Gabungkan urutan yang tersimpan di storage dengan daftar master:
  // - entri yang id-nya sudah tidak ada di daftar master (mis. sumber lama
  //   yang dihapus) otomatis di-skip.
  // - sumber baru yang ditambahkan lewat update ekstensi otomatis nempel di
  //   akhir list (nonaktif) supaya nggak hilang & nggak tiba-tiba aktif.
  function ytmNormalizeSourceOrder(stored) {
    const list = Array.isArray(stored) ? stored : [];
    const seen = new Set();
    const normalized = [];
    for (const entry of list) {
      if (!entry || typeof entry.id !== "string") continue;
      if (!ytmGetSourceMeta(entry.id) || seen.has(entry.id)) continue;
      seen.add(entry.id);
      normalized.push({ id: entry.id, enabled: Boolean(entry.enabled) });
    }
    for (const def of YTM_DEFAULT_SOURCE_ORDER) {
      if (!seen.has(def.id)) {
        seen.add(def.id);
        normalized.push({ id: def.id, enabled: def.enabled });
      }
    }
    return normalized;
  }

  root.YTM_LYRIC_SOURCES = YTM_LYRIC_SOURCES;
  root.YTM_DEFAULT_SOURCE_ORDER = YTM_DEFAULT_SOURCE_ORDER;
  root.ytmGetSourceMeta = ytmGetSourceMeta;
  root.ytmNormalizeSourceOrder = ytmNormalizeSourceOrder;
})(typeof globalThis !== "undefined" ? globalThis : this);
