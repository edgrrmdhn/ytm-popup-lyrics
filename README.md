# YT Music Lyrics Popup

Ekstensi Chrome/Edge/Brave sederhana yang menampilkan **pop-up lirik real-time** (synced lyrics) saat kamu memutar lagu di [music.youtube.com](https://music.youtube.com), mirip tampilan lirik di Spotify. Tombolnya menyatu langsung dengan control bar asli YT Music.

## Sumber lirik

Diatur lewat panel **Settings** (klik kanan pada lirik → Settings, atau lewat halaman Options ekstensi). Sumbernya bisa di-drag untuk mengatur prioritas, dan di-uncheck untuk dinonaktifkan — persis seperti "Lyric Source Preference" di Better Lyrics.

| Sumber | Sync | Status |
|---|---|---|
| **[Better Lyrics (Unison)](https://unison.boidu.dev/)** | Line | Open source & legal — server MIT, data ODbL (gratis dipakai asal dikasih atribusi) |
| **[LRCLIB](https://lrclib.net)** | Line | Open source & legal — API publik, gratis, tanpa API key |
| **[lrcmux](https://lrcmux.dev/)** | Line | Open source & legal — agregator MIT (github.com/f1nniboy/lrcmux), menembak LRCLIB/Musixmatch/Genius sekaligus lewat endpoint publiknya, gratis tanpa API key |
| **YouTube Captions** | Line | Eksperimental — ambil caption publik dari video yang diputar; bukan database lirik resmi, nonaktif secara default |

Urutan default: Unison → LRCLIB → lrcmux → YouTube Captions (nonaktif). Saat mencari lirik, semua sumber yang aktif ditembak **paralel** (bukan satu-satu) supaya loading lebih cepat, lalu hasil dari sumber dengan prioritas tertinggi yang berhasil ketemu itulah yang dipakai. Hasil pencarian juga di-cache sementara, jadi lagu yang sama nggak perlu dicari ulang.

Sumber yang berhasil kasih lirik ditampilkan sebagai label "Source: ..." (bisa diklik ke situs sumbernya) di bawah lirik, dan **selalu berubah mengikuti sumber mana yang benar-benar dipakai** untuk lagu yang sedang tampil. List di Settings sendiri sengaja polos (nama sumber + toggle aja, tanpa badge) — detail status legal/eksperimental tiap sumber ada di tooltip saat hover.

Belum sempat mengintegrasikan Musixmatch dan BiniLyrics dari referensi kamu — Musixmatch butuh token otorisasi yang nggak dipublikasikan resminya (jadi makai tanpa izin bermasalah dari sisi legal), dan API publik BiniLyrics belum saya temukan dokumentasinya. "Lyrically API" juga belum ketemu proyek publiknya (yang ada cuma aplikasi Android dengan nama sama, bukan API). Kerangka sumbernya sudah dibuat generik (tinggal tambah satu entri di `sources.js` + satu fungsi fetch di `background.js`), jadi kalau kamu punya endpoint/dokumentasinya, gampang ditambahkan menyusul.

## Cara install (mode Developer / unpacked)

1. Ekstrak folder `ytm-lyrics-extension` ini di komputer kamu.
2. Buka Chrome/Brave, ke `chrome://extensions` (Brave: `brave://extensions`).
3. Aktifkan **Developer mode** (toggle di kanan atas).
4. Klik **Load unpacked**, lalu pilih folder `ytm-lyrics-extension`.
5. Buka `music.youtube.com`, putar lagu apa saja.
6. Di control bar kanan bawah (di sebelah kanan tombol shuffle), akan muncul ikon lirik ♪ — klik untuk membuka panel lirik (langsung dalam mode always-on-top / Picture-in-Picture).

## Cara kerja

- `content.js` mendeteksi judul lagu & artis dari player bar YT Music tiap kali lagu berganti.
- Info tersebut (+ video ID untuk sumber YouTube Captions) dikirim ke `background.js`, yang menembak semua sumber lirik yang aktif secara paralel sesuai urutan prioritas yang diatur di Settings, lalu memakai hasil dari sumber berprioritas tertinggi yang berhasil ketemu.
- Kalau lirik tersinkron (LRC) tersedia, baris lirik akan otomatis ter-highlight & auto-scroll mengikuti posisi lagu (pakai `video.currentTime`).
- **Klik salah satu baris lirik** untuk langsung pindah durasi video ke waktu baris itu (klik = seek).
- Kalau cuma ada lirik teks biasa (tanpa timestamp), akan ditampilkan apa adanya tanpa highlight.
- Kalau lagu tidak ditemukan di database manapun, panel akan menampilkan pesan "Lirik tidak ditemukan".

## Mode "always on top" (Picture-in-Picture)

Klik ikon lirik ♪ di YT Music control bar untuk langsung membuka panel sebagai window terpisah (*Document Picture-in-Picture*) yang secara default **selalu di atas** (*Always on Top*) aplikasi lain.

### Opsi Tampilan Romaji (Lirik Jepang)
Ekstensi ini mendukung transliterasi Romaji untuk lagu berbahasa Jepang. Kamu bisa memilih cara menampilkan Romaji lewat Settings:
- **Romanization (ruby text)**: Menampilkan teks Romaji berukuran kecil langsung di atas huruf Kanji/Kana Jepang (seperti furigana).
- **Romanization (default)**: Menampilkan kalimat Romaji lengkap di dalam container gelembung (*capsule bubble*) abu-abu gelap di bawah baris lirik asli dengan padding tambahan agar tampilan tidak berantakan (*cluttered*).

- Klik ikon lirik ♪ di YT Music lagi (atau tutup window liriknya) untuk menutup.
- Ikon akan berubah warna jadi putih solid saat panel lagi aktif/terbuka.
- Indikator scrollbar (atas-bawah maupun kiri-kanan) sengaja disembunyikan di window lirik maupun panel biasa — scroll tetap jalan normal, cuma bar-nya yang disembunyikan biar lebih bersih.

## Kontrol pemutaran di bawah panel

Arahkan kursor ke bagian bawah panel lirik untuk memunculkan bar kontrol (previous, play/pause, next, volume, repeat) — muncul dengan gradient hitam ke transparan supaya nggak menutupi lirik saat tidak dipakai.

- Previous/Next/Repeat meneruskan klik ke tombol asli YT Music (supaya logic antrian/playlist-nya tetap konsisten).
- Play/Pause dan Volume langsung mengontrol elemen video yang sama dengan yang dipakai YT Music.
- Ikon dipakai dari [Material Symbols](https://fonts.google.com/icons) (Google, lisensi Apache-2.0/open source) — bentuknya sama dengan ikon yang dipakai YT Music asli.
- Deteksi status "repeat aktif/nonaktif" bersifat best-effort (baca teks aria-label tombol asli), jadi bisa saja meleset kalau YT Music mengubah teksnya di update mendatang.

## Catatan

- Karena Unison & LRCLIB itu database komunitas, tidak semua lagu (terutama lagu indie/VTuber/cover niche) akan punya lirik tersinkron — kadang cuma dapat lirik plain, kadang tidak dapat sama sekali.
- Kalau mau ganti/tambah sumber lirik lain, tinggal ubah logic fetch di `background.js`.
- Ikon di folder ini dibuat sederhana secara programatik — silakan ganti `icon16.png`, `icon48.png`, `icon128.png` dengan desain sendiri kalau mau.
