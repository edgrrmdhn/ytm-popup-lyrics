// injected.js
// Berjalan di Main World (halaman music.youtube.com) agar bisa mengakses
// API asli pemutar YouTube Music (movie_player / ytmusic-player) yang tidak
// dapat diakses langsung dari Isolated World (content script).

(function () {
  let emitVolTimeout = null;
  let videoVolTimeout = null;

  function getPlayer() {
    return document.getElementById("movie_player") || document.querySelector("ytmusic-player");
  }

  function emitVolumeUpdate() {
    const player = getPlayer();
    const video = document.querySelector("video");
    let vol = 100;
    let muted = false;
    if (player && typeof player.getVolume === "function") {
      vol = Number(player.getVolume());
      if (isNaN(vol)) vol = 100;
      muted = typeof player.isMuted === "function" ? player.isMuted() : Boolean(video?.muted);
    } else if (video) {
      vol = Math.round(video.volume * 100);
      muted = video.muted || video.volume === 0;
    }
    document.dispatchEvent(new CustomEvent("ytm-popup-volume-update", { detail: { volume: Math.round(vol), muted } }));
  }

  // 1. Sinkronisasi Volume
  document.addEventListener("ytm-popup-set-volume", (e) => {
    const { volume, muted } = e.detail;
    const player = getPlayer();
    if (player && typeof player.setVolume === "function") {
      if (muted) {
        if (typeof player.mute === "function") {
          player.mute();
        }
      } else {
        if (typeof player.unMute === "function") {
          player.unMute();
        }
        player.setVolume(Math.round(volume));
      }
    } else {
      const video = document.querySelector("video");
      if (video) {
        video.muted = Boolean(muted);
        if (!muted) {
          video.volume = Number(volume) / 100;
        }
      }
    }

    // Sinkronkan slider volume asli YouTube Music di player bar jika ada (hanya visual, tidak memicu event loop)
    const nativeSlider = document.querySelector("tp-yt-paper-slider#volume-slider") || document.querySelector("#volume-slider");
    if (nativeSlider && typeof nativeSlider.value !== "undefined") {
      const targetVal = muted ? 0 : Math.round(volume);
      if (Number(nativeSlider.value) !== targetVal) {
        nativeSlider.value = targetVal;
      }
    }

    if (emitVolTimeout) clearTimeout(emitVolTimeout);
    emitVolTimeout = setTimeout(emitVolumeUpdate, 50);
  });

  document.addEventListener("ytm-popup-request-volume", emitVolumeUpdate);

  // Dengarkan perubahan volume dari pemutar asli
  function attachVideoListener() {
    const videoEl = document.querySelector("video");
    if (videoEl && !videoEl._ytmVolAttached) {
      videoEl._ytmVolAttached = true;
      videoEl.addEventListener("volumechange", () => {
        if (videoVolTimeout) clearTimeout(videoVolTimeout);
        videoVolTimeout = setTimeout(emitVolumeUpdate, 30);
      });
    }
  }

  attachVideoListener();
  const observer = new MutationObserver(attachVideoListener);
  observer.observe(document.documentElement, { childList: true, subtree: true });

  setTimeout(emitVolumeUpdate, 500);
  setTimeout(emitVolumeUpdate, 1500);

  // 2. Sinkronisasi Durasi (Scrubbing / Seeking)
  document.addEventListener("ytm-popup-seek-to", (e) => {
    const { seconds } = e.detail;
    const player = getPlayer();
    if (player && typeof player.seekTo === "function") {
      player.seekTo(Number(seconds), true);
    } else {
      const video = document.querySelector("video");
      if (video) {
        video.currentTime = Number(seconds);
      }
    }

    // Sinkronkan progress bar asli YouTube Music jika ada
    const progressBar = document.querySelector("tp-yt-paper-slider#progress-bar") || document.querySelector("#progress-bar");
    if (progressBar && typeof progressBar.value !== "undefined") {
      progressBar.value = Number(seconds);
      progressBar.dispatchEvent(new CustomEvent("value-change", { bubbles: true }));
      progressBar.dispatchEvent(new CustomEvent("change", { bubbles: true }));
    }
  });
})();
