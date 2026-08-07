// Контент лендинга: контекст, разбор ответа сервера и хук доступа.
//
// ПОЧЕМУ ВСЁ ЭТО ЗДЕСЬ, А НЕ В ContentProvider.jsx. Компонентам нужен только
// хук, и если бы контекст жил рядом с провайдером, каждый импорт хука тянул бы
// за собой провайдер — а заодно получился бы цикл, потому что провайдеру нужен
// нормализатор. Плюс файл без JSX не попадает под правило react-refresh
// о смешанных экспортах.
//
// ПОЧЕМУ ДАННЫЕ РАЗБИРАЮТСЯ, А НЕ КЛАДУТСЯ В КОНТЕКСТ КАК ЕСТЬ. Ответ приходит
// по сети и может быть каким угодно: подменённым прокси, обрезанным, старой
// версии API. Компоненты обращаются к item.icon.url и item.cover.w без
// проверок, поэтому единственное место, где эти проверки имеют смысл, — вход.
// Всё, что не разобралось, отбрасывается поштучно: один битый партнёр не
// должен уносить с собой весь лендинг.

import { createContext, useContext } from 'react'

import {
  ABOUT_GALLERY,
  ADVANTAGES,
  PARTNERS,
  PHONES,
  PROJECTS,
  STATS,
} from '../data/content'

// Знак после числа по умолчанию. Пустой suffix означает «редактор ничего не
// дописал», и это ровно тот случай, который на макете выглядит как «53+»:
// плюс был зашит в компонент счётчика, а не в данные. Свой суффикс редактор
// задаёт прямо в значении цифры ('100 кВт', '24/7') — сервер отрежет число
// и вернёт остаток сюда.
const DEFAULT_STAT_SUFFIX = '+'

// Сколько фотографий показывает блок «О компании».
const GALLERY_SIZE = 3

// Слоты первого экрана нумерует база (stats.hero_slot BETWEEN 1 AND 4).
const MAX_HERO_SLOT = 4

const list = (value) => (Array.isArray(value) ? value : [])

const text = (value) => (typeof value === 'string' ? value : '')

const positiveInt = (value) =>
  Number.isFinite(value) && value > 0 ? Math.round(value) : null

/**
 * Картинка {url, w, h} или null, если её нет.
 *
 * Размеры принимаются только парой: по одной стороне пропорцию не восстановить,
 * а половинчатый width у <img> хуже отсутствующего — браузер посчитает вторую
 * сторону из CSS и всё равно передвинет соседей после загрузки.
 */
const picture = (raw) => {
  if (!raw || typeof raw !== 'object') return null
  const url = text(raw.url)
  if (!url) return null

  const w = positiveInt(raw.w)
  const h = positiveInt(raw.h)
  return { url, w: w && h ? w : null, h: w && h ? h : null }
}

const tone = (raw) => (raw === 'warm' ? 'warm' : 'cold')

const normalizeAdvantages = (raw) =>
  list(raw)
    .map((item) => ({
      slug: text(item?.slug),
      tone: tone(item?.tone),
      icon: picture(item?.icon),
    }))
    // Без slug нечем ни адресовать перевод, ни задать ключ списка.
    .filter((item) => item.slug)

const normalizeStats = (raw) =>
  list(raw)
    .map((item) => {
      const value = Number.isFinite(item?.value) ? item.value : null
      const slot = positiveInt(item?.heroSlot)
      const suffix = text(item?.suffix)
      return {
        slug: text(item?.slug),
        value,
        // Плюс дописываем только к числу: у чисто текстовой цифры
        // ('ISO 9001') суффикс — это и есть всё её содержимое.
        suffix: suffix || (value === null ? '' : DEFAULT_STAT_SUFFIX),
        tone: tone(item?.tone),
        heroSlot: slot && slot <= MAX_HERO_SLOT ? slot : null,
      }
    })
    .filter((item) => item.slug && (item.value !== null || item.suffix))

/** Фотографии проекта без повторов: url — ключ списка в галерее. */
const normalizePhotos = (raw) => {
  const seen = new Set()
  const photos = []
  for (const item of list(raw)) {
    const photo = picture(item)
    if (!photo || seen.has(photo.url)) continue
    seen.add(photo.url)
    photos.push(photo)
  }
  return photos
}

const normalizeProjects = (raw) =>
  list(raw)
    .map((item) => ({
      slug: text(item?.slug),
      cover: picture(item?.cover),
      photos: normalizePhotos(item?.photos),
    }))
    .filter((item) => item.slug)

const normalizePartners = (raw) =>
  list(raw)
    .map((item) => ({
      slug: text(item?.slug),
      name: text(item?.name),
      logo: picture(item?.logo),
    }))
    // Партнёр без названия и без логотипа — пустое место в ленте.
    .filter((item) => item.slug && (item.name || item.logo))

// Телефон уходит в href="tel:", поэтому формат проверяется здесь, а не в вёрстке:
// E.164 и ничего кроме (тот же CHECK стоит на колонке phones.e164).
const E164 = /^\+[0-9]{7,15}$/

const normalizePhones = (raw) => list(raw).filter((item) => typeof item === 'string' && E164.test(item))

const normalizeGallery = (raw) =>
  list(raw)
    .map((item) => {
      const image = picture(item)
      if (!image) return null
      return { ...image, altKey: text(item?.altKey) || null }
    })
    .filter(Boolean)

const FALLBACK_GALLERY = normalizeGallery(ABOUT_GALLERY)

/**
 * Галерея «О компании» из фотографий проектов.
 *
 * Отдельной сущности под неё в API нет, и заводить её ради трёх картинок
 * значило бы ещё одну таблицу и ещё один экран админки. Берём по одному снимку
 * с проекта — так в блоке оказываются разные объекты, а не один и тот же
 * с трёх ракурсов. Обложки пропускаем: они уже показаны в карточках выше.
 * Если фотографий не хватает, показываем встроенную галерею целиком —
 * половина блока выглядит как сломанная вёрстка, а не как решение редактора.
 */
const galleryFromProjects = (projects) => {
  const covers = new Set(projects.map((item) => item.cover?.url).filter(Boolean))
  const taken = new Set()
  const picked = []

  const take = (photo) => {
    if (picked.length >= GALLERY_SIZE) return true
    if (covers.has(photo.url) || taken.has(photo.url)) return false
    taken.add(photo.url)
    picked.push({ ...photo, altKey: null })
    return picked.length >= GALLERY_SIZE
  }

  for (const project of projects) {
    const photo = project.photos.find((item) => !covers.has(item.url) && !taken.has(item.url))
    if (photo && take(photo)) break
  }
  // Проектов оказалось меньше трёх — добираем остаток их же фотографиями.
  if (picked.length < GALLERY_SIZE) {
    for (const project of projects) {
      if (project.photos.some(take)) break
    }
  }

  return picked.length === GALLERY_SIZE ? picked : FALLBACK_GALLERY
}

/**
 * Ответ сервера (или встроенные константы) → то, чем пользуются компоненты.
 * Вычисляемые поля (heroFacts, gallery) считаются здесь один раз на ответ,
 * а не в каждом рендере компонента.
 */
export const normalizeContent = (raw) => {
  const source = raw && typeof raw === 'object' ? raw : {}
  const projects = normalizeProjects(source.projects)
  const stats = normalizeStats(source.stats)

  return {
    advantages: normalizeAdvantages(source.advantages),
    stats,
    // Первый экран показывает те же цифры, что и блок «В нашей компании»,
    // просто не все и в своём порядке — его задаёт heroSlot.
    heroFacts: stats
      .filter((item) => item.heroSlot !== null)
      .sort((a, b) => a.heroSlot - b.heroSlot),
    projects,
    partners: normalizePartners(source.partners),
    gallery: source.gallery ? normalizeGallery(source.gallery) : galleryFromProjects(projects),
    phones: normalizePhones(source.phones),
    form: {
      // Только настоящий boolean включает обязательность. Строка "false"
      // из старого/подменённого ответа не должна внезапно сделать поле обязательным.
      requireMessage: source.form?.requireMessage === true,
    },
    seo: {
      title: text(source.seo?.title),
      description: text(source.seo?.description),
      ogImage: text(source.seo?.ogImage),
    },
  }
}

/** Контент из репозитория. Он же значение контекста, пока сервер не ответил. */
export const FALLBACK_CONTENT = normalizeContent({
  advantages: ADVANTAGES,
  stats: STATS,
  projects: PROJECTS,
  partners: PARTNERS,
  gallery: ABOUT_GALLERY,
  phones: PHONES,
})

// Значение по умолчанию — не пустой объект: компонент, отрисованный вне
// провайдера (тест, отдельная страница), обязан показать контент, а не упасть
// на content.projects.map.
export const ContentContext = createContext(FALLBACK_CONTENT)

/**
 * Атрибуты width/height для <img>. Ставятся ровно тогда, когда известны обе
 * стороны: пропорция из них нужна браузеру, чтобы зарезервировать место
 * до загрузки файла. Итоговый размер всё равно задаёт CSS.
 */
export const sizeAttrs = (image) =>
  image?.w && image?.h ? { width: image.w, height: image.h } : {}

/** Весь контент лендинга. */
const useContent = () => useContext(ContentContext)

export default useContent
