// background.js
// Service worker ini bertugas mengambil data lirik dari beberapa sumber
// (didaftarkan di sources.js) menurut urutan prioritas & status
// aktif/nonaktif yang diatur user di halaman Settings:
// 1) Unison (unison.boidu.dev) — database lirik komunitas milik proyek
//    Better Lyrics. Kode server MIT, endpoint baca (GET) publik tanpa auth.
//    Data lirik berlisensi ODbL: gratis dipakai untuk proyek FOSS seperti
//    ini asal mencantumkan atribusi sumber (makanya kita tampilkan
//    "Source: ..." di panel).
// 2) LRCLIB (lrclib.net) — database lirik terbuka, publik, tanpa API key.
// 3) lrcmux (lrcmux.dev) — agregator lirik open source (MIT), menembak
//    beberapa provider (LRCLIB, Musixmatch, Genius, dst) lewat endpoint
//    kompatibel-KPoe publiknya lalu mengembalikan hasil terbaik.
// 4) YouTube Captions — caption/subtitle publik dari video yang sedang
//    diputar. Ditandai eksperimental & nonaktif secara default (lihat
//    sources.js untuk detail status legalnya).
//
// Fetch dilakukan di sini (bukan di content script) supaya tidak terkena
// batasan CSP halaman music.youtube.com.

importScripts("sources.js");

const UNISON_BASE = "https://unison.boidu.dev";
const LRCLIB_BASE = "https://lrclib.net/api";
// Romaji didapat online lewat endpoint publik Google Translate — TANPA
// perlu API key/Client ID apa pun dari user. Triknya: minta terjemahan
// ja->ja (sumber & tujuan bahasa sama) dengan dt=rm, yang membuat Google
// mengembalikan transliterasi Latin dari teks sumbernya sendiri. Ini
// endpoint yang sama dipakai situs translate.google.com, cuma dipanggil
// langsung tanpa API key resmi (dikenal luas, dipakai banyak proyek FOSS
// buat kebutuhan romanisasi tanpa key).
const ROMAJI_ENDPOINT = "https://translate.googleapis.com/translate_a/single";

async function safeFetchJson(url, signal) {
  try {
    const res = await fetch(url, { method: "GET", signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    // Termasuk saat request dibatalkan (AbortError) karena source
    // berprioritas lebih tinggi sudah ketemu duluan — nggak masalah,
    // caller bakal treat ini kayak "nggak ketemu" aja.
    return null;
  }
}

async function fetchFromUnison({ track, artist, album, duration, videoId }, signal) {
  let json = null;

  // 1. Attempt to fetch using YouTube Video ID first
  if (videoId) {
    json = await safeFetchJson(`${UNISON_BASE}/api/v1/lyrics?videoId=${videoId}`, signal);
  }

  // 2. Fallback to track and artist if Video ID lookup fails
  if (!json?.success || !json?.data?.lyrics) {
    const params = new URLSearchParams();
    if (track) params.set("song", track);
    if (artist) params.set("artist", artist);
    if (album) params.set("album", album);
    if (duration) params.set("duration", Math.round(duration));

    json = await safeFetchJson(`${UNISON_BASE}/api/v1/lyrics?${params.toString()}`, signal);
  }

  const data = json?.success ? json.data : null;
  if (!data || !data.lyrics) return null;

  const isSynced = data.syncType === "linesync" || data.format === "lrc";
  const isPlain = data.syncType === "plain" || data.format === "plain";

  // Format TTML/richsync (word-by-word) belum kita parse, jadi untuk itu
  // biarkan fallback ke sumber berikutnya supaya tetap dapat lirik.
  if (!isSynced && !isPlain) return null;

  return {
    syncedLyrics: isSynced ? data.lyrics : null,
    plainLyrics: isPlain ? data.lyrics : null,
    instrumental: false,
    sourceId: "unison",
  };
}

function getSearchQueryCandidates(track) {
  const candidates = [];
  const clean = track.replace(/[-—–:|]/g, " ").replace(/\s+/g, " ").trim();
  if (!clean) return candidates;

  candidates.push(clean);

  // Safely grab just the part before the first hyphen/separator (very effective for extra subtitles)
  const preSeparator = track.split(/[-—–:|]/)[0].trim();
  if (preSeparator && preSeparator.length !== clean.length) {
    candidates.push(preSeparator);
  }

  // Use Intl.Segmenter if the text contains Japanese, otherwise just split by spaces
  if (isJapaneseText(clean)) {
    const segs = segmentJapaneseWords(clean).filter(s => s.trim().length > 0);
    // Create multiple combination candidates representing 2 to 6 first words (e.g. 失恋ソング沢山聴いて)
    if (segs.length >= 2) candidates.push(segs.slice(0, 2).join(""));
    if (segs.length >= 3) candidates.push(segs.slice(0, 3).join(""));
    if (segs.length >= 4) candidates.push(segs.slice(0, 4).join(""));
    if (segs.length >= 5) candidates.push(segs.slice(0, 5).join(""));
    if (segs.length >= 6) candidates.push(segs.slice(0, 6).join(""));
  } else {
    const words = clean.split(/\s+/);
    if (words.length > 2) {
      candidates.push(words.slice(0, 2).join(" "));
    }
    if (words.length > 3) {
      candidates.push(words.slice(0, 3).join(" "));
    }
    if (clean.length > 10) {
      candidates.push(clean.substring(0, 10));
    }
  }

  return Array.from(new Set(candidates));
}

async function fetchFromLrclib(payload, signal) {
  const { track, artist, duration, senderTabId, videoId, album } = payload;

  // 1. Try to fetch LRCLIB via the Better Lyrics API proxy first (super fast, cached on Cloudflare)
  if (senderTabId) {
    try {
      const originalInfo = parseOriginalSongInfo(track, artist);
      const searchTrack = originalInfo ? originalInfo.track : track;
      const searchArtist = originalInfo ? originalInfo.artist : artist;

      const proxyResult = await new Promise((resolve) => {
        chrome.tabs.sendMessage(senderTabId, {
          type: "FETCH_BETTER_LYRICS_API",
          payload: { searchTrack, searchArtist, duration, videoId, album, targetProvider: "lrclib" }
        }, (response) => {
          if (chrome.runtime.lastError) {
            resolve(null);
          } else {
            resolve(response?.result || null);
          }
        });
      });
      if (proxyResult && (proxyResult.syncedLyrics || proxyResult.plainLyrics)) {
        return {
          syncedLyrics: proxyResult.syncedLyrics || null,
          plainLyrics: proxyResult.plainLyrics || null,
          instrumental: Boolean(proxyResult.instrumental),
          sourceId: "lrclib",
        };
      }
    } catch (e) {
      // Fallback to direct API
    }
  }

  const cleanTrack = track.replace(/\.{3,}|…/g, "").trim();
  const cleanArtist = (artist || "").trim();
  const durationSecs = duration ? Math.round(duration) : null;

  let data = null;

  // 2. Direct lookup fallback with /get (using duration)
  try {
    const url = new URL(`${LRCLIB_BASE}/get`);
    if (cleanTrack) url.searchParams.set("track_name", cleanTrack);
    if (cleanArtist) url.searchParams.set("artist_name", cleanArtist);
    if (durationSecs) url.searchParams.set("duration", String(durationSecs));
    
    data = await safeFetchJson(url.toString(), signal);
  } catch (e) {
    // Ignore and proceed to search fallback
  }

  // 2. Fallback to /search?track_name=...&artist_name=...
  if (!data || (!data.syncedLyrics && !data.plainLyrics)) {
    try {
      const searchUrl = new URL(`${LRCLIB_BASE}/search`);
      if (cleanTrack) searchUrl.searchParams.set("track_name", cleanTrack);
      if (cleanArtist) searchUrl.searchParams.set("artist_name", cleanArtist);
      
      const results = await safeFetchJson(searchUrl.toString(), signal);
      if (Array.isArray(results) && results.length > 0) {
        data = findBestLrcMatch(results, cleanArtist, durationSecs);
      }
    } catch (e) {
      // Ignore
    }
  }

  // 3. Last resort fallback to /search?q=artist+track
  if (!data || (!data.syncedLyrics && !data.plainLyrics)) {
    try {
      const query = `${cleanArtist} ${cleanTrack}`.trim();
      if (query) {
        const searchUrl = new URL(`${LRCLIB_BASE}/search`);
        searchUrl.searchParams.set("q", query);
        const results = await safeFetchJson(searchUrl.toString(), signal);
        if (Array.isArray(results) && results.length > 0) {
          data = findBestLrcMatch(results, cleanArtist, durationSecs);
        }
      }
    } catch (e) {
      // Ignore
    }
  }

  if (!data) return null;
  if (!data.syncedLyrics && !data.plainLyrics && !data.instrumental) return null;

  return {
    syncedLyrics: data.syncedLyrics || null,
    plainLyrics: data.plainLyrics || null,
    instrumental: Boolean(data.instrumental),
    sourceId: "lrclib",
  };
}

function findBestLrcMatch(results, cleanArtist, durationSecs) {
  const artistLower = cleanArtist.toLowerCase();
  
  // Try to find exact or close duration match first with correct artist
  let best = results.find(r => {
    if (!r.syncedLyrics && !r.plainLyrics) return false;
    const rArtist = (r.artistName || "").toLowerCase();
    const artistMatch = rArtist.includes(artistLower) || artistLower.includes(rArtist);
    if (!artistMatch) return false;
    if (durationSecs && r.duration) {
      return Math.abs(r.duration - durationSecs) <= 8; // strict duration match within 8 seconds
    }
    return true;
  });

  // If not found, try wider duration tolerance with correct artist
  if (!best) {
    best = results.find(r => {
      if (!r.syncedLyrics && !r.plainLyrics) return false;
      const rArtist = (r.artistName || "").toLowerCase();
      const artistMatch = rArtist.includes(artistLower) || artistLower.includes(rArtist);
      if (!artistMatch) return false;
      if (durationSecs && r.duration) {
        return Math.abs(r.duration - durationSecs) <= 25; // wider match within 25 seconds
      }
      return true;
    });
  }

  // If still not found, just match duration close enough
  if (!best && durationSecs) {
    best = results.find(r => {
      if (!r.syncedLyrics && !r.plainLyrics) return false;
      return r.duration && Math.abs(r.duration - durationSecs) <= 15;
    });
  }

  return best || null;
}

// ---------- lrcmux (agregator open source, lrcmux.dev) ----------
// lrcmux (github.com/f1nniboy/lrcmux, MIT) menembak beberapa provider lirik
// sekaligus (LRCLIB, Musixmatch, Genius, dst) lalu mengembalikan hasil
// terbaiknya. Instance publiknya menyediakan endpoint kompatibel-KPoe
// (protokol yang sama dipakai LyricsPlus/YouLy+) di bawah
// api.lrcmux.dev/compat/kpoe — gratis, tanpa API key. Respons berupa satu
// objek (bukan array) berisi array "lyrics" dengan { time, duration, text }
// dalam milidetik, yang kita ubah jadi format LRC di sini.
const LRCMUX_KPOE_BASE = "https://api.lrcmux.dev/compat/kpoe/v2/lyrics/get";

function msToLrcTimestamp(ms) {
  const totalMs = Math.max(0, Math.round(ms));
  const min = Math.floor(totalMs / 60000);
  const sec = Math.floor((totalMs % 60000) / 1000);
  const cs = Math.floor((totalMs % 1000) / 10);
  return `[${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")}.${String(cs).padStart(2, "0")}]`;
}

async function fetchFromLrcmux({ track, artist, album, duration }, signal) {
  const params = new URLSearchParams();
  if (track) params.set("title", track);
  if (artist) params.set("artist", artist);
  if (album) params.set("album", album);
  if (duration) params.set("duration", Math.round(duration));

  const data = await safeFetchJson(`${LRCMUX_KPOE_BASE}?${params.toString()}`, signal);
  const lines = Array.isArray(data?.lyrics) ? data.lyrics : [];
  if (lines.length === 0) return null;

  const lrcLines = [];
  for (const line of lines) {
    if (typeof line?.time !== "number" || typeof line?.text !== "string") continue;
    const text = line.text.trim();
    if (!text) continue;
    lrcLines.push(`${msToLrcTimestamp(line.time)}${text}`);
  }
  if (lrcLines.length === 0) return null;

  return {
    syncedLyrics: lrcLines.join("\n"),
    plainLyrics: null,
    instrumental: false,
    sourceId: "lrcmux",
  };
}

// ---------- YouTube Captions (eksperimental) ----------
// Ambil daftar caption track dari halaman watch (publik, nggak butuh
// login/API key), lalu ambil transkripnya dalam format json3 (dipakai
// YouTube sendiri buat nampilin caption). Ini best-effort: caption bukan
// database lirik resmi, dan halaman watch bisa berubah struktur sewaktu-
// waktu — makanya kalau parsing gagal di titik mana pun, cukup return null
// supaya source berikutnya yang dicoba (nggak pernah throw ke pemanggil).

function extractCaptionTracks(html) {
  const match = html.match(/"captionTracks":(\[[^\]]*\])/);
  if (!match) return [];
  try {
    // String di dalam HTML masih ter-escape ala JS (\\u0026 dst), jadi kita
    // parse sebagai JSON dulu baru unescape unicode escape-nya.
    const jsonSafe = match[1].replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) =>
      String.fromCharCode(parseInt(hex, 16))
    );
    const tracks = JSON.parse(jsonSafe);
    return Array.isArray(tracks) ? tracks : [];
  } catch {
    return [];
  }
}

// ---------- Better Lyrics Official API (Delegated to Content Script for CORS Bypass) ----------
async function fetchFromBetterLyrics(payload, signal) {
  try {
    const { track, artist, duration, videoId, album, senderTabId } = payload;
    if (!senderTabId) return null;

    const originalInfo = parseOriginalSongInfo(track, artist);
    const searchTrack = originalInfo ? originalInfo.track : track;
    const searchArtist = originalInfo ? originalInfo.artist : artist;

    return new Promise((resolve) => {
      chrome.tabs.sendMessage(senderTabId, {
        type: "FETCH_BETTER_LYRICS_API",
        payload: { searchTrack, searchArtist, duration, videoId, album }
      }, (response) => {
        if (chrome.runtime.lastError) {
          resolve(null);
        } else {
          resolve(response?.result || null);
        }
      });
    });
  } catch (error) {
    return null;
  }
}

const SOURCE_FETCHERS = {
  betterlyrics: fetchFromBetterLyrics,
  unison: fetchFromBetterLyrics,
  lrclib: fetchFromLrclib,
  lrcmux: fetchFromLrcmux,
};

function getSourceOrder() {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(["ytmLyricsSourceOrder"], (res) => {
        resolve(ytmNormalizeSourceOrder(res?.ytmLyricsSourceOrder));
      });
    } catch {
      resolve(YTM_DEFAULT_SOURCE_ORDER.slice());
    }
  });
}

// ---------- Cache hasil pencarian ----------
// Optimasi tambahan: lagu yang sama (misalnya balik ke lagu sebelumnya,
// atau replay) langsung kepakai hasil sebelumnya tanpa nembak API lagi
// sama sekali. Cache di memori service worker aja (sengaja sederhana,
// nggak butuh persist ke storage) dengan batas ukuran biar nggak numpuk.
const lyricsCache = new Map(); // key -> hasil fetchLyrics()
const LYRICS_CACHE_MAX = 100;

// Load persistent caches on startup to prevent V3 service worker termination clearing the cache
chrome.storage?.local?.get(["persistentLyricsCache", "persistentRomajiCache"], (res) => {
  if (res?.persistentLyricsCache) {
    const cleanedCache = {};
    let changed = false;
    for (const [k, v] of Object.entries(res.persistentLyricsCache)) {
      if (v && v.found) {
        if (!v.sourceId && v.source) v.sourceId = typeof v.source === "string" ? v.source.toLowerCase() : null;
        const meta = ytmGetSourceMeta(v.sourceId);
        if (!v.source || v.source === v.sourceId) v.source = meta?.name || v.source || v.sourceId;
        if (!v.sourceUrl && meta?.url) v.sourceUrl = meta.url;
      }
      if (v && v.found && v.syncedLyrics && !v.syncedLyrics.includes("[")) {
        changed = true; // remove invalid sync lyrics from persistent storage cache
        continue;
      }
      if (v && v.found && v.plainLyrics === "SYNCED_ONLY") {
        changed = true; // remove failed lookups from persistent storage cache
        continue;
      }
      lyricsCache.set(k, v);
      cleanedCache[k] = v;
    }
    if (changed) {
      chrome.storage?.local?.set({ persistentLyricsCache: cleanedCache }).catch(() => {});
    }
  }
  if (res?.persistentRomajiCache) {
    for (const [k, v] of Object.entries(res.persistentRomajiCache)) {
      romajiWordCache.set(k, v);
    }
  }
});

function cacheKeyFor({ track, artist }) {
  return `${(track || "").trim().toLowerCase()}::${(artist || "").trim().toLowerCase()}`;
}

function setCache(key, value) {
  if (!value || !value.found) return; // Do not cache failed lookups at all!

  lyricsCache.set(key, value);
  if (lyricsCache.size > LYRICS_CACHE_MAX) {
    const oldestKey = lyricsCache.keys().next().value;
    lyricsCache.delete(oldestKey);
  }
  try {
    const obj = {};
    lyricsCache.forEach((val, k) => {
      // Only persist successful matches to local storage
      if (val && val.found) {
        obj[k] = val;
      }
    });
    chrome.storage?.local?.set({ persistentLyricsCache: obj });
  } catch (e) {
    // Ignore
  }
}

// Batas waktu tunggu per source — kalau ada source yang nge-hang (nggak
// pernah resolve/reject), ini yang bikin proses milih lirik nggak ikut
// macet nungguin selamanya. Sengaja dibedain: ytcaptions butuh 2 request
// berurutan (halaman watch + track caption-nya) jadi kasih jatah lebih.
const FETCH_TIMEOUT_MS = 12000;
const FETCH_TIMEOUT_MS_YTCAPTIONS = 12000;

// Bungkus promise supaya "menyerah" (resolve null) kalau kelamaan, tanpa
// nunggu promise aslinya beneran selesai/gagal dulu.
function withTimeout(promise, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      }
    );
  });
}

function parseOriginalSongInfo(track, artist) {
  let cleanTrack = (track || "").replace(/\.{3,}|…/g, "").trim();
  let cleanArtist = artist;
  let isCover = false;

  const coverKeywords = /\b(cover|reupload|re-upload|re\s+upload|nightcore|slowed|reverb|remix|bootleg|mashup|tribute)\b/i;
  if (coverKeywords.test(cleanTrack)) {
    isCover = true;
  }

  // 1. Extract original artist from brackets: e.g. "(Yoasobi Cover)"
  const bracketArtistRegex = / (?:\(|\[)([^)\]]+?)\s+cover(?:\)|\])/i;
  const matchBracket = cleanTrack.match(bracketArtistRegex);
  let extractedArtist = null;
  if (matchBracket) {
    extractedArtist = matchBracket[1].trim();
    isCover = true;
  }

  // 2. Perform safe cleaning
  // Remove brackets/parentheses ONLY IF they contain known video/cover/metadata tags
  const coverMetadataRegex = /\b(cover|reupload|re-upload|re\s+upload|nightcore|slowed|reverb|remix|bootleg|mashup|tribute|acoustic|instrumental|lyrics|subbed|translation|sub|mv|official\s+video|official\s+audio|lyric\s+video|video\s+clip|audio\s+only|music\s+video|hd|1080p|4k|karaoke|feat\.?|ft\.?|prod\.?|version|ver\.?|color\s+coded|romaji|english|vocal|vocals)\b/i;
  
  // Safely remove bracketed tags that contain cover metadata keywords
  cleanTrack = cleanTrack.replace(/\([^)]*\)/g, (match) => coverMetadataRegex.test(match) ? "" : match)
                         .replace(/\[[^\]]*\]/g, (match) => coverMetadataRegex.test(match) ? "" : match);

  // Remove common video/cover tags outside brackets (only at the end of the string)
  const trailingMetadataRegex = new RegExp(`\\s*-?\\s*${coverMetadataRegex.source}.*$`, 'i');
  cleanTrack = cleanTrack.replace(trailingMetadataRegex, "");

  // Remove vertical bar separator and anything after it
  if (cleanTrack.includes("|")) {
    cleanTrack = cleanTrack.split("|")[0];
  }

  // 3. Split by dash: "YOASOBI - Idol" or "Idol - YOASOBI"
  if (cleanTrack.includes(" - ") || cleanTrack.includes(" — ") || cleanTrack.includes(" – ")) {
    const parts = cleanTrack.split(/\s+[-—–]\s+/);
    if (parts.length >= 2) {
      const partA = parts[0].trim();
      const partB = parts[1].trim();

      const coverArtistWords = artist.toLowerCase().split(/\s+/);
      const containsCoverArtistWord = (str) => {
        const s = str.toLowerCase();
        return coverArtistWords.some(w => w.length > 2 && s.includes(w));
      };

      if (containsCoverArtistWord(partA)) {
        cleanTrack = partB;
        cleanArtist = extractedArtist || partA;
      } else if (containsCoverArtistWord(partB)) {
        cleanTrack = partA;
        cleanArtist = extractedArtist || partB;
      } else if (isJapaneseText(partA) && !isJapaneseText(partB)) {
        cleanTrack = partA;
      } else if (isJapaneseText(partB) && !isJapaneseText(partA)) {
        cleanTrack = partB;
      } else {
        // If we can't be sure which part is the artist, assume the first part is the track
        cleanTrack = partA;
      }
    }
  } else {
    if (extractedArtist) {
      cleanArtist = extractedArtist;
    }
  }

  // Final sanitization of leading/trailing symbols/punctuation
  cleanTrack = cleanTrack.replace(/^[-—–\s|/\\,.:;]+|[-—–\s|/\\,.:;]+$/g, "").replace(/\s+/g, " ").trim();
  cleanArtist = cleanArtist.replace(/^[-—–\s|/\\,.:;]+|[-—–\s|/\\,.:;]+$/g, "").replace(/\s+/g, " ").trim();

  if (cleanTrack && cleanArtist && (cleanTrack.toLowerCase() !== track.toLowerCase() || cleanArtist.toLowerCase() !== artist.toLowerCase())) {
    return { track: cleanTrack, artist: cleanArtist, isCover };
  }
  return isCover ? { track: cleanTrack, artist: cleanArtist, isCover } : null;
}

async function executeSearch(payload, signal, enabledIds) {
  if (!enabledIds || enabledIds.length === 0) return null;

  const results = new Array(enabledIds.length).fill(undefined);
  const tasks = enabledIds.map(async (id, idx) => {
    const fetcher = SOURCE_FETCHERS[id];
    if (!fetcher) {
      results[idx] = null;
      return null;
    }
    const timeoutMs = id === "ytcaptions" ? FETCH_TIMEOUT_MS_YTCAPTIONS : FETCH_TIMEOUT_MS;
    const run = fetcher(payload, signal).catch(() => null);
    const data = await withTimeout(run, timeoutMs).catch(() => null);
    results[idx] = data || null;
    return { idx, data: data || null };
  });

  if (tasks.length === 1) {
    const res = await tasks[0];
    return res?.data || null;
  }

  // Jeda grace window 900ms untuk sumber prioritas utama (#0) agar diutamakan jika cepat
  const topResult = await Promise.race([
    tasks[0],
    new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 900))
  ]);

  if (topResult && !topResult.timeout && topResult.data) {
    return topResult.data;
  }

  // Cek apakah dalam 900ms tadi ada sumber prioritas di bawahnya yang sudah selesai duluan
  for (let i = 0; i < results.length; i++) {
    if (results[i] && results[i] !== undefined) {
      return results[i];
    }
  }

  // Jika belum ada yang selesai, tunggu sumber pertama mana pun yang berhasil menemukan lirik
  return new Promise((resolve) => {
    let completedCount = 0;
    for (let i = 0; i < tasks.length; i++) {
      tasks[i].then(({ data }) => {
        if (data) {
          resolve(data);
        } else {
          completedCount++;
          if (completedCount === tasks.length) {
            resolve(null);
          }
        }
      });
    }
  });
}

async function fetchLyrics(payload) {
  const order = await getSourceOrder();
  const enabledIds = order.filter((o) => o.enabled).map((o) => o.id);

  const cacheKey = cacheKeyFor(payload) + "::" + (payload.forceSource || "auto") + "::" + enabledIds.join(",");
  if (lyricsCache.has(cacheKey)) {
    const cached = lyricsCache.get(cacheKey);
    if (cached && cached.found) {
      if (!cached.sourceId && cached.source) cached.sourceId = typeof cached.source === "string" ? cached.source.toLowerCase() : null;
      const meta = ytmGetSourceMeta(cached.sourceId);
      if (!cached.source || cached.source === cached.sourceId) cached.source = meta?.name || cached.source || cached.sourceId;
      if (!cached.sourceUrl && meta?.url) cached.sourceUrl = meta.url;
    }
    return cached;
  }

  let enabledIdsFiltered = enabledIds;
  if (payload.forceSource && payload.forceSource !== "auto") {
    enabledIdsFiltered = [payload.forceSource];
  }

  if (enabledIdsFiltered.length === 0) {
    const result = { found: false };
    setCache(cacheKey, result);
    return result;
  }

  const controller = new AbortController();

  // 1. Try search with original payload first
  let picked = await executeSearch(payload, controller.signal, enabledIdsFiltered);

  // 2. If not found, try fallback search with parsed original song details (covers/reuploads)
  if (!picked) {
    const originalInfo = parseOriginalSongInfo(payload.track, payload.artist);
    if (originalInfo) {
      picked = await executeSearch(
        { track: originalInfo.track, artist: originalInfo.artist, duration: payload.duration, videoId: payload.videoId, isCover: originalInfo.isCover, senderTabId: payload.senderTabId, album: payload.album },
        controller.signal,
        enabledIdsFiltered
      );

      // 3. Swapped track/artist fallback query
      if (!picked) {
        picked = await executeSearch(
          { ...payload, track: originalInfo.artist, artist: originalInfo.track, senderTabId: payload.senderTabId, album: payload.album },
          controller.signal,
          enabledIdsFiltered
        );
      }
    }
  }

  controller.abort();

  let result;
  if (picked) {
    const meta = ytmGetSourceMeta(picked.sourceId);
    result = {
      found: true,
      ...picked,
      source: meta?.name || picked.source || picked.sourceId,
      sourceUrl: meta?.url || picked.sourceUrl || null,
    };
  } else {
    result = { found: false };
  }

  setCache(cacheKey, result);
  return result;
}

// ---------- Romaji (lirik Jepang) ----------
// Segmentasi kata pakai Intl.Segmenter bawaan browser/V8 (locale "ja",
// granularity "word") — sama seperti yang dipakai Chrome sendiri buat
// double-click select text Jepang, jadi nggak butuh kamus/dictionary
// tambahan. Tiap kata unik yang mengandung huruf Jepang lalu diromanisasi
// lewat trik Google Translate di atas, di-cache di memori service worker
// (romajiWordCache) biar kata yang berulang (misalnya reff lagu) nggak
// nembak endpoint berkali-kali. Satu baris lirik = satu array segmen
// {surface, romaji}; segmen non-Jepang (spasi/tanda baca) romaji-nya null,
// biar content script cukup nampilin teks polos untuk bagian itu.

const romajiWordCache = new Map(); // kata jepang -> romaji string | null
const ROMAJI_CACHE_MAX = 500;

function setRomajiWordCache(word, romaji) {
  romajiWordCache.set(word, romaji);
  if (romajiWordCache.size > ROMAJI_CACHE_MAX) {
    const oldestKey = romajiWordCache.keys().next().value;
    romajiWordCache.delete(oldestKey);
  }
  try {
    const obj = {};
    romajiWordCache.forEach((val, k) => { obj[k] = val; });
    chrome.storage?.local?.set({ persistentRomajiCache: obj });
  } catch (e) {
    // Ignore
  }
}

function isJapaneseText(text) {
  return /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/.test(text || "");
}

function segmentJapaneseWords(text) {
  if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
    try {
      const segmenter = new Intl.Segmenter("ja", { granularity: "word" });
      return Array.from(segmenter.segment(text), (s) => s.segment);
    } catch {
      // lanjut ke fallback kasar di bawah
    }
  }
  return [text];
}

function looksLikeRomaji(str) {
  if (typeof str !== "string") return false;
  const s = str.trim();
  if (!s || s.toLowerCase() === "ja") return false;
  // Pastikan tidak mengandung karakter huruf Jepang (Kanji, Hiragana, Katakana)
  return !/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/.test(s);
}

// Respons translate_a/single itu nested array yang nggak didokumentasikan
// resmi oleh Google, jadi daripada asumsi index yang pasti (rawan berubah
// sewaktu-waktu), kita cari secara defensif: telusuri seluruh isi respons,
// ambil string ber-alfabet Latin pertama yang bukan sama persis dengan
// teks sumbernya.
function findRomajiInResponse(node, skipText) {
  if (typeof node === "string") {
    const s = node.trim();
    if (s && s !== skipText && looksLikeRomaji(s)) return s;
    return null;
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findRomajiInResponse(item, skipText);
      if (found) return found;
    }
  }
  return null;
}

function getRomajiFromResponse(data) {
  if (!data || !Array.isArray(data[0])) return null;
  const parts = [];
  for (const seg of data[0]) {
    if (Array.isArray(seg) && typeof seg[3] === "string") {
      parts.push(seg[3].trim());
    }
  }
  if (parts.length > 0) {
    return parts.join(" ");
  }
  return null;
}

async function fetchRomajiForLine(text, signal) {
  if (!text) return null;
  if (!isJapaneseText(text)) {
    return [{ surface: text, romaji: null }];
  }
  if (romajiWordCache.has(text)) {
    return romajiWordCache.get(text);
  }

  try {
    const url = `${ROMAJI_ENDPOINT}?client=gtx&sl=ja&tl=ja&dt=rm&dt=t&q=${encodeURIComponent(text)}`;
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error("bad status " + res.status);
    const data = await res.json();
    const romaji = findRomajiInResponse(data, text);
    if (!romaji) {
      const fallback = [{ surface: text, romaji: null }];
      setRomajiWordCache(text, fallback);
      return fallback;
    }

    // Split by spaces to keep word spacing alignment if possible
    const jpWords = text.split(/\s+/);
    const rmWords = romaji.split(/\s+/);

    let result;
    if (jpWords.length === rmWords.length) {
      result = jpWords.map((surface, i) => ({
        surface,
        romaji: rmWords[i],
      }));
    } else {
      result = [{ surface: text, romaji }];
    }

    setRomajiWordCache(text, result);
    return result;
  } catch (e) {
    if (e.name === "AbortError") {
      throw e;
    }
    const fallback = [{ surface: text, romaji: null }];
    setRomajiWordCache(text, fallback);
    return fallback;
  }
}

let currentRomajiController = null;

async function fetchRomajiBatch(lines) {
  if (currentRomajiController) {
    try {
      currentRomajiController.abort();
    } catch (e) {}
  }
  currentRomajiController = new AbortController();
  const signal = currentRomajiController.signal;

  try {
    for (let i = 0; i < lines.length; i++) {
      if (signal.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }
      const line = lines[i];
      if (!line || !isJapaneseText(line) || romajiWordCache.has(line)) {
        continue;
      }
      
      await fetchRomajiForLine(line, signal);

      // Jeda 50ms antar-request untuk mencegah burst rate-limit
      if (i < lines.length - 1) {
        const nextLine = lines[i + 1];
        if (nextLine && isJapaneseText(nextLine) && !romajiWordCache.has(nextLine)) {
          await new Promise((resolve, reject) => {
            const onAbort = () => {
              clearTimeout(timeoutId);
              reject(new DOMException("Aborted", "AbortError"));
            };
            const timeoutId = setTimeout(() => {
              signal.removeEventListener("abort", onAbort);
              resolve();
            }, 50);
            signal.addEventListener("abort", onAbort);
          });
        }
      }
    }
  } catch (e) {
    if (e.name !== "AbortError") {
      console.error("Error fetching romaji batch:", e);
    }
  } finally {
    if (currentRomajiController?.signal === signal) {
      currentRomajiController = null;
    }
  }

  return lines.map(line => {
    if (!line) return null;
    if (!isJapaneseText(line)) {
      return [{ surface: line, romaji: null }];
    }
    if (romajiWordCache.has(line)) {
      return romajiWordCache.get(line);
    }
    return [{ surface: line, romaji: null }];
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "FETCH_LYRICS") {
    if (currentRomajiController) {
      try {
        currentRomajiController.abort();
      } catch (e) {}
      currentRomajiController = null;
    }
    const payload = message.payload || {};
    if (sender && sender.tab) {
      payload.senderTabId = sender.tab.id;
    }
    fetchLyrics(payload)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true; // keep the message channel open for async sendResponse
  }

  if (message?.type === "FETCH_ROMAJI") {
    const { lines } = message.payload || {};
    fetchRomajiBatch(Array.isArray(lines) ? lines : [])
      .then((result) => sendResponse({ ok: true, result }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  if (message?.type === "OPEN_SETTINGS") {
    chrome.runtime.openOptionsPage();
    return false;
  }
});
