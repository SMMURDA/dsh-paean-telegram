# DSH Paean Telegram

Jembatan **Telegram native untuk DeepSeek Harness (DSH)**. Kamu bisa mengobrol dengan agen
Harness-mu, dan mengendalikan seluruh harness, langsung dari ponsel: kirim pesan dan agen
menjawab di chat; sisanya — sesi, model, workspace, goal, skill, plugin, berkas host — cukup
satu ketukan pada bilah tombol yang selalu tampil.

**Tidak ada server yang perlu dijalankan**: plugin ini dipasang di dalam proses Host Harness dan
berbicara langsung ke Telegram Bot API lewat long polling.

| | |
|---|---|
| Nama paket | `dsh-telegram` (tidak diubah: instalasi profil merujuk nama ini) |
| Versi | `0.4.0` |
| Kebutuhan | Node.js >= 22, sebuah profil DSH (diuji pada Harness `0.1.0-rc.21` dengan `@deepseek-ai/*` `0.2.1-alpha.1`) |
| Dependensi runtime | `grammy` |
| Lisensi | MIT (lihat [LICENSE](LICENSE)) |

> **Repositori ini sebuah fork.** Basisnya [xqicxx/dsh-telegram](https://github.com/xqicxx/dsh-telegram)
> (MIT); lisensi dan nota hak cipta aslinya dipertahankan. Build ini menambahkan
> **penyesuaian kompatibilitas API host dsh 0.2.x** — lihat
> [Perubahan lokal pada build ini](#perubahan-lokal-pada-build-ini).

---

## Daftar isi

- [Yang kamu dapatkan](#yang-kamu-dapatkan)
- [Mulai cepat](#mulai-cepat)
- [Memasang ke profil DSH](#memasang-ke-profil-dsh)
- [Token bot](#token-bot)
- [Konfigurasi](#konfigurasi)
- [Roster chat (siapa yang boleh bicara ke bot)](#roster-chat-siapa-yang-boleh-bicara-ke-bot)
- [Perintah](#perintah)
- [Bilah tombol](#bilah-tombol)
- [Kartu](#kartu)
- [Tool untuk agen](#tool-untuk-agen)
- [Media dan lampiran](#media-dan-lampiran)
- [Persetujuan dan pertanyaan](#persetujuan-dan-pertanyaan)
- [Auto-compaction dan notifikasi tugas panjang](#auto-compaction-dan-notifikasi-tugas-panjang)
- [Model keamanan](#model-keamanan)
- [Kompatibilitas runtime](#kompatibilitas-runtime)
- [Pengembangan](#pengembangan)
- [Pemecahan masalah](#pemecahan-masalah)
- [Perubahan lokal pada build ini](#perubahan-lokal-pada-build-ini)
- [Kredit dan lisensi](#kredit-dan-lisensi)

---

## Yang kamu dapatkan

- **Mengobrol dengan agen**: setiap teks yang kamu kirim menjadi satu turn untuk sesi yang
  terikat pada chat itu. Aliran penalaran (reasoning) dan pemanggilan tool tampil dalam satu
  pesan yang diedit di tempat.
- **Kendali harness penuh dari ponsel**: sesi (daftar / resume / fork / rename / arsip), model
  dan tingkat reasoning, workspace dan folder proyek aktif, goal, todo, antrean inbox agen,
  skill, subagen, preset agen, plugin terpasang, kredensial (hanya deskripsi), pengaturan host,
  job latar belakang, penelusuran berkas host, serta riwayat sesi.
- **Kwitansi turn dan status hidup**: satu baris ringkasan setelah tiap turn (turn, step,
  pemanggilan tool, token, rasio cache) dan kartu status yang terus diperbarui selama agen
  bekerja.
- **Tool untuk agen**: agen bisa mengirim pesan dan berkas balik kepadamu lewat jembatan yang
  sama.

## Mulai cepat

```bash
# 1. ambil kodenya
git clone https://github.com/SMMURDA/dsh-paean-telegram.git
cd dsh-paean-telegram

# 2. OPSIONAL build ulang — dist/ sudah ikut ter-commit, jadi ini hanya perlu setelah mengubah src
npm ci && npm run build

# 3. pasang ke profil DSH-mu (lihat bagian berikutnya)
# 4. buat <workspace>/.pi/telegram.json berisi chat id-mu (lihat Konfigurasi)
# 5. ekspor token bot, muat ulang harness, lalu kirim /start ke bot-mu
```

## Memasang ke profil DSH

Sebuah **profil** DSH menentukan plugin apa saja yang dimuat oleh proses Harness. Pilih salah
satu jalur berikut.

### Jalur A — `plugin_manager` (disarankan)

1. Clone repositori ini ke lokasi permanen.
2. Opsional `npm ci && npm run build` (`dist/` yang ikut ter-commit sudah bisa dipakai).
3. Dari sesi DSH, pasang bundle dari direktori **absolut**:

   ```
   plugin_manager(action: "install_bundle", target: "/path/absolut/ke/dsh-paean-telegram")
   ```

   Berkas patch bundle yang disertakan di [cordis.patch.yml](cordis.patch.yml) memasang plugin:

   ```yaml
   - insert:
       - id: telegram
         name: dsh-telegram
   ```

4. Muat ulang harness bila profilmu bertipe startup.

### Jalur B — perkabelan profil manual

Inilah yang dipakai deployment ini, dan praktis kalau kamu ingin mengubah kode di tempat.

1. Buat profil bergantung pada direktorinya (pemasangan symlink, sehingga perubahan langsung
   terpakai setelah harness dimuat ulang):

   ```jsonc
   // ~/.dsh/profiles/<profil>/package.json
   {
     "dependencies": {
       "dsh-telegram": "link:/path/absolut/ke/dsh-paean-telegram"
     }
   }
   ```

   Bila harness menegakkan kompatibilitas versi plugin/runtime, ia mencatat pasangan yang
   diizinkan di `~/.dsh/profiles/<profil>/compatibility.json`, misalnya:

   ```json
   { "dsh-telegram@0.4.0": ["0.2.1-alpha.1"] }
   ```

   **Jangan ubah versi paket** saat memakai cara ini: kunci pengecualian itu memuat nomor versi,
   dan ketidakcocokan bisa membuat harness menolak plugin saat dimuat.

2. Tambahkan baris plugin ke patch profil (`~/.dsh/profiles/<profil>/cordis.patch.yml`):

   ```yaml
   - insert:
       - id: telegram
         name: dsh-telegram
   ```

   Kalau kamu masih menyimpan jembatan Telegram lain, matikan salah satunya — dua poller dengan
   token bot yang sama akan berebut `getUpdates`. Baris yang dimatikan tampak seperti:

   ```yaml
   - id: other-telegram-bridge
     name: "@local/some-other-bridge"
     disabled: true
   ```

3. Muat ulang proses harness agar Host memuat plugin ini.

## Token bot

Buat bot lewat [@BotFather](https://t.me/BotFather) dan salin tokennya. Plugin ini tidak pernah
menulis token ke mana pun; ia hanya membacanya, dengan urutan:

1. Variabel lingkungan `TELEGRAM_BOT_TOKEN` pada proses harness.
2. Berkas yang ditunjuk `TELEGRAM_BOT_TOKEN_FILE`.
3. `.telegram-token` di samping paket (di-ignore git, `chmod 600`) — berguna untuk checkout lokal
   yang harus bertahan melewati restart tanpa mengatur shell.

```bash
# variabel lingkungan (untuk harness yang dijalankan manual)
export TELEGRAM_BOT_TOKEN='<token dari BotFather>'

# atau berkas lokal di samping checkout
printf '%s' '<token dari BotFather>' > /path/absolut/ke/dsh-paean-telegram/.telegram-token
chmod 600 /path/absolut/ke/dsh-paean-telegram/.telegram-token
```

## Konfigurasi

Konfigurasi berada di **`<workspace>/.pi/telegram.json`** (satu berkas per akar workspace).
Semua kunci opsional; kunci yang tidak ada memakai nilai bawaan di bawah. Berkas ini divalidasi
saat dimuat dan bisa diubah langsung dari chat dengan `/config get <path>` dan
`/config set <path> <value>`.

| Kunci | Tipe | Bawaan | Arti |
|---|---|---|---|
| `security.allowedChatIds` | `number[]` | `[]` | Daftar putih chat id untuk pesan masuk. **Kosong berarti SEMUA chat ditolak.** |
| `security.browseRoots` | `string[]` | tidak ada | Daftar putih path absolut opsional untuk membatasi penelusuran host/workspace (`/ls`, `/mkdir`, `/open`, pembuatan workspace). Tidak ada = tanpa batas. |
| `security.selfAllow` | `boolean` | aktif (tidak ada) | Saklar mati untuk bootstrap mandiri: tombol "Allow this chat" pada pesan penolakan. `false` membuat ketukan itu hanya menjawab teks penolakan dan tidak menyentuh roster. |
| `watch.autoStart` | `boolean` | `false` | Mulai long polling otomatis saat plugin dipasang. |
| `inbound.defaultMode` | `"auto-handle"` \| `"queue-only"` \| `"muted"` | `"auto-handle"` | Perlakuan teks masuk sebelum sampai ke agen. |
| `inbound.rules` | `{chatId?, pattern?, mode}[]` | `[]` | Aturan berurutan; yang cocok pertama menang, jika tidak ada pakai `inbound.defaultMode`. `pattern` adalah substring tanpa beda huruf besar/kecil. |
| `outbound.parseMode` | `"HTML"` | `"HTML"` | Mode parse Telegram untuk keluaran asisten. Markdown dari model dinormalkan lebih dulu ke HTML Telegram yang valid; kartu selalu HTML. |
| `outbound.disableNotification` | `boolean` | `false` | Kirim tanpa suara. |
| `outbound.maxRetries` | `number` | `3` | Percobaan ulang per pesan saat 429 / gangguan jaringan. |
| `outbound.sendRatePerSecond` | `number` | `20` | Anggaran kirim global (batas aman Bot API adalah 30). |
| `outbound.maxMessageLength` | `number` | `4096` | Batas keras satu payload; teks lebih panjang dipecah menjadi beberapa bagian. |
| `outbound.liveFeed` | `boolean` | `true` | Satu pesan yang diedit di tempat selama turn mengalir (visibilitas thinking + tool call). Bisa diubah tanpa restart. |
| `compact.threshold` | `number` | `0.8` | Lakukan compaction saat permintaan terakhir memakai lebih dari fraksi ini dari context window. |
| `compact.policy` | `"auto"` \| `"ask"` \| `"never"` | `"ask"` | Compact otomatis, tanya dulu, atau diam. |
| `compact.cooldownMs` | `number` | `300000` | Jeda minimum antar pemicu untuk satu sesi. |
| `workspace.activePath` | `string` | tidak ada (dir boot) | Folder proyek aktif; sesi baru dibuat di bawahnya. Atur dari chat dengan `/project`. |
| `mode.name` | `string` | `""` | Label tampilan opsional untuk kartu status. |
| `model.provider` / `model.model` | `string` | bawaan profil | Model bawaan milik Telegram, sehingga bot bisa memakai model berbeda dari web. |
| `reasoning.effort` | `"minimal"` \| `"low"` \| `"medium"` \| `"high"` \| `"max"` | `medium` | Tingkat reasoning per chat; sebuah direktif ditambahkan di depan pesan masuk. |
| `media.transcribe.baseUrl` | `string` | bawaan penyedia | Endpoint transkripsi kompatibel-OpenAI untuk pesan suara. |
| `media.transcribe.apiKey` | `string` | tidak ada | Tanpa kunci = transkripsi dimatikan, disertai panduan alih-alih dijatuhkan diam-diam. |
| `media.transcribe.model` | `string` | bawaan paket | Nama model transkripsi. |
| `interactive.userQuestions` | `"both"` \| `"telegram"` \| `"web"` \| `"auto"` | `"both"` | UI mana yang memiliki `ask_user_question` dan kartu persetujuan. `both` mencerminkan ke Telegram dan web; siapa pun yang menjawab lebih dulu menyelesaikan kartu di sisi lain. |
| `interactive.allowByTool` | `string[]` | `[]` | Nama tool yang diizinkan permanen setelah menekan "Allow forever (by tool)". Cabut dengan `/config set interactive.allowByTool []`. |
| `notify.onComplete` | `boolean` | `true` | Kirim kwitansi baru (berbunyi) saat turn goal selesai. |
| `notify.onLongTask` | `boolean` | `true` | Edit kartu progres setiap 30 detik agar durasi terus bergerak. |

Berkas minimal yang sudah berfungsi:

```json
{
  "security": { "allowedChatIds": [123456789] },
  "watch": { "autoStart": true }
}
```

## Roster chat (siapa yang boleh bicara ke bot)

Daftar putih chat id adalah satu-satunya batas otorisasi pesan masuk, dan **daftar kosong
menolak semua orang**. Cara bootstrap yang aman:

1. Masukkan chat id-mu ke `security.allowedChatIds`. Belum tahu id-nya? Kirim `/start` ke bot —
   pesan penolakannya menyebut chat id yang dilihatnya.
2. Atau biarkan daftar kosong lalu tekan **"Allow this chat"** pada pesan penolakan itu:
   bootstrap sekali ketuk yang menambahkan chat ke roster (matikan dengan
   `security.selfAllow: false`).
3. Tool agen `telegram_status` melaporkan chat yang dikenal jembatan.

Hanya chat dalam daftar putih yang menerima kartu, perintah, atau input interaktif yang
tertunda. Selain itu hanya dijawab teks penolakan, tanpa apa pun.

## Perintah

Ketik `/help` di chat untuk daftar ini; `/start` juga mendaftarkan menu perintah BotFather.

| Perintah | Kegunaan |
|---|---|
| `/start` | Sambutan + bilah tombol tetap |
| `/menu` | Kartu menu inti |
| `/new` | Sesi baru di workspace |
| `/compact` | Compact sesi saat ini |
| `/abort` | Batalkan turn yang berjalan |
| `/stop` | Tutup sesi chat ini |
| `/status` | Kartu status hidup |
| `/queue` | Periksa atau ubah inbox agen |
| `/todo` | Tampilkan daftar todo sesi saat ini |
| `/sessions` | Daftar sesi (dikelompokkan per proyek) |
| `/history [sessionId] [turns]` | Trajektori sesi, dikelompokkan per turn |
| `/rename <judul>` | Ganti nama sesi saat ini |
| `/fork [atSeq]` | Fork sesi saat ini |
| `/use <sessionId>` | Pindah ke sebuah sesi (di-resume bila sudah dingin) |
| `/archive <sessionId>` | Arsipkan sebuah sesi |
| `/workspaces`, `/workspacecreate` | Daftar / buat workspace |
| `/project [path]`, `/pickdir` | Pilih folder proyek aktif |
| `/models` | Telusuri penyedia dan model |
| `/goals`, `/goal <tujuan> [maxRounds]`, `/goalcreate`, `/goalclear` | Goal |
| `/presets` | Preset agen (pilih saat sesi masih kosong; berpindah di tengah sesi akan fork) |
| `/skills`, `/subagents`, `/plugins`, `/jobs` | Daftar inventaris |
| `/hostsettings`, `/settingsreplace`, `/settingsmutate` | Pengaturan host |
| `/credentials` | Daftar kredensial (hanya deskripsi, tidak pernah nilainya) |
| `/host`, `/ls [path]`, `/mkdir <path>`, `/openpath <path>` | Detail host dan penelusuran berkas |
| `/attachment <id>` | Kirim balik lampiran foto yang tersimpan |
| `/pluginadd` | Pasang plugin dinamis milikmu sendiri (JSON) |
| `/bar` | Tampilkan atau sembunyikan bilah tombol |
| `/capabilities` | Matriks kemampuan profil (seam apa saja yang tersedia di profil ini) |
| `/menucheck` | Uji mandiri setiap sumber data menu |
| `/answer <id> <text>` | Jawab pertanyaan teks bebas berdasarkan id |
| `/config get\|set <path> [value]` | Baca atau ubah konfigurasi jembatan secara langsung |
| `/help` | Semua perintah |

Teks yang bukan perintah diperlakukan sebagai prompt agen biasa untuk sesi yang terikat.

## Bilah tombol

Bilah ini menempel pada kartu sambutan dan setiap balasan, sehingga ponsel tidak perlu membuka
menu perintah: `☰ Menu`, `✨ New`, `🧹 Compact`, `🧩 Models`, `🔌 Plugins`, `🎭 Mode`,
`🧭 Sessions`, `📊 Status`, `⌛ Queue · N`, `🎯 Goal`, `📋 Todos · N`, `🧠 Reasoning`,
`🧠 Thinking`, `🎭 Presets`, `⏹ Abort`, `⏹ Stop`, plus pasangan sembunyikan/kembali yang
menyimpan bilah di balik pesan pembawa kecil.

## Kartu

Kartu adalah pesan yang diedit di tempat; `Back`/`Close` dan perpindahan kartu membersihkan
dirinya sendiri. Kartu yang tersedia: about, allowed-chats, capabilities, credentials, dynamic
plugins, feedback list, goals, history, host, host directory, host settings, jobs, mode, model
thinking, models, provider models, providers, new session, presets, preset detail, plugins,
project, queue, search, session detail, session projects, sessions, settings, settings namespace,
skills, subagent detail, subagents, todos, watch, workspace detail, workspaces.

## Tool untuk agen

Agen mendapat tujuh tool lewat jembatan ini:

| Tool | Kegunaan |
|---|---|
| `telegram_send` | Kirim pesan HTML ke satu chat yang dikenal |
| `telegram_reply` | Balas pesan masuk saat ini (gagal bila tidak ada yang tertunda) |
| `telegram_broadcast` | Kirim pesan yang sama ke beberapa chat |
| `telegram_attach` | Kirim 1–10 berkas workspace: gambar sebagai foto, `.ogg`/`.opus` sebagai pesan suara, audio lain sebagai audio, sisanya sebagai dokumen |
| `telegram_send_file` | Alias dari `telegram_attach` |
| `telegram_status` | Status jembatan: koneksi bot, status agen, antrean, chat yang dikenal |
| `telegram_mark_no_reply` | Tandai pesan masuk saat ini sengaja tidak dijawab |

`telegram_send`, `telegram_broadcast`, dan `telegram_attach` hanya menerima chat dalam roster
dan berkas di bawah akar workspace.

## Media dan lampiran

- **Foto/gambar** menjadi bagian dari turn untuk model yang mendukung vision.
- **Pesan suara** ditranskripsikan lewat endpoint kompatibel-OpenAI bila
  `media.transcribe.apiKey` diisi; jika tidak, berkasnya disimpan dan agen diberi tahu lokasinya.
- **Dokumen / video** disimpan ke direktori lampiran yang sama dan agen diberi petunjuk baca.
- **Berkas keluar**: 1–10 berkas, masing-masing ≤ 50 MB, path harus berada di dalam akar
  workspace.
- Jawaban asisten yang panjang dipecah pada batas payload Telegram 4096 karakter.

## Persetujuan dan pertanyaan

`ask_user_question` dan permintaan persetujuan tampil sebagai kartu inline dengan
**Allow once / for this session / forever (by tool)** (tool berisiko tinggi diberi tanda) plus
**Deny**. Dengan `interactive.userQuestions: "both"`, permintaan yang sama dicerminkan ke UI web
bila api-proxy host tersedia, dan sisi mana pun yang menjawab lebih dulu menyelesaikan sisi
lainnya.

## Auto-compaction dan notifikasi tugas panjang

- Dengan `compact.policy: "auto"`, jembatan melakukan compaction saat sebuah permintaan melewati
  `compact.threshold` dari context window; `"ask"` menampilkan kartu persetujuan sekali pakai
  lebih dulu. Compaction yang berhasil diumumkan beserta ringkasannya.
- Turn goal dan tool senyap yang berjalan lama mendapat heartbeat 30 detik pada kartu progres,
  dan penyelesaian goal mendorong kwitansi baru. Keduanya bisa dimatikan lewat
  `notify.onComplete` / `notify.onLongTask`.

## Model keamanan

- **Token**: dibaca dari lingkungan atau berkas `chmod 600`; tidak pernah ditulis oleh plugin,
  tidak pernah muncul di chat atau log.
- **Pesan masuk**: hanya roster chat id; daftar kosong menolak semua. Bootstrap sekali ketuk
  opsional, dimatikan dengan `security.selfAllow: false`.
- **Sistem berkas**: `/ls`, `/mkdir`, `/open`, dan pembuatan workspace bisa dibatasi dengan
  `security.browseRoots`; pengiriman lampiran dibatasi pada akar workspace.
- **Kredensial**: hanya deskripsi yang pernah didaftar — tidak pernah nilai rahasianya.

## Kompatibilitas runtime

Build ini menargetkan **API Host dsh 0.2.x** namun tetap menerima bentuk 0.1.x, sehingga satu
build jalan di keduanya. Seam yang berpindah:

| Seam | 0.1.1-rc.2 (lama) | 0.2.x (sekarang) |
|---|---|---|
| Log sesi hidup | `session.events` (array) | `session.snapshotEvents()` (method) |
| Cap waktu event | event `.at` | event `.time` |
| Roster tersimpan | `persistence.list()` → `{ id, cwd }` | `list()` → `{ header, revision }` |
| Membaca log dingin | `persistence.readRaw(id)` | `open(id, "read").read()` |

Catatan:

- Pada host 0.2.x, membaca `.events` menghasilkan *method*-nya, dan mengiterasinya melempar
  `session.events is not iterable` — kegagalan yang diperbaiki fork ini. Lihat
  [Pemecahan masalah](#pemecahan-masalah).
- `snapshotEvents()` ditandai deprecated oleh dsh ("new calls prohibited") dan di sini dipakai
  sebagai satu-satunya aksesor sinkron; migrasi jangka panjangnya adalah fold berbasis event.
- Saat memasang lewat `link:`, biarkan versi paket ini tidak berubah agar kunci pengecualian
  kompatibilitas yang tercatat tetap cocok.
- Celah yang diketahui: `/sessionlog` (unduh ZIP log sesi) masih menunjuk seam lama
  `@deepseek-ai/dsh-host-apiproxy`. Di host yang paketnya sudah tidak ada, perintah itu turun ke
  pesan "buka UI web" alih-alih membangun arsip.

## Pengembangan

```bash
npm ci             # dependensi dev (TypeScript 5.8, tipe @deepseek-ai/*)
npm run build      # tsc -p tsconfig.json  -> dist/
npm run typecheck  # tsc --noEmit
npm test           # build + node --test test/*.test.mjs
npm run check      # build + typecheck + seluruh suite
```

Suite-nya mandiri: tidak butuh token Telegram nyata dan tidak butuh jaringan.
`test/runtime-compat.test.mjs` mengunci bentuk host 0.2.x (sesi hanya-`snapshotEvents`, cap
waktu `time`, pembacaan log dingin lewat `open()`), sementara suite lama tetap mengunci bentuk
0.1.x.

Tata letak sumber:

```
src/
  index.ts                 pemasangan plugin, resolusi token, pendaftaran tool
  config.ts                skema konfigurasi, bawaan, validasi, resolusi token
  core/                    dispatch, perintah, registri kartu, binding chat, tool
  cards/                   satu modul per kartu (sessions, models, workspaces, …)
  telegram/                transport, keyboard, markdown->HTML, antrean, panel status
  harness/adapters/        adapter tipis di atas service Host (sessions, goals, llm, …)
  extensions/              harness feed, reasoning, proyeksi openclaw
```

## Pemecahan masalah

| Gejala | Sebab dan solusi |
|---|---|
| `sessions roster load failed session.events is not iterable` | Build lama di host 0.2.x. Build ulang (`npm run build`) **dan muat ulang harness** — Host yang sedang berjalan menyimpan `dist/` yang sudah diimpor sebelumnya. Sudah diperbaiki di fork ini. |
| `Telegram is not running: set TELEGRAM_BOT_TOKEN and send /telegram start.` | Token tidak terlihat oleh proses harness. Ekspor `TELEGRAM_BOT_TOKEN` (atau tulis `.telegram-token` di samping paket) lalu muat ulang. |
| `Conflict: terminated by other getUpdates request` | Dua poller memakai token bot yang sama — instans jembatan lain, atau plugin ini di dua profil. Sisakan tepat satu yang aktif. |
| `401 Unauthorized` dari Bot API | Token salah atau sudah dicabut di BotFather. |
| Bot menjawab, tapi tidak ada kartu atau perintah | Chat-mu tidak ada di `security.allowedChatIds` (roster kosong menolak semua). |
| Perubahan kode seolah tidak terpakai | Host sudah mengimpor modul lama: muat ulang harness. Mengganti `dist/` saja tidak cukup selama masih di-cache. |
| Muncul galat `compatibility` setelah versi dinaikkan | Kunci pengecualian yang tercatat di profil tidak lagi cocok; kembalikan versi paket atau tambahkan pengecualian baru. |

## Perubahan lokal pada build ini

Relatif terhadap upstream `xqicxx/dsh-telegram` di `main`:

1. **Lapisan kompatibilitas API host** di `src/harness/adapters/session-read.ts`:
   `sessionEvents()`, `hasEventLog()`, dan `eventTime()` membaca log sesi lewat bentuk apa pun
   yang disediakan host, ditambah `persistedRows()` dan `readPersistedEvents()` untuk kedua
   generasi persistence.
2. **Semua pembaca log sesi dipindahkan** ke aksesor tersebut: panel status, todo, preset (cek
   kosong, perpindahan di tengah sesi, batas fork), fork, deduplikasi persetujuan, pencarian,
   history, dan trajectory.
3. **Pembacaan pemakaian konteks** kini melihat `agent.session` dan menerima usage dari
   `assistant/message` yang sudah selesai, selain chunk stream lama.
4. **Suite regresi baru** `test/runtime-compat.test.mjs` (9 uji) yang mengunci bentuk 0.2.x;
   total suite 695 uji, semuanya lulus.
5. `dist/` sengaja ikut ter-commit supaya hasil clone bisa langsung dipasang tanpa toolchain
   TypeScript; `npm run build` menyegarkannya.
6. Log pengembangan internal milik upstream (berbahasa Mandarin: `TESTING.md`, `PLAN.md`,
   `progress.md`, `task_plan.md`, `findings.md`, `README.zh.md`, dan `docs/`) tidak dicerminkan
   di sini; semuanya tetap tersedia di repositori upstream.

Versi paket sengaja tetap `0.4.0` karena pengecualian kompatibilitas profil memakai nomor itu
sebagai kunci.

## Kredit dan lisensi

- Proyek upstream: [xqicxx/dsh-telegram](https://github.com/xqicxx/dsh-telegram) — MIT.
- Fork ini: dikelola oleh [SMMURDA](https://github.com/SMMURDA).
- Berlisensi MIT; nota hak cipta aslinya dipertahankan di [LICENSE](LICENSE). Bila kamu
  menyebarkan ulang build ini, sertakan nota dan atribusi tersebut.
