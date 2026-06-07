# 📖 Sekai Bot — Sistem Rehberi

---

## 1. PUAN SİSTEMİ

Her yetkili tek bir puan havuzuna sahiptir. Bu havuz 6 kategoriden beslenir:

| Kategori | Nasıl kazanılır |
|---|---|
| 💬 Mesaj | Takip edilen kanallara mesaj atınca |
| 🎙️ Ses | Ses kanallarında **mikrofon açıkken** geçirilen süreye göre |
| ⚠️ Zorunlu Görev | Zorunlu görev tamamlanınca |
| 🎯 İsteğe Bağlı Görev | İsteğe bağlı manuel görev tamamlanınca |
| 📌 Sorumluluk | `/staff` sorumluluk sistemi ile admin tarafından onaylanınca |
| ⭐ Manuel | Admin tarafından `/points add` ile elle eklenir |

Bu 6 kategorinin toplamı kişinin **Toplam Puanı**'dır.

> ✅ **Tüm görev türleri** (ses / mesaj / karma / partnerlik) tamamlandığında **görev puanı verilir** — aktivite puanları (ses/mesaj) ve görev puanları birbirinden bağımsız, ayrı kategorilerdir.

---

## 2. MESAJ SİSTEMİ

Bot, belirli rollerdeki üyelerin belirli kanallardaki mesajlarını takip eder.

- Her mesaj → **+0.1 puan**
- 10+ kelimeli mesaj → **+0.1 bonus**
- 100+ karakterli mesaj → **+0.1 bonus**
- `/score messages` komutuyla bu değerler değiştirilebilir
- `/listenroles` ile hangi rollerin takip edileceği ayarlanır
- `/logchannel block` ile istenmeyen kanallar takipten çıkarılır

Her mesajın puanı `message_logs.score` sütununa kaydedilir.

---

## 3. SES SİSTEMİ

Ses kanallarında **mikrofon açıkken** geçirilen süre takip edilir. Toplam süre değil, **aktif (mic açık) süre** baz alınır.

- Her dakika (mikrofon açık) → **+0.5 puan** *(varsayılan)*
- Kullanıcı mikrofonunu açınca süre başlar, kapatınca/kanaldan çıkınca durur
- **Sunucu tarafından susturulunca** (serverMute) mic kapalı sayılır, süre durur; susturma kaldırılınca devam eder
- `/score voice` komutuyla bu değer değiştirilebilir
- Bot yeniden başlatılırsa açık kalan oturumlar **log yazılmadan** temizlenir (yanlış süre kaydını önler)

---

## 4. AKTİVİTE VE GÖREV DIŞLAMA KURALI

Zorunlu görevi beklenirken aktivite, isteğe bağlı görev sayacına **eklenmez**.

```
Senaryo: Kişinin bekleyen zorunlu görevi var

Mesaj atar → Mesaj puanı alır ✅ (kendi havuzuna gider)
             Ama isteğe bağlı mesaj görevi sayacında sayılmaz ❌

Ses kanalına girer → Ses puanı alır ✅
                     Ama isteğe bağlı ses görevi sayacında sayılmaz ❌
```

Kullanıcı ya zorunlu görevi tamamlar → sonra isteğe bağlı yapabilir,
ya da isteğe bağlı görev atlar → zorunlu görevini bitirir.

---

## 5. GÖREV SİSTEMİ

### 5.1 Görev Türleri

| Tür | Açıklama | Tamamlama Kriteri |
|---|---|---|
| 🎙️ Ses Görevi | Belirli ses puanı kazanılmalı | Bot kontrol eder (mic açık dakika) |
| 💬 Mesaj Görevi | Belirli mesaj puanı kazanılmalı | Bot kontrol eder |
| ⚡ Karma Görev | Ses + mesaj kombinasyonu | Bot kontrol eder |
| 🤝 Partnerlik | Partnerlik kanalında mesaj atılmalı | Bot otomatik tamamlar |

> ℹ️ Ses/mesaj görevlerinde eşik değeri **puan** cinsindedir, sayı değil.
> Örnek: `ses:10` → 10 ses puanı (yaklaşık 20 dakika mic açık)

---

### 5.2 Zorunlu Görevler ⚠️

Yetkililerin o dönem yapması **zorunlu** olan görevlerdir.

- Görevi olan rolün tüm üyelerine **otomatik atanır**
- Tamamlayan → **Zorunlu Görev Puanı** kazanır ve **Streak** artar
- Tamamlamayan → uyarı riski taşır, o hafta terfi edemez
- Tekrarlayan olabilir (günlük / haftalık / aylık)

---

### 5.3 İsteğe Bağlı Görevler 🎯

Yetkililerin katılıp katılmamakta serbest olduğu görevlerdir.

**Tek seferlik:**
- Embed'de **[🙋 Üstlen]** butonu çıkar
- İsteyenler tıklayarak görevi üstlenir

**Tekrarlayan (günlük / haftalık / aylık):**
- Her dönem rolün tüm üyelerine **otomatik atanır**
- Üstlen butonu yoktur, direkt tamamla butonuna basılır

---

### 5.4 Özel Görevler 🔒

Görev kanalında yayınlanmaz — atanan kişilere **DM** olarak gönderilir.

- Atanan kişi DM'de görev bilgilerini alır
- DM almak için Discord ayarlarında "Sunucu üyelerinden DM al" açık olmalı
- **DM kapalıysa** → görev kanalına `@mention` ile bildirim gönderilir: *"Sana özel bir görev atandı, /my-tasks kullan"*
- Tamamlamak için `/my-tasks` komutuna gidip butona basar
- `/my-tasks` listesinde `🔒 Özel` etiketi ile görünür
- Görev kanalı ayarlanmamış olsa bile özel görev oluşturulabilir

---

### 5.5 Onay Sistemi

`/task setup` sırasında **"admin onayı zorunlu"** seçeneği açılabilir.

- Kullanıcı görevi tamamlayınca → `🕐 Onay Bekleniyor` durumuna geçer
- Log kanalına **[✅ Onayla] [❌ Reddet]** butonları gönderilir
- Admin **Onayla** → puan verilir, görev kapanır
- Admin **Reddet** → görev tekrar `bekliyor` durumuna döner
- Aynı onay isteği iki admin tarafından aynı anda işlenemez (yarış koşulu engeli)

---

### 5.6 Tekrarlama

Görevler günlük, haftalık veya aylık olarak tekrarlanabilir.

- Her dönem sonunda aynı görevin yeni kopyası oluşturulur
- Yeni kopya role otomatik atanır
- **XP Limiti** dolmuş kişiler yeni döneme atanmaz
- Eski dönemin görevi otomatik olarak `tamamlandı` yapılır; kanal embed'indeki butonlar kaldırılır — eski dönem temiz kapanır, yeni dönem aktif görünür

---

### 5.7 XP Limiti (Tamamlama Limiti)

Kişinin bir görev serisinden toplam kaç kez puan alabileceğini sınırlar.

Örnek: Günlük görev, XP Limiti = 3
```
Gün 1 → Tamamlar → Puan alır (1/3)
Gün 2 → Tamamlar → Puan alır (2/3)
Gün 3 → Tamamlar → Puan alır (3/3)
Gün 4 → Göreve atanmaz ❌
```

Sınırsız seçilirse her dönem puan almaya devam eder.

---

### 5.8 Kategoriler

Görevler kategorilere atanabilir. Her kategori için **toplam tamamlama limiti** belirlenebilir.

Örnek: "etkinlik" kategorisi, limit = 5
- Kişi bu kategoriden toplam 5 görev tamamlayabilir
- 5. tamamlamadan sonra bu kategoriden yeni görev üstlenemez

Kategoriler `/task kategori-ekle` ile oluşturulur.

---

### 5.9 Haftalık Görev Limiti ve %60 Kuralı

Her rolün bir **haftalık isteğe bağlı görev limiti** vardır.

- Limitin altında → puan **tam** hesaplanır
- Limitin üstünde → fazladan tamamlanan her farklı isteğe bağlı görev **%60** puan verir

Örnek: Limit = 5 farklı isteğe bağlı görev/hafta
```
Görev A, B, C, D, E tamamlandı → tam puan
Görev F tamamlandı             → %60 puan ← 6. farklı görev
```

Bu kural **zorunlu görevler için geçerli değildir**.

---

## 6. YETKİ SİSTEMİ

### 6.1 Rol Hiyerarşisi

Her rol için şu değerler tanımlanır:

| Parametre | Açıklama |
|---|---|
| 🏆 Gereken XP | Terfi için toplam puan eşiği |
| 🔢 Görev Limiti | Haftada kaç isteğe bağlı görev tam puan verir |
| ✖️ XP Çarpanı | Görevlerden kazanılan puanı çarpar |
| 📋 Zorunlu Görev | Haftalık/periyodik zorunlu görev sayısı |

---

### 6.2 XP Çarpanı

Rol yükseldikçe çarpan artabilir. Görev tamamlandığında:

```
Final Puan = Görev Puanı × Rol Çarpanı × (1.0 veya 0.6)
```

Örnek: 100 puanlık görev, çarpan 1.5x → **150 puan**

---

### 6.3 Terfi Koşulları

Bir kişi terfi için şunları karşılamalı:

1. ✅ Toplam puanı bir üst rolün gereken XP'sine ulaşmış olmalı
2. ✅ Bu hafta **veya** geçen hafta zorunlu görevi tamamlamış olmalı

**Terfi otomatik verilmez.** Şartlar karşılandığında kullanıcıya **"Terfi Talep Et"** butonu çıkar. Butona basınca log kanalına bildirim gider, admin rolü manuel olarak verir.

---

### 6.4 Streak

Zorunlu görevi üst üste tamamlanan hafta sayısıdır.

- Her hafta zorunlu görev tamamlanırsa streak artar 🔥
- Bir hafta atlanırsa streak sıfırlanır ve kullanıcıya **DM bildirimi** gönderilir
- `/staff status` ekranında görünür

---

### 6.5 Uyarı Sistemi

Haftalık görevi yapmayan kişilere otomatik uyarı gönderilir.

- Her inaktif hafta → +1 uyarı
- Admin `/staff warn` ile manuel uyarı verebilir
- Uyarı sayısı `/staff status` ekranında görünür

---

## 7. PARTNERLİK SİSTEMİ

Partnerlik sistemi, yetkililerin başka sunucularla yaptığı iş birliklerini takip eder.

### 7.1 Nasıl Çalışır?

1. Admin `/partnership setup #kanal` ile bir partnerlik kanalı tanımlar
2. O kanala **bot olmayan** herhangi biri mesaj attığında sistem bunu otomatik olarak kaydeder
3. Kişinin partnerlik sayısı artar
4. Partnerlik görevine atanan kişi gerekli sayıya ulaştığında görev **otomatik tamamlanır** ve kullanıcıya DM gider

### 7.2 Komutlar

| Komut | Açıklama |
|---|---|
| `/partnership setup #kanal` | Partnerlik kanalını tanımlar |
| `/partnership durum` | Hangi kanalın tanımlı olduğunu gösterir |
| `/partnership kapat` | Kanal tanımını kaldırır |
| `/partnership liste [@kişi]` | Kişinin partnerlik geçmişini listeler |
| `/partnership tümü` | Tüm kullanıcıların partnerlik sayısını sıralı gösterir |

---

## 8. İTİRAF SİSTEMİ

Kullanıcıların anonim mesaj gönderebileceği sistemdir.

### 8.1 Nasıl Çalışır?

1. Admin `/confession setup` ile itiraf kanalını ve panel kanalını ayarlar
2. Kullanıcılar panel mesajındaki **[💌 İtiraf Et]** butonuna tıklar
3. Açılan modal'a itirafını yazar
4. Mesaj anonim olarak itiraf kanalına gönderilir

### 8.2 Açma / Kapama

| Komut | Açıklama |
|---|---|
| `/confession setup` | Kanalları ayarlar ve sistemi açar |
| `/confession ac` | Sistemi açar (buton aktif olur) |
| `/confession kapat` | Sistemi kapatır (buton çalışmaz) |

> ℹ️ Kullanıcılar aynı günden 3 saat geçmeden ikinci itiraf gönderemez.

---

## 9. İZİN SİSTEMİ

Komutların hangi roller tarafından kullanılabileceğini kontrol eder.

### 9.1 Varsayılan Erişim

- **Sunucu sahibi** → tüm komutlar
- **Bot süper kullanıcıları** (`.env` → `BOT_SUPER_USERS`) → tüm komutlar
- **Yetkili roller** → izin verilen komutlar
- **Diğerleri** → hiçbir şey

### 9.2 Komutlar

| Komut | Açıklama |
|---|---|
| `/permissions ver` | Bir role komut erişimi verir |
| `/permissions al` | Bir rolden komut erişimini kaldırır |
| `/permissions liste` | Bir komutun kim tarafından kullanılabileceğini gösterir |
| `/permissions sifirla` | Bir komutun tüm özel izinlerini siler |
| `/permissions komutlar` | İzin verilebilir komut listesini gösterir |
| `/permissions herkes` | Tüm komutları ve erişim gruplarını tablo olarak gösterir |

---

## 10. KOMUTLAR

### ⚙️ Yönetici Komutları

| Komut | Açıklama |
|---|---|
| `/staff setup` | Log kanalını ayarlar |
| `/staff role-add` | Sisteme rol ekler |
| `/staff role-remove` | Sistemden rol kaldırır |
| `/staff roles` | Rolleri listeler |
| `/staff status [@kişi]` | Kullanıcının durumunu gösterir |
| `/staff report` | Haftalık raporu manuel gönderir |
| `/staff panel [#kanal]` | Rol hiyerarşisi + kullanıcı durumları embedini gönderir |
| `/staff warn @kişi` | Manuel uyarı verir |
| `/staff promotions` | Terfi taleplerini listeler |
| `/task setup` | Görev panel kanalını ayarlar |
| `/task list` | Görevleri filtreler ve listeler |
| `/task edit` | Görevi düzenler |
| `/task complete` | Admin olarak görevi tamamlar |
| `/task kategori-ekle` | Kategori oluşturur |
| `/task kategori-kaldir` | Kategori siler |
| `/task kategoriler` | Kategorileri listeler |
| `/task templates` | Kayıtlı şablonları yönetir |
| `/activity [@kişi]` | Aktivite raporu |
| `/report [aralik] [@kişi]` | Aktivite özeti — kişi seçilirse o kişinin haftalık ses + partnerlik + görev detayı |
| `/points add` | Kullanıcıya puan ekler/çıkarır |
| `/points history` | Manuel puan geçmişini gösterir |
| `/partnership setup` | Partnerlik kanalını tanımlar |
| `/partnership tümü` | Tüm partnerlik sıralaması |
| `/partnership liste [@kişi]` | Kişinin partnerlik geçmişi |
| `/confession setup` | İtiraf sistemini kurar |
| `/confession ac` | İtiraf sistemini açar |
| `/confession kapat` | İtiraf sistemini kapatır |
| `/permissions ver/al` | Komut izinlerini yönetir |
| `/permissions herkes` | İzin tablosunu gösterir |
| `/score` | Puan sistemi ayarları |
| `/logchannel` | Log kanal yönetimi |
| `/listenroles` | Takip edilen rolleri yönetir |
| `/modlog` | Moderasyon loglarını gösterir |
| `/messages` | Kullanıcı mesaj logları |
| `/voice` | Kullanıcı ses oturumları |
| `/guard` | Sunucu koruma sistemi |

### 🌐 Genel Komutlar

| Komut | Açıklama |
|---|---|
| `/my-tasks [durum]` | Sana atanan görevleri listeler; bekliyor / tamamlandı / hepsi filtresi |
| `/profil [@kişi]` | XP özeti, streak, görev tamamlama oranı ve aktivite istatistikleri |
| `/leaderboard [sıralama]` | Skor / mesaj / ses / görev / streak sıralaması |
| `/botinfo` | Bot komutları ve sistem bilgisi |
| `/ping` | Botun gecikme süresi |

---

## 11. SEZON SİSTEMİ

Sunucuyu belirli dönemlere böler. Her sezon sonunda puanlar arşivlenir ve sıfırlanır.

### 11.1 Sezon Akışı

```
/season baslat "Sezon 1"
     │
     │  (herkes normal şekilde puan kazanır)
     │
/season bitir
     ├── Tüm puanlar season_snapshots tablosuna kaydedilir
     ├── activity tablosundaki puanlar sıfırlanır (streak / roller dokunulmaz)
     └── Log kanalına sezon sonu sıralaması embed olarak gönderilir
```

### 11.2 Komutlar

| Komut | Açıklama |
|---|---|
| `/season baslat <isim>` | Yeni sezon başlatır |
| `/season bitir` | Aktif sezonu kapatır, arşivler ve sıfırlar |
| `/season bilgi` | Aktif sezonun adı, başlangıcı ve aktif kişi sayısı |
| `/season gecmis` | Tüm sezonların listesi |
| `/season arsiv <id>` | Geçmiş bir sezonun top 10 sıralaması |

### 11.3 Notlar

- **Streak ve roller sıfırlanmaz** — yalnızca puan skorları (mesaj, ses, görev, sorumluluk, manuel) sıfırlanır
- Aktif sezon varken yeni sezon başlatılamaz — önce `bitir` gerekir
- `/leaderboard` footer'ında o anki aktif sezon adı görünür
- Her sezonun sıralaması `/season arsiv <id>` ile sonsuza kadar görüntülenebilir

---

## 12. GÖREV OLUŞTURMA AKIŞI

```
Panel Kanalı → [➕ Görev Oluştur]
│
├── ADIM 1
│   ├── Görev türü (ses / mesaj / karma / partnerlik)
│   ├── Öncelik (düşük / orta / yüksek)
│   ├── Puan miktarı
│   └── Atanacak roller
│
├── ADIM 1.5
│   ├── Kategori seçimi
│   ├── XP Limiti (sınırsız / 1 / 3 / 5 / 10 kez)
│   ├── Zorunlu ↔ İsteğe Bağlı (select menü)
│   └── Herkese Açık ↔ Özel (select menü)
│
├── ADIM 2 (Modal)
│   ├── Başlık
│   ├── Açıklama
│   ├── Başlangıç / bitiş tarihi
│   └── Gereksinimler (ses puanı / mesaj puanı / partnerlik sayısı)
│
└── ÖNİZLEME
    ├── Tekrarlama ayarla (günlük / haftalık / aylık)
    ├── Şablon kaydet
    └── Yayınla ✅
        ├── Herkese açık → görev kanalında yayınlanır
        └── Özel → atananlara DM gönderilir
```

---

## 13. PUAN HESAPLAMA ÖZETİ

```
Toplam Puan =
  (Mesaj Sayısı × mesaj_katsayısı)
  + (Mikrofon Açık Dakika × ses_katsayısı)
  + Zorunlu Görev Puanları        (× rol çarpanı)
  + İsteğe Bağlı Görev Puanları   (× rol çarpanı, haftalık limitli)
  + Sorumluluk Puanları           (× rol çarpanı, tür başına kap limitli)
  + Manuel Puanlar                (admin tarafından eklenen, minimum 0)
```

Terfi bu toplam puana bakarak hesaplanır.

> ℹ️ Tüm isteğe bağlı görevler tamamlandığında **görev puanı** verilir. Ses/mesaj aktivite puanları ayrı bir kategoridir ve her ikisi de aynı anda kazanılabilir.
