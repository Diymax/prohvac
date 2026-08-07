// Выбор картинки из библиотеки медиа.
//
// ЧТО БЫЛО. Обложка проекта, логотип партнёра и иконка преимущества
// привязывались вводом числового идентификатора файла: редактор открывал
// раздел «Медиа», искал глазами нужную картинку, запоминал номер, возвращался
// в «Каталоги» и печатал его в поле. Для галереи проекта — то же самое, только
// номеров до тридцати и через запятую, в нужном порядке. Ошибка в одной цифре
// молча привязывала чужой файл: проверить это можно было, лишь открыв сайт.
//
// ЧТО СТАЛО. Кнопка открывает ту же библиотеку прямо в форме, а идентификатор
// подставляется кликом по миниатюре. Поле ввода остаётся на месте и работает
// по-прежнему: у кого номер уже записан, тот его вставит, а у пикера нет
// монополии на правильный ответ.
//
// СПИСОК ФАЙЛОВ КЭШИРУЕТСЯ (см. mediaLibrary.js). Он одинаков для всех полей
// формы, и запрашивать его на каждое открытие пикера значило бы дёргать сервер
// столько раз, сколько картинок у проекта. Кнопка «Обновить» сбрасывает кэш —
// она нужна ровно после загрузки нового файла в соседней вкладке.

import { useCallback, useEffect, useState } from 'react'

import { errorText, formatBytes } from './format.js'
import { cachedMediaLibrary, loadMediaLibrary } from './mediaLibrary.js'

/**
 * @param {{
 *   value: string,                 // текущее значение поля (id или список id)
 *   multiple?: boolean,            // галерея: клик добавляет, а не заменяет
 *   disabled?: boolean,
 *   onPick: (next: string) => void // новое значение поля целиком
 * }} props
 */
const MediaPicker = ({ value, multiple = false, disabled = false, onPick }) => {
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState(cachedMediaLibrary)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const fetchLibrary = useCallback(async (options) => {
    setLoading(true)
    setError('')
    try {
      setItems(await loadMediaLibrary(options))
    } catch (failure) {
      setError(errorText(failure, 'Не удалось загрузить библиотеку'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (open && !items.length) fetchLibrary()
  }, [open, items.length, fetchLibrary])

  // Уже выбранные идентификаторы: по ним в сетке отмечаются использованные
  // файлы, иначе в галерее из тридцати картинок невозможно понять, какие
  // из них уже добавлены.
  const selected = new Set(
    String(value ?? '')
      .split(/[\s,;]+/)
      .filter(Boolean)
  )

  const pick = (id) => {
    const key = String(id)

    if (!multiple) {
      onPick(selected.has(key) ? '' : key)
      setOpen(false)
      return
    }

    // Повторный клик снимает выбор: это единственный способ убрать картинку
    // из середины галереи, не переписывая список руками.
    const next = selected.has(key)
      ? [...selected].filter((item) => item !== key)
      : [...selected, key]
    onPick(next.join(', '))
  }

  const preview = [...selected]
    .map((id) => items.find((item) => String(item.id) === id))
    .filter(Boolean)

  return (
    <div className="adm-picker">
      <div className="adm-picker__bar">
        <button
          type="button"
          className="adm-btn"
          onClick={() => setOpen((current) => !current)}
          disabled={disabled}
          aria-expanded={open}
        >
          {open ? 'Свернуть библиотеку' : multiple ? 'Выбрать файлы' : 'Выбрать файл'}
        </button>

        {selected.size > 0 && (
          <button
            type="button"
            className="adm-btn adm-btn--ghost"
            onClick={() => onPick('')}
            disabled={disabled}
          >
            Очистить
          </button>
        )}
      </div>

      {/* Миниатюры выбранного показываются всегда, а не только в открытом
          пикере: без них поле с номером снова становится числом без смысла. */}
      {preview.length > 0 && (
        <ul className="adm-picker__preview">
          {preview.map((item) => (
            <li key={item.id}>
              <img src={item.url} alt={item.originalName || ''} loading="lazy" />
            </li>
          ))}
        </ul>
      )}

      {open && (
        <div className="adm-picker__panel">
          <div className="adm-picker__panel-head">
            <span className="adm-muted">
              {loading ? 'Загружаю…' : `Файлов: ${items.length}`}
            </span>
            <button
              type="button"
              className="adm-btn adm-btn--ghost"
              onClick={() => fetchLibrary({ force: true })}
              disabled={loading || disabled}
            >
              Обновить
            </button>
          </div>

          {error ? <p className="adm-notice adm-notice--error">{error}</p> : null}

          {!loading && !items.length && !error ? (
            <p className="adm-muted">
              Библиотека пуста — загрузите картинки в разделе «Медиа».
            </p>
          ) : null}

          <ul className="adm-picker__grid">
            {items.map((item) => {
              const active = selected.has(String(item.id))
              return (
                <li key={item.id}>
                  <button
                    type="button"
                    className={`adm-picker__item${active ? ' adm-picker__item--active' : ''}`}
                    onClick={() => pick(item.id)}
                    disabled={disabled}
                    title={`${item.originalName || item.filename} · ${formatBytes(item.bytes)}`}
                  >
                    <img src={item.url} alt="" loading="lazy" />
                    <span className="adm-picker__id">#{item.id}</span>
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </div>
  )
}

export default MediaPicker
