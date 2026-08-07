-- 001_init.sql — базовая схема админки PROHVAC.
--
-- Соглашения, общие для всего файла:
--
-- 1. Все таблицы STRICT. Без него SQLite молча положит строку 'вчера' в колонку
--    INTEGER, и это вскроется через полгода на отчёте по заявкам.
-- 2. Время — INTEGER, epoch в МИЛЛИСЕКУНДАХ (ровно Date.now()). Никаких
--    TEXT-дат: они провоцируют споры о таймзоне и не сравниваются индексом
--    так же дёшево, как числа. DEFAULT берёт то же самое из SQLite на случай,
--    если вызывающий код забыл проставить поле.
-- 3. Булевы значения — INTEGER 0/1 с CHECK: в STRICT-таблицах типа BOOLEAN нет.
-- 4. Сырых IP в базе нет нигде. Хранится только ip_hash — HMAC-SHA256(ip,
--    APP_SECRET) в НИЖНЕМ РЕГИСТРЕ HEX, ровно 64 символа. Отсюда
--    CHECK(length(...) = 64): любой сырой IP короче (IPv6 максимум 45 символов),
--    поэтому проверка ловит случайную запись адреса в открытом виде.
--    То же соглашение для ua_hash.
-- 5. PRAGMA (foreign_keys, journal_mode, busy_timeout) выставляет драйвер при
--    открытии соединения — в миграции их нет, иначе они разъедутся с рантаймом.
-- 6. WITHOUT ROWID — там, где первичный ключ составной или текстовый: строка
--    ложится прямо в B-дерево ключа, экономятся и второй индекс, и место
--    (диск на shared-хостинге всего 500 МБ).
--
-- Секреты (TOTP, значения settings) лежат зашифрованными AES-256-GCM тремя
-- колонками: *_ct (шифротекст), *_iv (nonce 12 байт), *_tag (тег 16 байт).
-- Ключ выводится из APP_SECRET и в базе не хранится.

-- Журнал применённых миграций. Имя файла как ключ: порядок задаёт префикс.
CREATE TABLE IF NOT EXISTS schema_migrations (
  name       TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
) STRICT, WITHOUT ROWID;

-- ---------------------------------------------------------------------------
-- Аутентификация
-- ---------------------------------------------------------------------------

-- Учётные записи админки. Их единицы, поэтому таблица оптимизирована под
-- чтение по username (единственный запрос на горячем пути логина).
CREATE TABLE IF NOT EXISTS users (
  id                   INTEGER PRIMARY KEY,
  -- NOCASE: 'Admin' и 'admin' обязаны быть одной учёткой, иначе регистр
  -- превращается в способ завести двойника с теми же правами.
  username             TEXT    NOT NULL COLLATE NOCASE UNIQUE
                               CHECK (length(username) BETWEEN 3 AND 32),
  -- scrypt из node:crypto, самодостаточная строка с параметрами и солью:
  -- '$scrypt$N=16384,r=8,p=1$<salt_b64>$<hash_b64>'. Параметры внутри хеша,
  -- чтобы их можно было поднять, не ломая старые пароли.
  password_hash        TEXT    NOT NULL,
  password_changed_at  INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  -- Первый вход по выданному временному паролю: до смены пускать только
  -- на страницу смены пароля.
  must_change_password INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0, 1)),
  role                 TEXT    NOT NULL CHECK (role IN ('owner', 'admin', 'editor', 'viewer')),
  status               TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  totp_required        INTEGER NOT NULL DEFAULT 1 CHECK (totp_required IN (0, 1)),
  -- Счётчик неудач и блокировка. Живут в БД, а не в памяти: под Passenger
  -- процессов несколько, и память каждого — это отдельный, ничего не знающий
  -- о соседях лимитер.
  failed_attempts      INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  locked_until         INTEGER,
  -- Уровень эскалации: чем больше подряд идущих блокировок, тем длиннее
  -- следующая пауза. Сбрасывается удачным входом.
  lock_level           INTEGER NOT NULL DEFAULT 0 CHECK (lock_level >= 0),
  last_login_at        INTEGER,
  created_at           INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updated_at           INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
) STRICT;

-- Секрет TOTP отдельной таблицей, а не колонкой в users: список пользователей
-- читается на каждой странице админки, и шифротекст секрета не должен
-- попадать в эту выборку по невнимательности (SELECT *).
CREATE TABLE IF NOT EXISTS totp_secrets (
  user_id        INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  secret_ct      BLOB    NOT NULL,
  secret_iv      BLOB    NOT NULL CHECK (length(secret_iv) = 12),
  secret_tag     BLOB    NOT NULL CHECK (length(secret_tag) = 16),
  digits         INTEGER NOT NULL DEFAULT 6 CHECK (digits IN (6, 8)),
  period         INTEGER NOT NULL DEFAULT 30 CHECK (period BETWEEN 15 AND 120),
  algorithm      TEXT    NOT NULL DEFAULT 'SHA1'
                         CHECK (algorithm IN ('SHA1', 'SHA256', 'SHA512')),
  -- NULL = секрет сгенерирован, но пользователь ещё не подтвердил его кодом.
  -- Неподтверждённые секреты нельзя учитывать при проверке входа.
  confirmed_at   INTEGER,
  -- Номер последнего принятого шага времени. Защита от повтора: код,
  -- подсмотренный в течение тех же 30 секунд, второй раз не пройдёт.
  last_used_step INTEGER,
  created_at     INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
) STRICT;

-- Одноразовые коды восстановления на случай потери телефона.
-- Хранится только хеш: утёкшая база не должна давать вход в обход TOTP.
CREATE TABLE IF NOT EXISTS recovery_codes (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash  TEXT    NOT NULL UNIQUE,
  used_at    INTEGER,
  -- Внимание: тут тоже HMAC-хеш адреса (hex, 64 символа), а не сам IP.
  used_ip    TEXT    CHECK (used_ip IS NULL OR length(used_ip) = 64),
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
) STRICT;

-- Частичный индекс: интересны только неиспользованные коды («сколько осталось»).
CREATE INDEX IF NOT EXISTS recovery_codes_unused_idx
  ON recovery_codes (user_id) WHERE used_at IS NULL;

-- Сессии админки. id — это sha256(токен из cookie), сам токен в базе не
-- хранится: дамп таблицы не позволяет войти ни под кем.
CREATE TABLE IF NOT EXISTS sessions (
  id                  TEXT    PRIMARY KEY CHECK (length(id) = 64),
  user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- CSRF-токен тоже только в виде хеша, по той же причине.
  csrf_hash           TEXT    NOT NULL,
  -- pending_totp — пароль принят, второй фактор ещё нет. Такая сессия не даёт
  -- доступа ни к чему, кроме проверки кода.
  state               TEXT    NOT NULL DEFAULT 'pending_totp'
                              CHECK (state IN ('pending_totp', 'active')),
  totp_attempts       INTEGER NOT NULL DEFAULT 0 CHECK (totp_attempts >= 0),
  -- Список пройденных методов через запятую: 'pwd', 'pwd,otp', 'pwd,recovery'.
  -- Нужен, чтобы вход по коду восстановления не считался полноценным 2FA.
  amr                 TEXT    NOT NULL DEFAULT 'pwd',
  -- Когда последний раз подтверждали пароль. Опасные операции (смена пароля,
  -- выдача прав) требуют свежего подтверждения, а не просто живой сессии.
  reauth_at           INTEGER,
  ip_hash             TEXT    NOT NULL CHECK (length(ip_hash) = 64),
  ua_hash             TEXT    NOT NULL CHECK (length(ua_hash) = 64),
  created_at          INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  last_seen_at        INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  -- Два срока: сдвигаемый при активности и жёсткий потолок. Без второго
  -- угнанная сессия живёт вечно, пока её продлевают запросами.
  idle_expires_at     INTEGER NOT NULL,
  absolute_expires_at INTEGER NOT NULL,
  -- Отзыв, а не удаление: строка остаётся, пока её не заберёт уборщик,
  -- чтобы в аудите было видно причину разлогина.
  revoked_at          INTEGER,
  revoked_reason      TEXT    CHECK (revoked_reason IS NULL OR revoked_reason IN (
                                'logout', 'logout_all', 'password_change', 'admin',
                                'expired', 'ip_change', 'totp_failed'
                              )),
  CHECK (revoked_reason IS NULL OR revoked_at IS NOT NULL)
) STRICT, WITHOUT ROWID;

-- «Выйти на всех устройствах» и список активных сессий.
CREATE INDEX IF NOT EXISTS sessions_user_live_idx
  ON sessions (user_id) WHERE revoked_at IS NULL;

-- Уборка просроченного. Два индекса, потому что сроки независимы:
-- сессия умирает по любому из них.
CREATE INDEX IF NOT EXISTS sessions_idle_idx ON sessions (idle_expires_at);
CREATE INDEX IF NOT EXISTS sessions_absolute_idx ON sessions (absolute_expires_at);

-- Журнал попыток входа: источник данных для блокировок и для ответа на вопрос
-- «кто ломился ночью». Пишется и для несуществующих логинов тоже.
CREATE TABLE IF NOT EXISTS login_attempts (
  id       INTEGER PRIMARY KEY,
  at       INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  -- Введённый логин как есть (обрезанный). NULL, если поле не дошло до сервера.
  username TEXT COLLATE NOCASE,
  ip_hash  TEXT    NOT NULL CHECK (length(ip_hash) = 64),
  stage    TEXT    NOT NULL CHECK (stage IN ('password', 'totp', 'recovery')),
  outcome  TEXT    NOT NULL CHECK (outcome IN (
             'ok', 'bad_password', 'bad_totp', 'bad_recovery',
             'unknown_user', 'disabled', 'locked', 'rate_limited'
           ))
) STRICT;

-- Счёт попыток за окно: по адресу и по логину отдельно, иначе перебор одного
-- пароля по списку логинов проходит под радаром.
CREATE INDEX IF NOT EXISTS login_attempts_ip_idx ON login_attempts (ip_hash, at);
CREATE INDEX IF NOT EXISTS login_attempts_username_idx ON login_attempts (username, at);
-- Отдельно под чистку старых записей (DELETE WHERE at < ?).
CREATE INDEX IF NOT EXISTS login_attempts_at_idx ON login_attempts (at);

-- Блокировки по адресу. Отдельная таблица, а не пересчёт login_attempts на
-- каждом запросе: проверка на горячем пути должна быть одним чтением по ключу.
CREATE TABLE IF NOT EXISTS ip_blocks (
  ip_hash       TEXT    PRIMARY KEY CHECK (length(ip_hash) = 64),
  blocked_until INTEGER NOT NULL,
  -- Число блокировок подряд — по нему растёт срок следующей.
  strikes       INTEGER NOT NULL DEFAULT 1 CHECK (strikes > 0),
  reason        TEXT    NOT NULL DEFAULT 'login_bruteforce' CHECK (reason IN (
                          'login_bruteforce', 'rate_limit', 'lead_spam', 'manual'
                        )),
  updated_at    INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
) STRICT, WITHOUT ROWID;

-- Снятие истёкших блокировок пачкой.
CREATE INDEX IF NOT EXISTS ip_blocks_until_idx ON ip_blocks (blocked_until);

-- Общий лимитер запросов живёт в таблице rate_limit, которую заводит сам
-- server/lib/ratelimit.js. Схема намеренно не продублирована здесь: у лимитера
-- есть колонка window_ms (разные вёдра работают с разными окнами — логин
-- в минутах, заявки в часах), и две расходящиеся версии одной таблицы
-- гарантированно разъехались бы. Модуль создаёт её идемпотентно и покрыт
-- тестами на :memory:, которым миграции недоступны.

-- ---------------------------------------------------------------------------
-- Контент и переводы
-- ---------------------------------------------------------------------------

-- Все тексты сайта: одна строка — один ключ в одной локали. Ключ плоский
-- ('hero.title', 'project.tashkent-mall.title'), потому что фронт запрашивает
-- локаль целиком и раскладывает по ключам сам.
CREATE TABLE IF NOT EXISTS content_entries (
  locale        TEXT    NOT NULL CHECK (locale IN ('ru', 'en', 'uz', 'tr', 'ar')),
  key           TEXT    NOT NULL,
  value         TEXT    NOT NULL,
  -- machine — перевод от провайдера, manual — правка руками, imported —
  -- залито из исходных JSON при переезде.
  source        TEXT    NOT NULL DEFAULT 'manual'
                        CHECK (source IN ('manual', 'machine', 'imported')),
  -- Замок: перевод правили руками, автоперевод его не перетирает.
  is_locked     INTEGER NOT NULL DEFAULT 0 CHECK (is_locked IN (0, 1)),
  -- Хеш русского текста, с которого делался перевод. Если исходник изменился,
  -- хеши разойдутся — так находятся устаревшие переводы без ручной ревизии.
  source_hash   TEXT,
  provider      TEXT,
  translated_at INTEGER,
  updated_at    INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  PRIMARY KEY (locale, key)
) STRICT, WITHOUT ROWID;

-- Ключ впереди локали нужен для сверки «этот текст во всех языках»
-- (админка показывает строку переводов); первичный ключ такой запрос не
-- покрывает, у него первым идёт locale.
CREATE INDEX IF NOT EXISTS content_entries_key_idx ON content_entries (key);

-- Очередь автоперевода. Отдельная таблица, а не поле статуса в content_entries:
-- у задачи своя история попыток и своё время следующего запуска, и она может
-- пережить несколько неудач, пока перевода ещё нет.
CREATE TABLE IF NOT EXISTS translation_jobs (
  id          INTEGER PRIMARY KEY,
  key         TEXT    NOT NULL,
  -- 'ru' формально разрешён, чтобы набор совпадал с content_entries.locale,
  -- но исходный язык в очередь не ставится.
  lang        TEXT    NOT NULL CHECK (lang IN ('ru', 'en', 'uz', 'tr', 'ar')),
  source_text TEXT    NOT NULL,
  source_hash TEXT    NOT NULL,
  status      TEXT    NOT NULL DEFAULT 'queued' CHECK (status IN (
                        'queued', 'running', 'done', 'failed', 'deferred', 'skipped'
                      )),
  provider    TEXT,
  attempts    INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error  TEXT,
  -- Не раньше этого момента. Экспоненциальная пауза после ошибки и пауза
  -- при 429 от провайдера — это одно и то же поле.
  run_after   INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updated_at  INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
) STRICT;

-- Дедупликация без блокировок и без предварительного SELECT: незавершённая
-- задача на пару (key, lang) может быть только одна, поэтому постановка
-- в очередь пишется как INSERT ... ON CONFLICT DO UPDATE. Завершённые
-- (done/failed/skipped) под ограничение не попадают и копятся как история.
CREATE UNIQUE INDEX IF NOT EXISTS translation_jobs_pending_uniq
  ON translation_jobs (key, lang)
  WHERE status IN ('queued', 'running', 'deferred');

-- Выборка следующей задачи воркером.
CREATE INDEX IF NOT EXISTS translation_jobs_claim_idx
  ON translation_jobs (run_after)
  WHERE status IN ('queued', 'deferred');

-- Список задач в админке — только по времени, без status в ключе. Индекс вида
-- (status, updated_at) планировщик считал более выгодным и забирал на себя
-- запрос воркера выше, добираясь до порядка через временное B-дерево:
-- на очереди в пару тысяч строк это сортировка всей очереди на каждый тик.
CREATE INDEX IF NOT EXISTS translation_jobs_updated_idx
  ON translation_jobs (updated_at);

-- ---------------------------------------------------------------------------
-- Медиа и блоки лендинга
-- ---------------------------------------------------------------------------

-- Загруженные файлы. Сам файл лежит на диске, здесь только метаданные.
-- SVG в списке mime нет намеренно: это исполняемый XML, отдаваемый с нашего
-- домена, то есть готовый XSS.
CREATE TABLE IF NOT EXISTS media (
  id            INTEGER PRIMARY KEY,
  -- Имя на диске, генерируем сами. Оригинальное имя не используется в пути:
  -- в нём приходят пробелы, кириллица и '../'.
  filename      TEXT    NOT NULL UNIQUE,
  original_name TEXT    NOT NULL,
  mime          TEXT    NOT NULL CHECK (mime IN (
                          'image/webp', 'image/avif', 'image/jpeg', 'image/png'
                        )),
  bytes         INTEGER NOT NULL CHECK (bytes > 0),
  width         INTEGER CHECK (width IS NULL OR width > 0),
  height        INTEGER CHECK (height IS NULL OR height > 0),
  -- Хеш содержимого: повторная загрузка того же файла переиспользует запись
  -- вместо копии на диске (500 МБ на всё).
  sha256        TEXT    NOT NULL UNIQUE CHECK (length(sha256) = 64),
  uploaded_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  -- Мягкое удаление: строка живёт, пока уборщик не убедится, что файл
  -- нигде не используется, и не сотрёт его с диска.
  deleted_at    INTEGER
) STRICT;

-- Библиотека медиа: свежие сверху, удалённые не показываем.
CREATE INDEX IF NOT EXISTS media_live_idx
  ON media (created_at DESC) WHERE deleted_at IS NULL;

-- Портфолио. Тексты (название, описание) живут в content_entries по ключам
-- 'project.<slug>.*' — иначе пришлось бы дублировать таблицу на каждый язык.
CREATE TABLE IF NOT EXISTS projects (
  id             INTEGER PRIMARY KEY,
  -- Два GLOB, потому что одиночный 'slug GLOB "[a-z0-9-]*"' проверяет только
  -- ПЕРВЫЙ символ (дальше '*' принимает что угодно) и пропустил бы 'a/../etc'.
  -- Первый шаблон задаёт начало, второй запрещает недопустимые символы везде.
  slug           TEXT    NOT NULL UNIQUE CHECK (
                           slug GLOB '[a-z0-9]*'
                           AND slug NOT GLOB '*[^a-z0-9-]*'
                           AND length(slug) BETWEEN 2 AND 64
                         ),
  cover_media_id INTEGER REFERENCES media(id) ON DELETE SET NULL,
  position       INTEGER NOT NULL DEFAULT 0,
  -- По умолчанию скрыт: новый проект не должен появляться на сайте
  -- недоделанным, до того как к нему привязали фотографии и переводы.
  status         TEXT    NOT NULL DEFAULT 'hidden'
                         CHECK (status IN ('published', 'hidden')),
  created_at     INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updated_at     INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
) STRICT;

-- Основная выборка лендинга: опубликованные в заданном порядке.
CREATE INDEX IF NOT EXISTS projects_order_idx ON projects (status, position);

-- Галерея проекта. Пара (проект, файл) уникальна сама по себе — отдельный
-- суррогатный id только мешал бы и позволял добавить одно фото дважды.
CREATE TABLE IF NOT EXISTS project_photos (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  media_id   INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  position   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, media_id)
) STRICT, WITHOUT ROWID;

-- Порядок фотографий внутри проекта.
CREATE INDEX IF NOT EXISTS project_photos_order_idx ON project_photos (project_id, position);
-- Обратная связь: «используется ли этот файл» перед удалением, плюс без него
-- ON DELETE CASCADE со стороны media сканирует таблицу целиком.
CREATE INDEX IF NOT EXISTS project_photos_media_idx ON project_photos (media_id);

-- Логотипы партнёров.
CREATE TABLE IF NOT EXISTS partners (
  id         INTEGER PRIMARY KEY,
  name       TEXT    NOT NULL,
  media_id   INTEGER REFERENCES media(id) ON DELETE SET NULL,
  -- Только https: поле попадает в href, а 'javascript:' там — исполняемый код.
  url        TEXT    CHECK (url IS NULL OR url LIKE 'https://%'),
  position   INTEGER NOT NULL DEFAULT 0,
  status     TEXT    NOT NULL DEFAULT 'published'
                     CHECK (status IN ('published', 'hidden')),
  updated_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
) STRICT;

CREATE INDEX IF NOT EXISTS partners_order_idx ON partners (status, position);

-- Блок преимуществ. Тексты — в content_entries по ключам 'advantage.<slug>.*',
-- здесь только оформление и порядок. tone задаёт холодную/тёплую подачу
-- карточки (кондиционирование против отопления).
CREATE TABLE IF NOT EXISTS advantages (
  id            INTEGER PRIMARY KEY,
  slug          TEXT    NOT NULL UNIQUE CHECK (
                          slug GLOB '[a-z0-9]*'
                          AND slug NOT GLOB '*[^a-z0-9-]*'
                          AND length(slug) BETWEEN 2 AND 64
                        ),
  icon_media_id INTEGER REFERENCES media(id) ON DELETE SET NULL,
  tone          TEXT    NOT NULL DEFAULT 'cold' CHECK (tone IN ('cold', 'warm')),
  position      INTEGER NOT NULL DEFAULT 0,
  status        TEXT    NOT NULL DEFAULT 'published'
                        CHECK (status IN ('published', 'hidden'))
) STRICT;

CREATE INDEX IF NOT EXISTS advantages_order_idx ON advantages (status, position);

-- Цифры «12 лет на рынке», «450+ объектов». value — TEXT, потому что это
-- готовая к показу строка со знаками '+', '/' и единицами, а не число.
-- Подпись к цифре лежит в content_entries по ключу 'stat.<key>'.
CREATE TABLE IF NOT EXISTS stats (
  key        TEXT    PRIMARY KEY CHECK (key NOT GLOB '*[^a-z0-9_]*'),
  value      TEXT    NOT NULL,
  tone       TEXT    NOT NULL DEFAULT 'cold' CHECK (tone IN ('cold', 'warm')),
  -- Номер места в первом экране; NULL — показывать только в общем блоке.
  hero_slot  INTEGER CHECK (hero_slot IS NULL OR hero_slot BETWEEN 1 AND 4),
  position   INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
) STRICT, WITHOUT ROWID;

-- Один слот в hero — одна цифра: иначе две записи молча дерутся за место.
CREATE UNIQUE INDEX IF NOT EXISTS stats_hero_slot_uniq
  ON stats (hero_slot) WHERE hero_slot IS NOT NULL;

CREATE INDEX IF NOT EXISTS stats_order_idx ON stats (position);

-- Телефоны в шапке и подвале. Хранятся строго в E.164 — из этого формата
-- одинаково делаются и tel:-ссылка, и человекочитаемый вид на фронте.
CREATE TABLE IF NOT EXISTS phones (
  id       INTEGER PRIMARY KEY,
  e164     TEXT    NOT NULL UNIQUE CHECK (
                     e164 GLOB '+[0-9]*'
                     AND e164 NOT GLOB '*[^+0-9]*'
                     AND length(e164) BETWEEN 8 AND 16
                   ),
  position INTEGER NOT NULL DEFAULT 0,
  status   TEXT    NOT NULL DEFAULT 'published'
                   CHECK (status IN ('published', 'hidden'))
) STRICT;

CREATE INDEX IF NOT EXISTS phones_order_idx ON phones (status, position);

-- ---------------------------------------------------------------------------
-- Настройки, заявки, аудит
-- ---------------------------------------------------------------------------

-- Настройки приложения, включая секреты (токен бота, ключ провайдера
-- переводов). CHECK ниже — главное в этой таблице: он физически не даёт
-- положить секрет в открытую колонку value. preview — безопасный огрызок
-- вроде '…4821', чтобы в интерфейсе было видно, что ключ вообще задан.
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT    PRIMARY KEY,
  value      TEXT,
  is_secret  INTEGER NOT NULL DEFAULT 0 CHECK (is_secret IN (0, 1)),
  value_ct   BLOB,
  value_iv   BLOB CHECK (value_iv IS NULL OR length(value_iv) = 12),
  value_tag  BLOB CHECK (value_tag IS NULL OR length(value_tag) = 16),
  preview    TEXT,
  updated_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  CHECK (
    (is_secret = 0 AND value_ct IS NULL AND value_iv IS NULL AND value_tag IS NULL)
    OR
    (is_secret = 1 AND value IS NULL
      AND value_ct IS NOT NULL AND value_iv IS NOT NULL AND value_tag IS NOT NULL)
  )
) STRICT, WITHOUT ROWID;

-- Заявки с формы. Пишутся в базу ДО отправки в Telegram: если бот недоступен,
-- заявка не должна потеряться — её заберёт повторная отправка.
-- Здесь лежат персональные данные, поэтому есть purge_after.
CREATE TABLE IF NOT EXISTS leads (
  id                  INTEGER PRIMARY KEY,
  created_at          INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  -- Значения уже нормализованы validateLead() из shared/lead.js.
  name                TEXT    NOT NULL,
  phone               TEXT    NOT NULL,
  message             TEXT    NOT NULL DEFAULT '',
  locale              TEXT    NOT NULL DEFAULT 'ru'
                              CHECK (locale IN ('ru', 'en', 'uz', 'tr', 'ar')),
  -- С какой страницы пришла заявка — по нему видно, какие разделы работают.
  page_path           TEXT,
  ip_hash             TEXT    NOT NULL CHECK (length(ip_hash) = 64),
  ua_hash             TEXT    CHECK (ua_hash IS NULL OR length(ua_hash) = 64),
  telegram_status     TEXT    NOT NULL DEFAULT 'pending' CHECK (
                                telegram_status IN ('pending', 'sent', 'failed', 'skipped')
                              ),
  telegram_message_id INTEGER,
  telegram_error      TEXT,
  status              TEXT    NOT NULL DEFAULT 'new'
                              CHECK (status IN ('new', 'in_progress', 'done', 'spam')),
  handled_by          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  note                TEXT,
  -- Срок хранения ПДн: после этого момента строку стирает уборщик.
  purge_after         INTEGER NOT NULL
) STRICT;

-- Список заявок в админке: целиком по дате и с фильтром по статусу.
CREATE INDEX IF NOT EXISTS leads_created_idx ON leads (created_at DESC);
CREATE INDEX IF NOT EXISTS leads_status_idx ON leads (status, created_at DESC);
-- Очередь повторной отправки в Telegram — маленькая, поэтому индекс частичный.
CREATE INDEX IF NOT EXISTS leads_retry_idx
  ON leads (created_at) WHERE telegram_status IN ('pending', 'failed');
-- Удаление просроченных ПДн.
CREATE INDEX IF NOT EXISTS leads_purge_idx ON leads (purge_after);

-- Журнал действий в админке. Пишется и для отказов (result = 'denied'):
-- попытка сделать то, на что нет прав, интереснее самого действия.
CREATE TABLE IF NOT EXISTS audit_log (
  id        INTEGER PRIMARY KEY,
  at        INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  user_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  -- Логин на момент действия. Дублирует users.username намеренно: при удалении
  -- пользователя user_id обнулится, и без снимка запись станет анонимной.
  actor     TEXT    NOT NULL,
  action    TEXT    NOT NULL,
  entity    TEXT,
  -- TEXT, потому что ключи разнотипные: id проекта, key настройки, locale|key.
  entity_id TEXT,
  ip_hash   TEXT    CHECK (ip_hash IS NULL OR length(ip_hash) = 64),
  -- JSON {before, after}. Секреты в diff не попадают — только факт изменения.
  diff      TEXT    CHECK (diff IS NULL OR json_valid(diff)),
  result    TEXT    NOT NULL DEFAULT 'ok' CHECK (result IN ('ok', 'denied', 'error'))
) STRICT;

CREATE INDEX IF NOT EXISTS audit_log_at_idx ON audit_log (at DESC);
-- «Что происходило с этим объектом» и «что делал этот пользователь».
CREATE INDEX IF NOT EXISTS audit_log_entity_idx ON audit_log (entity, entity_id, at DESC);
CREATE INDEX IF NOT EXISTS audit_log_user_idx ON audit_log (user_id, at DESC);

-- Служебные флаги и счётчики рантайма: 'content_generation' (номер ревизии
-- контента для инвалидации кэша и ETag), 'media_bytes_used' (занято на диске),
-- 'last_purge_at'. Общие на весь пул процессов, поэтому в базе, а не в модуле.
CREATE TABLE IF NOT EXISTS app_state (
  key        TEXT    PRIMARY KEY,
  value      TEXT    NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
) STRICT, WITHOUT ROWID;
