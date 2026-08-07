-- 012_lead_attribution.sql — откуда пришёл посетитель, оставивший заявку.
--
-- Зачем в своей базе, если есть Метрика. Отчёты Метрики отвечают на вопрос
-- «сколько визитов дал канал», но не на вопрос «эта конкретная заявка —
-- из какого канала». Второй вопрос задаёт менеджер, глядя на строку в списке
-- заявок, и ответ на него должен быть в той же строке. Плюс блокировщики
-- режут счётчик у заметной доли посетителей — заявка при этом доходит, и
-- терять её атрибуцию из-за чужого расширения незачем.
--
-- Все колонки NULLABLE и без CHECK: заявка без атрибуции — обычная заявка.
-- Единственное правило (длины и отбрасывание мусора) живёт в shared/lead.js,
-- потому что применять его надо и в браузере, и на сервере.
--
-- Сроком хранения эти колонки не отличаются от остальной строки: их стирает
-- тот же уборщик по leads.purge_after. Отдельной политики для ym_client_id
-- нет намеренно — «заявка удалена, а хвост от неё остался» хуже, чем ничего.
--
-- ALTER TABLE ... ADD COLUMN на STRICT-таблице допустим: колонка добавляется
-- со значением NULL, существующие строки не переписываются.

ALTER TABLE leads ADD COLUMN utm_source   TEXT;
ALTER TABLE leads ADD COLUMN utm_medium   TEXT;
ALTER TABLE leads ADD COLUMN utm_campaign TEXT;
ALTER TABLE leads ADD COLUMN utm_content  TEXT;
ALTER TABLE leads ADD COLUMN utm_term     TEXT;
ALTER TABLE leads ADD COLUMN yclid        TEXT;
ALTER TABLE leads ADD COLUMN gclid        TEXT;
ALTER TABLE leads ADD COLUMN ym_client_id TEXT;
ALTER TABLE leads ADD COLUMN referrer     TEXT;

-- Разрез «заявки по источнику» — единственный запрос, который будет ходить
-- по этим колонкам в админке. Частичный индекс: у заявок без меток source
-- пустой, и держать их в индексе незачем.
CREATE INDEX IF NOT EXISTS leads_utm_source_idx
  ON leads (utm_source, created_at DESC) WHERE utm_source IS NOT NULL;
