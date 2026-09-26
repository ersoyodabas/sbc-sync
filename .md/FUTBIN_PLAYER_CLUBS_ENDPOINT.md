# `POST /api/sync/futbin-player-clubs` Teknik Dokumani

> Inceleme tarihi: 2026-09-25
> Backend kok: `Backend/API/Controllers/SyncController.cs`, `Backend/SERVICE/FutbinPlayerSyncService.cs`, `Backend/DTO/FutbinPlayerSyncDto.cs`, `Backend/DAL/Repositories/PlayerRepository.cs`
> Eklenti kok: `Sync/src/modules/important/background.js`, `Sync/src/modules/important/offscreen-parser.js`
> Kapsam: Bu dosya yalniz **club-id'siz** batch endpoint'ini (`futbin-player-clubs`) ve onu cagiran **Important Players** modulunu belgeler. Club-id'li varyant (`futbin-player-clubs/{clubId}`) `Sync/src/modules/latest/background.js` tarafindan kullanilir ve bu dokumanin kapsami disindadir.

## 1. Ozet

`futbin-player-clubs` iki ayri route altinda calisir:

| Route | Controller metodu | Cagiran eklenti modulu | Kapsam |
|---|---|---|---|
| `POST /api/sync/futbin-player-clubs/{clubId}` | `SaveFutbinClubPlayers` | Latest Player Sync | Tek bir kulubun oyuncu listesini yazar; `clubId`/`league_id` DB'den dogrulanir |
| `POST /api/sync/futbin-player-clubs` | `SaveFutbinFilteredPlayersBatch` | **Important Players** (bu dokuman) | Futbin'in filtreli/genel oyuncu listesinden (rating araligi + fiyat filtresi) gelen, **birden fazla kulup ve ligi ayni anda icerebilen** 1-5 sayfalik batch'leri yazar; her oyuncunun kulup/lig/millet/rarity referansi Futbin ID'sinden DB ID'sine batch icinde cozulur |

Bu ikinci route, club/league bilgisini path'ten degil, **her oyuncu satirindaki Futbin ID'lerinden** alir; bu yuzden servis katmaninda ayri ve daha kapsamli bir referans-cozumleme adimi vardir (bkz. Bolum 4).

## 2. HTTP Sozlesmesi

```
POST /api/sync/futbin-player-clubs
Content-Type: application/json
[AllowAnonymous]
```

JSON alan adlari global `SnakeCaseLower` naming policy ile (`Backend/API/Program.cs:77`) otomatik donusturulur; C# `PascalCase` property <-> JSON `snake_case` alan eslesmesi manuel yapilmaz.

### 2.1 Request govdesi — `FutbinFilteredPlayersSyncRequestDto`

| JSON alani | C# tipi | Zorunlu / kural |
|---|---|---|
| `sync_mode` | `string` | Tam olarak `"filtered_partial"` olmali (case-insensitive) |
| `disable_missing_delete` | `bool` | `true` olmali — bu endpoint hicbir zaman DB'den kayit silmez |
| `source` | `string?` | Serbest metin, log/izlenebilirlik icin (`"futbin_filtered_players"`) |
| `source_url` | `string?` | O batch'i ureten Futbin sayfa URL'si (rating/fiyat filtresi dahil) |
| `filter` | `Dictionary<string,string>` | Serbest anahtar/deger; eklenti `ps_price` ve `player_rating` gonderir |
| `page_from` | `int` | `> 0` |
| `page_to` | `int` | `>= page_from`, ve `page_to - page_from + 1 <= 5` |
| `pages_attempted` | `int` | `== page_to - page_from + 1` olmali |
| `pages_succeeded` | `int` | `== pages_attempted` olmali — kismen basarili sayfa iceren batch reddedilir |
| `players` | `List<FutbinMappedPlayerDto>` | Bkz. 2.2 |

### 2.2 Oyuncu ogesi — `FutbinMappedPlayerDto`

Eklentinin her oyuncu icin gonderdigi alanlar (bkz. Bolum 6.4 icin kaynak DOM esleme):

`futbin_club_id`, `futbin_league_id`, `futbin_nation_id`, `futbin_rarity_id`, `name`, `full_name`, `rating`, `futbin_player_id`, `futbin_player_link` (`url` ile ayni deger), `url_img_player`, `price_console`, `price_pc`, `url_img_card`, `url_img_nation`, `url_img_league`, `url_img_club`, `position_name`, `quality_code`, `nation_name`, `league_name`, `club_name`, `alternative_positions` (virgulle ayrilmis string), `active` (her zaman `true`).

DTO ayrica servis tarafinda doldurulan `club_id`, `league_id`, `quality_id`, `rarity_id`, `position_id`, `nation_id`, `fixed_name` alanlarini da tasir; bunlar eklenti tarafindan gonderilmez, servis cozumleme sirasinda set edilir (bkz. Bolum 4).

### 2.3 Yanit sekli

Tum yanitlar ortak `ReturnObject` zarfi icinde doner:

```json
{
  "result": true,
  "message": "Sayfa 1-5: 118 oyuncu insert/update islendi.",
  "error_code": null,
  "data": {
    "saved": 118,
    "inserted": 12,
    "updated": 106,
    "skipped": 4,
    "page_from": 1,
    "page_to": 5,
    "errors": ["Cristiano Ronaldo | futbin_player_id=... SKIP edildi | Sebep: ..."]
  }
}
```

### 2.4 HTTP durum kodlari

| Durum | Sebep |
|---|---|
| `200 OK` | `result: true` — batch bos bile olsa (0 oyuncu) basarili sayilir |
| `400 BadRequest` | `sync_mode`/`disable_missing_delete` uyusmuyor (`UNSAFE_SYNC_MODE`), sayfa araligi gecersiz/>5 sayfa, veya genel exception |
| `422 UnprocessableEntity` | `error_code == "CRITICAL"` — `pages_attempted`/`pages_succeeded` tutarsiz (eksik/basarisiz sayfa iceren batch) |

`request == null` durumu da `400` doner ("Request zorunludur.").

## 3. Ust Duzey Akis

```mermaid
sequenceDiagram
  participant EXT as Important Players (background.js)
  participant OFF as Offscreen parser (DOM)
  participant FUT as Futbin (HTML sayfa)
  participant API as SyncController
  participant SVC as FutbinPlayerSyncService
  participant DB as Postgres (player, club, league, nation, rarity, quality, position)

  loop Her sayfa (1..totalPages)
    EXT->>FUT: GET /27/players?...&page=N (credentials include)
    alt 403/429 veya bloklandi
      EXT->>FUT: arka plan tab ac + DOM polling (Cloudflare challenge bekle)
    end
    FUT-->>EXT: HTML
    EXT->>OFF: PARSE_FUTBIN_HTML(html)
    OFF-->>EXT: [{futbinPlayerId, ..., cardImageUrl, ...}]
    EXT->>EXT: rating filtresi + toPayloadPlayer() + dedupe
  end
  Note over EXT: her 5 sayfada bir (veya son sayfada) batch hazir
  EXT->>API: POST sync/futbin-player-clubs {page_from..page_to, players[]}
  API->>SVC: SaveFilteredPlayersAsync(request)
  SVC->>SVC: sync_mode/disable_missing_delete/sayfa dogrulama
  SVC->>DB: leagues/clubs/rarities/qualities/positions/nations SELECT (futbin_id kumesine gore)
  SVC->>SVC: her oyuncu icin club/league/nation/rarity/quality/position -> DB id cozumle
  SVC->>SVC: ValidatePlayer (zorunlu alan kontrolu)
  SVC->>DB: savePlayerList -> tek SaveChangesAsync (bulk upsert)
  DB-->>SVC: inserted/updated sayilari
  SVC-->>API: ReturnObject{saved, inserted, updated, skipped, errors}
  API-->>EXT: 200/400/422
  EXT->>EXT: sayaclari guncelle, sonraki batch'e gec
```

## 4. Servis Katmani — `SaveFilteredPlayersAsync` Adim Adim

Kaynak: `Backend/SERVICE/FutbinPlayerSyncService.cs:214-385`

1. **On kontroller** (400/422): `sync_mode`, `disable_missing_delete`, sayfa araligi (`page_from/page_to`, max 5 sayfa), sayfa tutarliligi (`pages_attempted == page_to-page_from+1`, `pages_succeeded == pages_attempted`).
2. **Ayni batch icinde dedupe**: `players` listesi `FutbinPlayerId` (pozitifse) veya `-index-1` (negatif/0 ise, her biri tekil) ile gruplanir, her grubun **son** ogesi tutulur — ayni oyuncunun batch icinde iki kez gelmesi (orn. eklenti tarafinda kacan bir dedupe durumu) son degeri kazanir.
3. **Referans kumelerini topla**: gelen oyunculardan benzersiz `futbin_club_id`, `futbin_league_id`, `futbin_rarity_id` degerleri cikarilir.
4. **Lig cozumleme**: `league.futbin_id IN (...)` ile aktif ligler tek sorguda cekilir, `futbin_id -> league` sozlugu kurulur.
5. **Kulup cozumleme**: cozulen liglerin **tum aktif kulupleri** (futbin_id'si olsun olmasin) tek sorguda cekilir — cunku bir kulup futbin_id ile eslenemezse isim benzerligiyle o ligin kulupleri arasindan aranacaktir. Iki index kurulur: `(futbin_club_id, league_id) -> club` ve `league_id -> club[]` (isim eslestirme icin).
6. **Rarity cozumleme**: `futbin_id IN (...)` **VEYA** `code == "common"` olan rarity'ler cekilir; `code == "common"` olan satir `defaultRarity` olarak ayrilir (ozel olmayan kartlarda rarity bilgisi eksikse dusulecek varsayilan).
7. **Quality/Position/Nation**: tum aktif kayitlar tek sorguda cekilir (kucuk lookup tablolari, filtreye gerek yok).
8. **Her oyuncu icin `MapFilteredPlayerReferences`** (satir 421-500) DB ID'lerini doldurur ve hata biriktirir:
   - `league_id`: `futbin_league_id` lookup'ta yoksa hata.
   - `club_id`: once `(futbin_club_id, league_id)` sozlugunde aranir; bulunamazsa **isim benzerligiyle** (`FindClubByName`, bkz. 4.1) o ligin kulupleri icinde aranir; ikisi de basarisizsa hata (`futbin_club_id not found ... isimle de eslesme yok`).
   - `quality_id`: `quality_code` normalize edilip (`NormalizeToken`) `quality.code` ile karsilastirilir; `quality_code` bos gelirse `InferQualityCode` (rarity_id 0/1 disindaysa `special`, degilse `url_img_card` dosya adindan `bronze|silver|gold` regex'i, o da yoksa rating esigi) devreye girer. **Not:** eklenti zaten `quality_code`'u kendi tarafinda hesaplayip gonderiyor; bu, servis tarafindaki ayni mantigin bir guvenlik/yedek kopyasidir.
   - `rarity_id`: `futbin_rarity_id` lookup'ta varsa dogrudan eslenir; yoksa ve kart **special degilse** `defaultRarity` (common) kullanilir; special ise ve id eslesmiyorsa/eksikse hata.
   - `position_id`: `position_name` normalize edilip her dildeki `position.name` degerleriyle karsilastirilir (`LookupNameMatches`).
   - `nation_id`: sirasiyla — (a) `nation.futbin_id == futbin_nation_id`, (b) `futbin_id` NULL olan legacy kayitlarda `icon_url`'den cikarilan asset id (`/nation/` veya `/flags/` path segmenti) eslesirse, (c) `nation.name` lokalizasyonlarindan biri `nation_name` ile eslesirse, (d) `nation.futbin_name == nation_name` ise eslenir; hicbiri tutmazsa hata.
9. **`ValidatePlayer`** (satir 621-638) ek olarak zorunlu kilar: `futbin_player_id>0`, `name` dolu, `quality_id>0`, `rarity_id>0`, `rating>0`, `position_id>0`, `nation_id>0`, `price_console` dolu ve `>=0`, `price_pc>=0`, `url_img_card`/`url_img_nation`/`url_img_league`/`url_img_club` dolu.
10. **Hatali oyuncular DB'ye yazilmadan atlanir** (`errors` listesine `BuildSkippedPlayerMessage` ile Futbin ID'leri + cozulen DB ID'leri iceren detayli mesaj eklenir); batch'in geri kalani islenmeye devam eder — **tek bir gecersiz oyuncu tum batch'i basarisiz yapmaz**.
11. **Gecerli oyuncular `player` entity'sine map edilir** ve `uow.Players.savePlayerList(entities)` cagirilir (bkz. Bolum 5).
12. Sonuc `{ saved, inserted, updated, skipped, page_from, page_to, errors }` olarak donulur.

### 4.1 Kulup isim eslestirme (`FindClubByName`)

`futbin_club_id` bulunamadiginda kullanilan yedek yol (satir 507-540):

- Isimler once Unicode normalize edilir (aksan kaldirilir, kucuk harfe cevrilir, alfanumerik olmayanlar boslukla degistirilir).
- Benzerlik skoru: tam esitlik = `1.0`; biri digerini iceriyorsa (`"benfica"` vs `"sl benfica"`, min uzunluk >= 4) = `0.9`; aksi halde Levenshtein mesafesine dayali oran.
- Esik: `ClubNameMinSimilarity = 0.8`. Esigin altindaki adaylar elenir.
- **Esitlik (tie) durumunda hicbir kulup secilmez** — iki farkli kulup ayni en yuksek skoru alirsa sonuc `null` doner ve oyuncu "isimle de eslesme yok" hatasiyla atlanir. Bu, yanlis kulube yanlislikla oyuncu atamayi engelleyen bilincli bir guvenlik onlemidir.

## 5. DB Yazma — `PlayerRepository.savePlayerList`

Kaynak: `Backend/DAL/Repositories/PlayerRepository.cs:15-115`

- **Toplu upsert, N+1 sorgu yok**: batch'teki tum `futbin_player_id` ve `url` degerleri icin **tek** bir `SELECT` ile mevcut kayitlar cekilir (`futbin_player_id IN (...) OR url IN (...)`), iki sozluge indekslenir (`byFutbinId`, `byUrl`). Yorum satirindaki gerekce: uzak DB'ye karsi sayfa basina ayri sorgu/kayit, 5 sayfalik batch'lerde istemci tarafi 30 saniyelik timeout'u asiyordu.
- **Eslestirme sirasi**: once `futbin_player_id`, bulunamazsa `url` ile mevcut kayit aranir.
- **Insert**: eslesen kayit yoksa yeni `player` eklenir (`create_date` set edilir, `AddAsync`), `inserted` sayaci artar.
- **Update**: eslesen kayit varsa **tum alanlar** (name, full_name, fixed_name, futbin_player_id, quality_id, rarity_id, league_id, club_id, nation_id, rating, position_id, url, futbin_player_link, futbin_squat_link, url_img_*, price_pc, price_console, alternative_positions, active) uzerine yazilir, `update_date = now` set edilir, `updated` sayaci artar.
- **Tek `SaveChangesAsync()`** batch sonunda cagirilir — tum insert/update'ler ayni transaction'da commit edilir.
- Hata durumunda inner exception zinciri (`depth <= 3`) birlestirilerek `(false, message, 0, 0)` donulur; servis bunu `Failure("DB kayit hatasi: ...")` olarak 400'e cevirir.

**Onemli**: `disable_missing_delete=true` sozlesmesi geregi bu fonksiyon **hicbir zaman kayit silmez**; batch'te olmayan mevcut oyuncular dokunulmadan kalir. Silme/pasife alma bu endpoint'in sorumlulugunda degildir.

## 6. Eklenti Tarafi — Important Players Modulu

Kaynak: `Sync/src/modules/important/background.js`, `Sync/src/modules/important/offscreen-parser.js`

### 6.1 Kaynak URL ve filtre

```
https://www.futbin.com/27/players?ps_price=300-45000&player_rating={min}-{max}&sort=Player_Rating&order=asc&eUnt=1&page={n}
```

- `player_rating` araligi popup'tan kullanicinin girdigi `minRating`/`maxRating` (varsayilan `55-99`, sinirlar `1-99`) ile parametrize edilir; deger verilmezse son kaydedilen state'e (`chrome.storage.local`) dusulur.
- `ps_price=300-45000` sabittir (kod icinde hardcoded).
- Toplam sayfa sayisi, **ilk sayfanin** HTML'inden `pagination-buttons-wrapper` icindeki `a.pagination-button` linklerinin `page` query param'larinin en buyugu alinarak belirlenir (`totalPages()`, offscreen-parser.js:22-28).

### 6.2 Sayfa cekme stratejisi

1. Once dogrudan `fetch(url, { credentials: "include", cache: "no-store" })` denenir (3 deneme, aralarda 5 sn bekleme).
2. `403`/`429` donerse veya HTML 1000 karakterden kucukse, **arka planda gizli bir tab acilarak** (`chrome.tabs.create({ active: false })`) sayfa gercek tarayicida yuklenir; `document.documentElement.outerHTML` 250ms araliklarla poll edilir (max 60 sn, `FUTBIN_TARGET_DOM_MAX_WAIT_MS`).
3. Bu poll sirasinda HTML'de Cloudflare dogrulama isaretleri (`isFutbinChallengeHtml`) tespit edilirse, tab kullaniciya odaklanir (`focusFutbinChallengeTab`) ve bekleme suresi `FUTBIN_CHALLENGE_MAX_WAIT_MS`'e uzatilir — kullanicinin manuel captcha/challenge'i cozmesi beklenir.
4. "Hazir" sayilma kosulu (`futbinHtmlReadiness`): HTML icinde `players-table`, `player-row`, `table-player-name`, `selected-filters-wrapper` veya `pagination-buttons-wrapper` class'larindan biri regex ile bulunmali.
5. Basarili HTML, offscreen document'a (`PARSE_FUTBIN_HTML` mesaji) gonderilir; offscreen yoksa `chrome.offscreen.createDocument` ile olusturulur (`reasons: ["DOM_SCRAPING"]`).

### 6.3 Offscreen parser — Futbin HTML'inden hangi bilgi nereden okunuyor

`offscreen-parser.js`, `DOMParser` ile HTML'i parse edip her `tr.player-row` satirini `parsePlayerRow()` ile okur. **Futbin'den JSON degil, oyuncu tablosu HTML'i gelir**; asagidaki tum alanlar DOM secicileri/attribute'lerinden cikarilir:

| Cikan alan | DOM kaynagi | Not |
|---|---|---|
| `futbinPlayerId`, `futbinPlayerLink` | `td.table-name > a[href]` (veya `a.table-player-name`) href'i, `/player/(\d+)` regex'i | Yoksa satir "Futbin oyuncu ID/link okunamadi" hatasiyla atlanir |
| `name` | Oyuncu resminin `alt`/`title`, yoksa link `title`/`aria-label`, yoksa link metni | `cleanPlayerName` ile olasi rating sayilari (40-199 arasi bagimsiz sayilar) metinden temizlenir |
| `fullName` | Link metni (resim/rating/pozisyon/fiyat elemanlari cikarilip), yoksa `title`, yoksa `name`'e dusulur | |
| `rating` | `td.table-rating` metni, sayiya cevrilir | |
| `positionName`, `alternativePositions` | `td.table-pos` metni `+`/bosluk/virgulle bolunur, 1-3 buyuk harf token'lari filtrelenir | Ilk token `positionName`, kalanlar `alternativePositions` |
| `priceConsole`, `pricePc` | `td.table-price.platform-ps-only` / `.platform-pc-only` metni | `K`/`M` sonekli sayilar (`1.2K`, `3M`) ve binlik ayiracli sayilar parse edilir (`price()`) |
| `nationName`, `leagueName`, `clubName` | Ilgili badge img'inin `title`/`alt` attribute'u | |
| `futbinRarityId` | `td.table-name` icindeki kart arka plan resminin `src`, `/cards/(tiny\|hd)/(\d+)_` regex'i | Kartin CDN yol segmentindeki sayisal ID |
| `futbinClubId`/`futbinLeagueId`/`futbinNationId` | Once ilgili badge img src'sinden path regex'i (`/clubs/(dark/)?(\d+)\.`, `/league/(dark/)?(\d+)\.`, `/nation/(\d+)\.`); **bulunamazsa** ilgili linkin (`a.table-player-club` vb.) href'indeki `club`/`league`/`nation` query param'ina (`queryId`) dusulur | Iki katmanli fallback |
| `cardImageUrl`, `playerImageUrl`, `nationImageUrl`, `leagueImageUrl`, `clubImageUrl` | Ilgili img elemaninin `src`/`data-src`/`srcset` ilk URL'i, mutlak URL'e cevrilir | Bunlar oldugu gibi `url_img_*` olarak backend'e gider |

Yani **Futbin yanitinin "hangi bilgiye sahip oldugu"**, o sayfadaki oyuncu tablosunun render ettigi HTML yapisina baglidir: her ID (`futbin_club_id`, `futbin_league_id`, `futbin_nation_id`, `futbin_rarity_id`) dogrudan bir alan olarak gelmez, **CDN gorsel URL'lerinin dosya yolundaki sayisal segmentten** (veya yedek olarak linkteki query param'dan) turetilir. Bu tasarim Futbin'in kendi backend ID semasina dogrudan erisim olmadan, sadece HTML/gorsel URL'lerinden calisir — Futbin'in DOM/CDN yapisi degisirse bu regex'ler kirilir.

Satir basina parse hatasi (`errors[]`) toplanir ama tum sayfayi durdurmaz; sayfa hicbir satir icermiyorsa ve "no results" metni de yoksa (`confirmedEmpty=false`), cagiran taraf bunu guvenli kabul etmez ve hata firlatir (`background.js:235`).

### 6.4 Ham veriden API payload'ina donusum — `toPayloadPlayer`

`background.js:553-602`. Her ham satir icin:

1. `inferRarity(raw)`: kart resmi dosya adindan (`{id}_{code}.png` deseni) `futbinId` ve `cardCode` (bronze/silver/gold vb.) cikarilir; `raw.futbinRarityId` varsa o tercih edilir.
2. `inferQualityCode(raw, rarityInfo)`: `rarityInfo.futbinId` 0/1 disindaysa `"special"`; degilse kart kodundan `bronze|silver|gold` regex'i, o da yoksa rating esigi (`>=75` gold, `>=65` silver, aksi bronze).
3. Isim temizleme (`cleanPayloadPlayerName`) — parse sirasinda kacmis rating benzeri sayilar tekrar temizlenir.
4. **Zorunlu alan kontrolu**: `futbin_player_id`, `futbin_club_id`, `futbin_league_id`, `futbin_nation_id`, `name`, `full_name`, `rating`, `position_name`, `quality_code` degerlerinden biri `null`/`undefined`/`""`/`0` ise `Error` firlatilir (satir haric edilir, `batchErrors`'a detayli kayit — oyuncu adi, tum futbin ID'leri, hata mesaji — eklenir); ayrica `rarityInfo.futbinId` `NaN` ise de reddedilir.
5. Basarili olursa DTO'nun bekledigi `snake_case` alanlarla ({`futbin_club_id`, `futbin_league_id`, ..., `active: true`}) bir obje dondurulur.

### 6.5 Sayfa ici tekillestirme

- `sentPlayerIds`: run boyunca **API'ye zaten gonderilmis** `futbin_player_id` kumesi; bir sonraki sayfalarda ayni oyuncu tekrar gorulurse islenmez (`continue`).
- `batchPlayers` (Map, key=`futbinPlayerId`): mevcut 5 sayfalik batch icindeki oyuncular; ayni oyuncu batch icinde birden fazla kez gorulurse `preferPlayer(old, next)` **fiyat bilgisi olan** kaydi tercih eder (console/pc fiyati sifir olmayan taraf kazanir).

### 6.6 Batch biriktirme ve API'ye gonderim

- `PAGE_BATCH_SIZE = 5`: her 5 sayfada bir (veya son sayfada, `page === totalPages`) biriken `batchPlayers` API'ye POST edilir.
- Gonderim oncesi `REQUEST_DELAY_MS = 5000` beklenir (throttling).
- Istek govdesi:
  ```js
  {
    page_from, page_to, pages_attempted: page - batchPageFrom + 1,
    pages_succeeded: page - batchPageFrom + 1, players,
    sync_mode: "filtered_partial", disable_missing_delete: true,
    source: "futbin_filtered_players", source_url: sourceUrl,
    filter: { ps_price: "300-45000", player_rating: `${minRating}-${maxRating}` }
  }
  ```
  `pages_attempted`/`pages_succeeded` her zaman esit gonderilir — eklenti taraf hicbir zaman "kismen basarili sayfa" kavramini bu endpoint'e tasimaz; bir sayfa hic okunamazsa `fetchAndParsePage` zaten `throw` eder ve tum run basarisiz sayilir (`failRun`).
- `apiRequestWithRetry`: POST 3 kez denenir (aralarda 5 sn), her denemeden once `assertActive(token)` ile run'in hala aktif oldugu (stop edilmedigi) kontrol edilir.
- **Transport secimi**: eger "Network Monitor" sekmesi acik ve baglic ise (`networkPort`), istek `chrome.runtime.Port` uzerinden o sekmeye postalanip orada XHR ile gonderilir (debug/network-panel gorunurlugu icin); aksi halde service worker icinde dogrudan `fetch()` kullanilir (`directApiRequest`, 30 sn timeout).
- **Basarili yanit**: `response.data.saved/inserted/updated/skipped` state sayaçlarina (kumulatif, tum run boyunca) eklenir; `response.data.errors[]` ile eslesen oyuncunun `futbin_player_link`'i loglara eklenir (`formatApiIssues`) ki hangi Futbin sayfasindan geldigi UI'da izlenebilsin.
- **Basarisiz yanit (3 denemeden sonra)**: o 5 sayfalik batch'teki **tum** oyuncular yerel olarak "skipped" sayilir, batch state'i sifirlanir ve **bir sonraki batch'e devam edilir** — o turda bu oyuncular kaybedilir (tekrar denenmezler; ancak bir sonraki saatlik round bastan basladigi icin ayni oyuncular tekrar Futbin'den cekilip gonderilecektir).

### 6.7 Zamanlama ve durum makinesi

- Run tipleri: `scheduled` (saatlik alarm), `runOnce` (manuel "Baslat" veya "Latest Player Sync bitince otomatik zincirleme"), `centralManaged` (merkezi orkestratör tarafindan tetiklenen tek round).
- Sayfalar bitince: `runOnce`/`centralManaged` ise durum `Finished` olur ve tekrar planlanmaz; degilse `LOOP_DELAY_MS = 1 saat` sonrasina `chrome.alarms.create` ile bir sonraki round planlanir.
- Run sirasinda hata olursa (`failRun`) ayni mantikla ya bir sonraki round planlanir ya da (`oneShot`) tur basarisiz olarak isaretlenir; `centralManaged` ise merkezi orkestratöre `MODULE_ROUND_FINISHED` mesaji/cagirisi ile sonuc bildirilir.
- `stopSync()` / durdurma: aktif `AbortController`'lar iptal edilir, bekleyen `delay()` promise'leri hemen resolve edilir, acilan yardimci tab'lar kapatilir, alarm temizlenir.

## 7. Uctan Uca Ornek

1. Kullanici popup'tan `minRating=75, maxRating=85` girip "Baslat"a basar (`START_SYNC`, `runOnce: true`).
2. `sourceUrl = https://www.futbin.com/27/players?ps_price=300-45000&player_rating=75-85&sort=Player_Rating&order=asc&eUnt=1`.
3. Sayfa 1 cekilir, parse edilir (orn. 30 satir); tumu 75-85 rating araliginda oldugundan hicbiri filtreyle elenmez.
4. Sayfa 2-5 de ayni sekilde cekilip birikir (~120-150 oyuncu, dedupe sonrasi daha az olabilir).
5. Sayfa 5 = `totalPages` degilse bile `page - batchPageFrom + 1 === 5` oldugu icin batch hazir olur; `POST sync/futbin-player-clubs` `{page_from:1, page_to:5, players:[...]}` ile gonderilir.
6. Backend: sync_mode/sayfa kontrolleri gecer -> lig/kulup/rarity/quality/position/nation lookup'lari cekilir -> her oyuncu icin referans cozumlenir -> gecersizler (orn. futbin_club_id yeni bir kulup icin DB'de yok ve isim de eslesmiyor) `errors[]`'a duser -> kalanlar `savePlayerList` ile tek `SaveChangesAsync`'de insert/update edilir.
7. Yanit `{ saved: 118, inserted: 12, updated: 106, skipped: 4, page_from: 1, page_to: 5, errors: [...] }` doner.
8. Eklenti sayaclari gunceller, `batchPageFrom = 6` olarak bir sonraki 5 sayfalik pencereye gecer; `totalPages`'e ulasilinca run `Finished` olur (manuel baslatildigi icin tekrar planlanmaz).

## 8. Bilinen Sinirlamalar / Riskler

- **Futbin DOM/CDN yol yapisina siki bagimlilik**: `futbin_club_id/league_id/nation_id/rarity_id` cogunlukla gorsel URL'sindeki sayisal path segmentinden turetilir; Futbin CDN yollarini degistirirse (orn. `/clubs/{id}.png` -> baska bir sema) bu ID'ler `0` gelir ve ilgili oyuncular `toPayloadPlayer`'da (zorunlu alan kontrolu) veya servis tarafinda (`MapFilteredPlayerReferences`) reddedilir.
- **Isimle kulup eslestirme kesinlik garantisi vermez**: `futbin_club_id` eslesmezse `0.8` benzerlik esigiyle bulanik eslestirme yapilir; bu, yanlis fakat "yeterince benzer" bir kulube atama riski tasir (esitlik durumunda reddedilerek kismen azaltilmistir).
- **Basarisiz batch'te veri kaybi (o round icin)**: 3 denemeden sonra hala basarisiz olan bir 5 sayfalik POST, o run icinde bir daha denenmez; sadece bir sonraki saatlik round'da (sayfalar bastan okunarak) telafi olur.
- **`disable_missing_delete=true` sabit**: bu endpoint kesinlikle silme yapmadigi icin, Futbin'de artik listelenmeyen (satilmis/kaldirilmis) oyuncular DB'de pasiflestirilmez; bu is (varsa) baska bir pipeline'in sorumlulugundadir.
- **Maksimum 5 sayfa/istek** sunucu tarafinda sert bir kural (`CRITICAL` -> 422); eklenti tarafi da `PAGE_BATCH_SIZE=5` ile ayni sinira uyumlu calisir — biri degisirse digeri de guncellenmelidir.
