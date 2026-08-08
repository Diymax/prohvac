import { useEffect, useState } from 'react'

import {
  ContentContext,
  FALLBACK_CONTENT,
  FALLBACK_WITHOUT_PHOTOS,
  normalizeContent,
} from './useContent'

// Тот же приём, что и с адресом заявки: адрес выносится в переменную окружения,
// чтобы фронт можно было собрать под другой хост, не правя код.
const CONTENT_ENDPOINT = import.meta.env.VITE_CONTENT_ENDPOINT || '/api/site/content'

/**
 * Контент лендинга: встроенные константы сразу, данные сервера — когда придут.
 *
 * ПОЧЕМУ НЕ «ЗАГРУЗЧИК ВМЕСТО СТРАНИЦЫ». Проекты, партнёры и цифры меняются
 * несколько раз в год, а первый экран должен быть готов немедленно. Стартовать
 * с констант из репозитория (src/data/content.js) — значит показать
 * правильную страницу мгновенно и в худшем случае оставить её слегка
 * устаревшей: при недоступном API, пустой базе или сборке без бэкенда сайт
 * работает целиком, а не показывает пустые секции.
 *
 * ПОЧЕМУ ЗАПРОС РОВНО ОДИН И БЕЗ ПОВТОРОВ. Ответ кэшируется сервером
 * (ETag + max-age=60), а посетитель не сидит на лендинге часами. Повторные
 * попытки после сбоя только добавили бы нагрузки в тот момент, когда серверу
 * и так плохо, — а показывать всё это время есть что.
 *
 * ПОЧЕМУ fetch, А НЕ axios. Здесь нужен один GET без тела, заголовков и
 * перехватчиков, зато нужна отмена по размонтированию: в StrictMode эффект
 * выполняется дважды, и без AbortController первый ответ приходил бы
 * в размонтированный компонент.
 */
const ContentProvider = ({ children }) => {
  // Start without the large photographs: the same shots arrive from the media
  // library within tens of milliseconds, while the bundled ones are already
  // downloading by then and never reach the screen. The full built-in content -
  // photographs included - is set below when the request fails.
  const [content, setContent] = useState(FALLBACK_WITHOUT_PHOTOS)

  useEffect(() => {
    const controller = new AbortController()

    const load = async () => {
      try {
        const response = await fetch(CONTENT_ENDPOINT, {
          signal: controller.signal,
          headers: { Accept: 'application/json' },
          // Ответ одинаков для всех и кэшируется — куки ему не нужны.
          credentials: 'omit',
        })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)

        // Промах маршрута отдаёт оболочку SPA с кодом 200, и без этой проверки
        // в разбор JSON уезжал бы HTML — ошибка была бы не про причину.
        const type = response.headers.get('content-type') || ''
        if (!type.includes('application/json')) {
          throw new Error(`ответ не JSON (${type || 'без Content-Type'})`)
        }

        setContent(normalizeContent(await response.json()))
      } catch (error) {
        // Отмена — это наш собственный размонтированный эффект, а не сбой.
        if (error.name === 'AbortError') return
        console.error('Контент с сервера недоступен, показываем встроенный:', error)
        // This is the only place the bundled photographs are needed: the
        // server will not send any, and a projects section without a single
        // picture looks broken.
        setContent(FALLBACK_CONTENT)
      }
    }

    load()
    return () => controller.abort()
  }, [])

  useEffect(() => {
    const { seo } = content
    const setMeta = (selector, value) => {
      if (!value) return
      const node = document.head.querySelector(selector)
      if (node) node.setAttribute('content', value)
    }

    if (seo.title) document.title = seo.title
    setMeta('meta[name="description"]', seo.description)
    setMeta('meta[property="og:title"]', seo.title)
    setMeta('meta[property="og:description"]', seo.description)
    setMeta('meta[property="og:image"]', seo.ogImage)
    setMeta('meta[name="twitter:title"]', seo.title)
    setMeta('meta[name="twitter:description"]', seo.description)
    setMeta('meta[name="twitter:image"]', seo.ogImage)
  }, [content])

  return <ContentContext.Provider value={content}>{children}</ContentContext.Provider>
}

export default ContentProvider
