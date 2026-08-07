// Экран загрузки картинок.
//
// СЖАТИЕ ПРОИСХОДИТ В БРАУЗЕРЕ. Это главное решение файла и объяснить его надо
// целиком:
//
//   1. Сервер живёт на shared-хостинге с диском 500 МБ на всё сразу (код,
//      node_modules, SQLite, медиа). Снимок с телефона весит 4–8 МБ, и десяток
//      таких загрузок съедает заметную часть тарифа.
//   2. Сжать их на сервере означало бы поставить sharp: это нативные бинарники
//      и десятки мегабайт в node_modules — на том же самом диске. Решение,
//      которое отъедает место, чтобы сэкономить место.
//   3. У браузера всё нужное уже есть: createImageBitmap декодирует файл,
//      canvas масштабирует, toBlob кодирует в WebP. Пользовательский процессор
//      бесплатен для нас, а по сети уходит 150 КБ вместо восьми мегабайт —
//      это ещё и быстрее для того, кто загружает.
//
// КАЧЕСТВО ПОДБИРАЕТСЯ ДВОИЧНЫМ ПОИСКОМ. Связь «качество -> размер» зависит от
// самой картинки: фотография фасада и скриншот с плоской заливкой при q=0.7
// весят по-разному в разы. Фиксированное качество означало бы либо файлы по
// 600 КБ, либо мыло на градиентах. Пять итераций по диапазону 0.4…0.9 дают
// шаг около 0.016 — точнее, чем различает глаз.
//
// ЗАПАСНОЙ ПУТЬ. Старый Safari не умеет ни createImageBitmap, ни WebP
// в toBlob. Оба случая распознаются по факту (проба кодирования), а не по
// строке userAgent, и уходят в JPEG через <img> — сервер принимает и его
// (см. DEFAULT_LIMITS в server/lib/image.js).
//
// СЕРВЕР ВСЁ РАВНО ПРОВЕРЯЕТ ВСЁ. Сжатие здесь — это забота о трафике и диске,
// а не проверка безопасности: клиент подконтролен пользователю, и валидация
// формата, размеров и веса живёт на сервере.

import { useCallback, useEffect, useRef, useState } from 'react'

import { api } from '../api.js'
import ConfirmButton from '../components/ConfirmButton.jsx'
import Notice from '../components/Notice.jsx'
import { invalidateMediaLibrary } from '../components/mediaLibrary.js'
import QuotaBar from '../components/QuotaBar.jsx'
import { errorText, formatBytes, formatDateTime } from '../components/format.js'

const QUALITY_MIN = 0.4
const QUALITY_MAX = 0.9
const QUALITY_STEPS = 5

// ---------------------------------------------------------------------------
// Сжатие
// ---------------------------------------------------------------------------

const canvasToBlob = (canvas, mime, quality) =>
  new Promise((resolve) => {
    canvas.toBlob(resolve, mime, quality)
  })

// Проверяется один раз на вкладку: результат для браузера постоянен, а проба
// хоть и дешёвая, но это лишний холст на каждый файл.
let webpSupport = null

const supportsWebp = async () => {
  if (webpSupport !== null) return webpSupport

  const probe = document.createElement('canvas')
  probe.width = 1
  probe.height = 1
  const blob = await canvasToBlob(probe, 'image/webp', 0.5)
  // Браузер, не знающий формата, молча отдаёт PNG — поэтому смотрим на тип
  // результата, а не на сам факт того, что blob получился.
  webpSupport = Boolean(blob) && blob.type === 'image/webp'
  return webpSupport
}

/**
 * Декодированное изображение и способ его освободить.
 *
 * ImageBitmap держит несжатые пиксели (4 байта на точку: 12-мегапиксельный
 * снимок — это около 50 МБ), поэтому close() обязателен, а не желателен.
 */
const openImage = async (file) => {
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(file)
    return {
      source: bitmap,
      width: bitmap.width,
      height: bitmap.height,
      release: () => bitmap.close?.(),
    }
  }

  const url = URL.createObjectURL(file)
  const image = new Image()
  image.src = url
  // decode() вместо onload: он честно ждёт готовности пикселей, а не только
  // разбора заголовка, и отклоняется на битом файле понятной ошибкой.
  await image.decode()
  return {
    source: image,
    width: image.naturalWidth,
    height: image.naturalHeight,
    release: () => URL.revokeObjectURL(url),
  }
}

const drawTo = (image, maxSide, mime) => {
  const scale = Math.min(1, maxSide / Math.max(image.width, image.height))
  const width = Math.max(1, Math.round(image.width * scale))
  const height = Math.max(1, Math.round(image.height * scale))

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height

  const ctx = canvas.getContext('2d')
  if (mime === 'image/jpeg') {
    // JPEG не умеет прозрачность, и логотип с альфа-каналом получил бы чёрный
    // фон. Белая подложка — то, чего ждёт человек, загружающий PNG с лого.
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, width, height)
  }
  // Качественная интерполяция при уменьшении: без неё тонкие линии на схемах
  // рассыпаются в лесенку.
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(image.source, 0, 0, width, height)

  return { canvas, width, height }
}

/**
 * Двоичный поиск качества.
 *
 * Лучшим считается самый качественный из уложившихся в цель. Если в цель не
 * уложился никто (мелкая деталь на весь кадр), берём самый лёгкий из
 * полученных: пусть файл будет 200 КБ, но загрузка состоится.
 */
const encodeBest = async (canvas, mime, targetBytes) => {
  let low = QUALITY_MIN
  let high = QUALITY_MAX
  let best = null

  for (let step = 0; step < QUALITY_STEPS; step += 1) {
    const quality = (low + high) / 2
    // Шаги поиска последовательны по определению: следующее качество
    // выбирается по размеру предыдущего блоба, поэтому await внутри цикла
    // здесь не потеря параллелизма, а суть алгоритма.
    const blob = await canvasToBlob(canvas, mime, quality)
    if (!blob) break

    if (blob.size <= targetBytes) {
      if (!best || best.size > targetBytes || blob.size > best.size) best = blob
      low = quality
    } else {
      if (!best || (best.size > targetBytes && blob.size < best.size)) best = blob
      high = quality
    }
  }

  return best
}

const renameTo = (name, mime) => {
  const base = String(name || 'image').replace(/\.[^.]+$/, '').slice(0, 80) || 'image'
  return `${base}.${mime === 'image/webp' ? 'webp' : 'jpg'}`
}

/** Сжатая версия файла. Бросает Error с текстом для человека. */
const compress = async (file, capabilities) => {
  const image = await openImage(file)

  try {
    const preferredMime = capabilities.recommendation.preferredMimeType
    const mime =
      preferredMime === 'image/webp' &&
      capabilities.allowedMimeTypes.includes('image/webp') &&
      (await supportsWebp())
        ? 'image/webp'
        : 'image/jpeg'

    let drawn = drawTo(image, capabilities.maxDimension, mime)
    let blob = await encodeBest(drawn.canvas, mime, capabilities.recommendation.targetBytes)

    if (blob && blob.size > capabilities.maxBytes) {
      drawn = drawTo(image, capabilities.recommendation.fallbackDimension, mime)
      blob =
        (await encodeBest(drawn.canvas, mime, capabilities.recommendation.targetBytes)) ?? blob
    }

    if (!blob) {
      // toBlob вернул пустоту: браузер не смог закодировать холст. Отправляем
      // оригинал — сервер разберётся сам, если файл влезает в лимит.
      if (file.size > capabilities.maxBytes) {
        throw new Error('Браузер не смог сжать файл, а оригинал слишком большой')
      }
      return {
        blob: file,
        name: file.name,
        width: image.width,
        height: image.height,
        before: file.size,
        after: file.size,
        compressed: false,
      }
    }

    if (blob.size > capabilities.maxBytes) {
      throw new Error(`Не удалось ужать файл до ${formatBytes(capabilities.maxBytes)}`)
    }

    return {
      blob,
      name: renameTo(file.name, mime),
      width: drawn.width,
      height: drawn.height,
      before: file.size,
      after: blob.size,
      compressed: true,
    }
  } finally {
    image.release()
  }
}

// ---------------------------------------------------------------------------
// Список файлов
// ---------------------------------------------------------------------------

const AVAILABLE = 'available'

// Состояние файла на диске (CR-037). Строка со статусом, отличным от
// available, ссылки на /media/ не получает: файла за ней либо нет, либо он
// уже помечен к удалению, и «рабочий» URL был бы враньём.
const AVAILABILITY_LABEL = {
  available: 'В порядке',
  missing: 'Файл пропал с диска',
  pending_delete: 'Удалён, файл ещё на диске',
  deleted: 'Файл стёрт, запись осталась',
}

const AVAILABILITY_HINT = {
  missing:
    'Записи больше не соответствует файл, и на сайте она не показывается. ' +
    'Загрузите тот же файл заново — он вернётся на своё место, — либо удалите запись окончательно.',
  pending_delete:
    'Файл ещё на диске и его можно вернуть. Через неделю уборка сотрёт его безвозвратно.',
  deleted:
    'Файл с диска стёрт, но строку удалить не удалось. Безопасно только окончательное удаление.',
}

/**
 * Приводит запись медиа к тому, что рисует список. Поля читаются с запасными
 * вариантами: маршрут медиа пишется отдельно, и экран не должен ломаться
 * из-за того, что поле называется filename, а не url.
 */
const viewItem = (item) => {
  const availability = item.availability ?? AVAILABLE
  return {
    id: item.id,
    url:
      availability === AVAILABLE
        ? item.url ?? (item.filename ? `/media/${encodeURIComponent(item.filename)}` : '')
        : '',
    name: item.originalName ?? item.original_name ?? item.filename ?? `файл #${item.id}`,
    bytes: item.bytes ?? 0,
    width: item.width ?? null,
    height: item.height ?? null,
    createdAt: item.createdAt ?? item.created_at ?? 0,
    availability,
    deletedAt: item.deletedAt ?? null,
    unlinkError: item.unlinkError ?? null,
    unlinkAttempts: item.unlinkAttempts ?? 0,
  }
}

const positiveInteger = (value) =>
  Number.isSafeInteger(value) && value > 0 ? value : null

const normalizeCapabilities = (raw) => {
  const maxBytes = positiveInteger(raw?.maxBytes)
  const maxDimension = positiveInteger(raw?.maxDimension)
  const targetBytes = positiveInteger(raw?.recommendation?.targetBytes)
  const fallbackDimension = positiveInteger(raw?.recommendation?.fallbackDimension)
  const allowedMimeTypes = Array.isArray(raw?.allowedMimeTypes)
    ? raw.allowedMimeTypes.filter((item) => typeof item === 'string' && item.startsWith('image/'))
    : []

  if (
    !maxBytes ||
    !maxDimension ||
    !targetBytes ||
    targetBytes > maxBytes ||
    !fallbackDimension ||
    fallbackDimension > maxDimension ||
    !allowedMimeTypes.includes('image/jpeg')
  ) {
    throw new Error('Сервер вернул некорректные ограничения загрузки')
  }

  return {
    maxBytes,
    maxDimension,
    allowedMimeTypes,
    allowedExtensions: Array.isArray(raw.allowedExtensions) ? raw.allowedExtensions : [],
    remainingQuotaBytes: Math.max(0, Number(raw.remainingQuotaBytes) || 0),
    recommendation: {
      targetBytes,
      fallbackDimension,
      preferredMimeType: String(raw.recommendation.preferredMimeType || 'image/jpeg'),
    },
  }
}

// ---------------------------------------------------------------------------
// Экран
// ---------------------------------------------------------------------------

const Media = ({ session }) => {
  const canUpload = session.capabilities?.['media.upload'] === true
  const canDelete = session.capabilities?.['media.delete'] === true
  const [items, setItems] = useState([])
  const [problems, setProblems] = useState([])
  const [usage, setUsage] = useState({ usedBytes: 0, quotaBytes: 0, count: 0 })
  const [capabilities, setCapabilities] = useState(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [notice, setNotice] = useState(null)

  const [jobs, setJobs] = useState([])
  const [uploading, setUploading] = useState(false)
  const [dragging, setDragging] = useState(false)

  const jobId = useRef(0)
  const fileInput = useRef(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await api.get('/api/admin/media')
      if (data?.ok === false) throw data
      setItems((Array.isArray(data?.items) ? data.items : []).map(viewItem))
      setProblems((Array.isArray(data?.problems) ? data.problems : []).map(viewItem))
      setUsage({
        usedBytes: data?.usage?.usedBytes ?? 0,
        quotaBytes: data?.usage?.quotaBytes ?? 0,
        count: data?.usage?.count ?? (data?.items?.length ?? 0),
      })
      setCapabilities(normalizeCapabilities(data?.capabilities))
      setLoadError('')
    } catch (error) {
      setCapabilities(null)
      setLoadError(errorText(error, 'Не удалось загрузить список файлов'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const patchJob = (id, patch) =>
    setJobs((current) => current.map((job) => (job.id === id ? { ...job, ...patch } : job)))

  const uploadOne = async (file) => {
    jobId.current += 1
    const id = jobId.current
    setJobs((current) => [
      { id, name: file.name, before: file.size, after: 0, state: 'compress', message: '' },
      ...current,
    ])

    // SVG — это XML со скриптами внутри, и сервер его не принимает намеренно
    // (см. server/lib/image.js). Отсекаем здесь, чтобы человек увидел причину
    // сразу, а не после загрузки.
    if (!capabilities.allowedMimeTypes.includes(file.type)) {
      patchJob(id, {
        state: 'error',
        message: `Поддерживаются: ${capabilities.allowedMimeTypes.join(', ')}`,
      })
      return false
    }

    let prepared
    try {
      prepared = await compress(file, capabilities)
      patchJob(id, { state: 'upload', after: prepared.after })
    } catch (error) {
      patchJob(id, { state: 'error', message: error.message || 'Не удалось подготовить файл' })
      return false
    }

    try {
      const form = new FormData()
      form.append('file', prepared.blob, prepared.name)

      // api.upload появляется в клиенте, когда для multipart нужен свой путь
      // (у FormData нельзя выставлять Content-Type руками — граница тела
      // генерируется браузером). Если его нет, обычный post справляется сам.
      const data =
        typeof api.upload === 'function'
          ? await api.upload('/api/admin/media', form)
          : await api.post('/api/admin/media', form)
      if (data?.ok === false) throw data

      patchJob(id, {
        state: 'done',
        message: `ID ${data?.id ?? '—'} · ${prepared.width}×${prepared.height}`,
      })
      return true
    } catch (error) {
      patchJob(id, { state: 'error', message: errorText(error, 'Загрузка не удалась') })
      return false
    }
  }

  const handleFiles = async (fileList) => {
    const files = [...(fileList ?? [])]
    if (!files.length) return
    if (!canUpload) {
      setNotice({ kind: 'error', text: 'У вашей роли нет права загружать файлы.' })
      return
    }
    if (!capabilities) {
      setNotice({ kind: 'error', text: 'Ограничения загрузки ещё не получены с сервера.' })
      return
    }

    setUploading(true)
    setNotice(null)
    let uploaded = 0

    // Строго по одному: параллельное сжатие держит в памяти несколько
    // распакованных картинок сразу, и вкладка на телефоне просто падает.
    for (const file of files) {
      const done = await uploadOne(file)
      if (done) uploaded += 1
    }

    setUploading(false)
    if (uploaded) {
      // Библиотека кэшируется на модуль, чтобы пикер в «Каталогах» не дёргал
      // сервер на каждое открытие. Без сброса только что загруженный файл
      // в списке выбора не появился бы до перезагрузки вкладки.
      invalidateMediaLibrary()
      await load()
    }
    if (fileInput.current) fileInput.current.value = ''
  }

  const remove = async (id) => {
    setNotice(null)
    try {
      const data = await api.del(`/api/admin/media/${id}`)
      if (data?.ok === false) throw data
      setNotice({ kind: 'ok', text: `Файл ${id} удалён.` })
      await load()
    } catch (error) {
      setNotice({ kind: 'error', text: errorText(error, 'Не удалось удалить файл') })
    }
  }

  // Возврат мягко удалённого файла. Сервер сначала считает квоту и проверяет
  // файл на диске (CR-034), поэтому единственный неуспешный исход, который
  // здесь нужно объяснить человеку, — это «файла нет, загрузите заново».
  const restore = async (id) => {
    setNotice(null)
    try {
      const data = await api.post(`/api/admin/media/${id}/restore`)
      if (data?.ok === false) throw data
      setNotice({ kind: 'ok', text: `Файл ${id} восстановлен.` })
      invalidateMediaLibrary()
      await load()
    } catch (error) {
      // Ответ приходит либо телом с ok:false, либо ApiError с code — экран
      // читает оба варианта, чтобы объяснение не зависело от способа отказа.
      const reason = error?.error ?? error?.code
      const text =
        reason === 'file_missing'
          ? `Файла ${id} нет на диске. Загрузите тот же файл заново или удалите запись.`
          : reason === 'quota_exceeded'
            ? `Не хватает места, чтобы вернуть файл ${id}. Освободите квоту и повторите.`
            : errorText(error, 'Не удалось восстановить файл')
      setNotice({ kind: 'error', text })
      await load()
    }
  }

  const purge = async (id) => {
    setNotice(null)
    try {
      const data = await api.post(`/api/admin/media/${id}/purge`)
      if (data?.ok === false) throw data
      setNotice({ kind: 'ok', text: `Запись ${id} удалена окончательно.` })
      invalidateMediaLibrary()
      await load()
    } catch (error) {
      const reason = error?.error ?? error?.code
      const detail = error?.payload?.code ?? error?.code ?? 'ошибка'
      const text =
        reason === 'still_referenced'
          ? `Файл ${id} ещё используется в блоках. Сначала уберите ссылки на него.`
          : reason === 'unlink_failed'
            ? `Файл ${id} не удаляется с диска (${detail}). Повторите позже.`
            : errorText(error, 'Не удалось удалить запись')
      setNotice({ kind: 'error', text })
      await load()
    }
  }

  const copyId = async (id) => {
    // Номер файла нужен в разделе «Блоки» (обложка, логотип, галерея), и
    // перепечатывать его руками — самый частый источник опечаток.
    try {
      await navigator.clipboard?.writeText(String(id))
      setNotice({ kind: 'ok', text: `ID ${id} скопирован.` })
    } catch {
      setNotice({ kind: 'info', text: `ID файла: ${id}` })
    }
  }

  return (
    <section className="adm-screen adm-screen--media">
      <header className="adm-screen__head">
        <h1 className="adm-screen__title">Медиа</h1>
        <p className="adm-muted">
          {capabilities
            ? `Картинки сжимаются прямо в браузере: до ${capabilities.maxDimension} пикселей ` +
              `по длинной стороне и примерно до ${formatBytes(capabilities.recommendation.targetBytes)}.`
            : 'Получаю актуальные ограничения загрузки с сервера…'}
        </p>
      </header>

      {!canUpload ? (
        <Notice kind="info">У вашей роли медиатека доступна только для чтения.</Notice>
      ) : null}

      <QuotaBar usedBytes={usage.usedBytes} quotaBytes={usage.quotaBytes} count={usage.count} />

      <div
        className={`adm-drop${dragging ? ' adm-drop--over' : ''}`}
        onDragOver={(event) => {
          event.preventDefault()
          if (!canUpload) return
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault()
          setDragging(false)
          if (canUpload) handleFiles(event.dataTransfer?.files)
        }}
      >
        <p>Перетащите файлы сюда или выберите их вручную.</p>
        <input
          ref={fileInput}
          type="file"
          className="adm-file"
          accept={capabilities?.allowedMimeTypes.join(',') || ''}
          multiple
          disabled={uploading || !capabilities || !canUpload}
          onChange={(event) => handleFiles(event.target.files)}
        />
        {uploading ? <p className="adm-muted">Обрабатываю файлы…</p> : null}
      </div>

      {loadError ? <Notice kind="error">{loadError}</Notice> : null}
      {notice ? <Notice kind={notice.kind}>{notice.text}</Notice> : null}

      {jobs.length > 0 && (
        <ul className="adm-jobs">
          {jobs.map((job) => (
            <li key={job.id} className={`adm-job adm-job--${job.state}`}>
              <span className="adm-job__name">{job.name}</span>
              <span className="adm-job__state">
                {job.state === 'compress' && 'сжимаю…'}
                {job.state === 'upload' && 'загружаю…'}
                {job.state === 'done' && 'готово'}
                {job.state === 'error' && 'ошибка'}
              </span>
              <span className="adm-job__size">
                {job.after
                  ? `было ${formatBytes(job.before)}, стало ${formatBytes(job.after)}`
                  : `было ${formatBytes(job.before)}`}
              </span>
              {job.message ? <span className="adm-job__message">{job.message}</span> : null}
            </li>
          ))}
          <li>
            <button type="button" className="adm-btn adm-btn--ghost" onClick={() => setJobs([])}>
              Очистить список загрузок
            </button>
          </li>
        </ul>
      )}

      {problems.length > 0 && (
        <section className="adm-card adm-media__problems">
          <h2 className="adm-card__title">Требуют внимания: {problems.length}</h2>
          <Notice kind="error">
            База и диск разошлись. Пока запись в этом состоянии, на сайте она не показывается.
          </Notice>
          <ul className="adm-media adm-media--problems">
            {problems.map((item) => (
              <li key={item.id} className="adm-card adm-media__item">
                <div className="adm-media__info">
                  <div className="adm-media__name" title={item.name}>
                    {item.name}
                  </div>
                  <div className="adm-muted">
                    ID {item.id} · {formatBytes(item.bytes)} ·{' '}
                    {AVAILABILITY_LABEL[item.availability] ?? item.availability}
                  </div>
                  {item.deletedAt ? (
                    <div className="adm-muted">Помечен: {formatDateTime(item.deletedAt)}</div>
                  ) : null}
                  {item.unlinkError ? (
                    <div className="adm-muted">
                      Не удалось стереть файл: {item.unlinkError} (попыток {item.unlinkAttempts})
                    </div>
                  ) : null}
                  <p className="adm-muted">
                    {AVAILABILITY_HINT[item.availability] ?? 'Состояние записи неизвестно.'}
                  </p>
                </div>

                <div className="adm-media__actions">
                  {canUpload && item.availability !== 'deleted' ? (
                    <button type="button" className="adm-btn" onClick={() => restore(item.id)}>
                      Восстановить
                    </button>
                  ) : null}
                  {canDelete ? (
                    <ConfirmButton
                      onConfirm={() => purge(item.id)}
                      confirmLabel="Точно удалить навсегда"
                    >
                      Удалить окончательно
                    </ConfirmButton>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="adm-toolbar">
        <button type="button" className="adm-btn" onClick={load} disabled={loading}>
          Обновить
        </button>
        <span className="adm-muted">Файлов: {items.length}</span>
      </div>

      {loading && !items.length ? <p className="adm-muted">Загружаю библиотеку…</p> : null}
      {!loading && !items.length ? <p className="adm-muted">Файлов пока нет.</p> : null}

      <ul className="adm-media">
        {items.map((item) => (
          <li key={item.id} className="adm-card adm-media__item">
            {item.url ? (
              <img className="adm-media__thumb" src={item.url} alt={item.name} loading="lazy" />
            ) : (
              <span className="adm-media__thumb adm-media__thumb--empty" aria-hidden="true" />
            )}

            <div className="adm-media__info">
              <div className="adm-media__name" title={item.name}>
                {item.name}
              </div>
              <div className="adm-muted">
                ID {item.id} · {formatBytes(item.bytes)}
                {item.width && item.height ? ` · ${item.width}×${item.height}` : ''}
              </div>
              <div className="adm-muted">{formatDateTime(item.createdAt)}</div>
            </div>

            <div className="adm-media__actions">
              <button type="button" className="adm-btn" onClick={() => copyId(item.id)}>
                Копировать ID
              </button>
              {canDelete ? <ConfirmButton onConfirm={() => remove(item.id)} /> : null}
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}

export default Media
