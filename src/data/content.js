// Контент лендинга ПО УМОЛЧАНИЮ.
//
// Единственный источник правды теперь сервер (GET /api/site/content), а этот
// файл — то, что страница показывает, пока ответ не пришёл или не придёт
// никогда: первый кадр до ответа, дев-сборка без бэкенда, недоступная база.
// Поэтому здесь нет ни пустых массивов, ни заглушек — ровно тот контент,
// который был на сайте до появления админки.
//
// ФОРМА ОБЪЕКТОВ ПОВТОРЯЕТ ФОРМУ ОТВЕТА API один в один: картинка — это
// {url, w, h}, ключ элемента — slug. Иначе ContentProvider не смог бы подменить
// данные целиком, а каждый компонент разбирал бы два формата.
//
// РАЗМЕРЫ КАРТИНОК НАСТОЯЩИЕ — прочитаны из заголовков файлов в
// src/assets/design (тем же кодом, что и на сервере: server/lib/image.js).
// Без пары w/h браузер не знает пропорций до загрузки и верстку дёргает
// по мере подгрузки; выдуманные числа дают тот же эффект, только незаметнее.

import adv1 from '../assets/design/adv-1.webp'
import adv2 from '../assets/design/adv-2.webp'
import adv3 from '../assets/design/adv-3.webp'
import adv4 from '../assets/design/adv-4.webp'

import pr1 from '../assets/design/pr-1.webp'
import pr2 from '../assets/design/pr-2.webp'
import pr3 from '../assets/design/pr-3.webp'
import pr4 from '../assets/design/pr-4.webp'
import pr5 from '../assets/design/pr-5.webp'
import pr6 from '../assets/design/pr-6.webp'

import w1 from '../assets/design/w1.webp'
import w2 from '../assets/design/w2.webp'
import w3 from '../assets/design/w3.webp'
import w4 from '../assets/design/w4.webp'
import w5 from '../assets/design/w5.webp'
import roofUnits from '../assets/design/roof-units.webp'
import operaExt from '../assets/design/opera-ext.webp'
import facadeUnits from '../assets/design/facade-units.webp'
import crewRoof from '../assets/design/crew-roof.webp'
import boilerFerroli from '../assets/design/boiler-ferroli.webp'

import brShivaki from '../assets/design/br-shivaki.webp'
import brAux from '../assets/design/br-aux.webp'
import brToshiba from '../assets/design/br-toshiba.webp'
import brHisense from '../assets/design/br-hisense.webp'
import brMitsubishi from '../assets/design/br-mitsubishi.svg'
import brAkfa from '../assets/design/br-akfa.webp'
import brKoc from '../assets/design/br-koc.webp'
import brDiscover from '../assets/design/br-discover.webp'

/** Картинка в том же виде, в каком её отдаёт API. */
const img = (url, w, h) => ({ url, w, h })

// Каждый файл описан один раз: одна и та же фотография участвует и в галерее
// проекта, и в блоке «О компании», а размеры у неё, разумеется, одни.
const PICTURES = {
  adv1: img(adv1, 96, 96),
  adv2: img(adv2, 160, 140),
  adv3: img(adv3, 160, 137),
  adv4: img(adv4, 100, 100),

  pr1: img(pr1, 1920, 1280),
  pr2: img(pr2, 1280, 720),
  pr3: img(pr3, 1920, 669),
  pr4: img(pr4, 800, 500),
  pr5: img(pr5, 1200, 675),
  pr6: img(pr6, 1920, 1081),

  w1: img(w1, 1280, 960),
  w2: img(w2, 1280, 960),
  w3: img(w3, 1280, 720),
  w4: img(w4, 1280, 720),
  w5: img(w5, 1280, 960),
  roofUnits: img(roofUnits, 1280, 960),
  operaExt: img(operaExt, 1280, 960),
  facadeUnits: img(facadeUnits, 1280, 960),
  crewRoof: img(crewRoof, 960, 1280),
  boilerFerroli: img(boilerFerroli, 1280, 720),
}

export const ADVANTAGES = [
  { slug: 'consult', tone: 'cold', icon: PICTURES.adv1 },
  { slug: 'equipment', tone: 'cold', icon: PICTURES.adv2 },
  { slug: 'install', tone: 'warm', icon: PICTURES.adv3 },
  { slug: 'team', tone: 'warm', icon: PICTURES.adv4 },
]

// value — число для счётчика, suffix — то, что дописывается за ним. Пустой
// suffix здесь означает ровно то же, что и в ответе сервера: знак по умолчанию
// («+») подставит нормализатор, см. src/content/useContent.js.
//
// heroSlot — место на первом экране. Раньше те же три цифры были отдельным
// массивом FACTS в Hero.jsx и жили своей жизнью: правка «53 объекта» в одном
// месте не доезжала до другого.
export const STATS = [
  { slug: 'staff', value: 50, suffix: '', tone: 'cold', heroSlot: 2 },
  { slug: 'objects', value: 53, suffix: '', tone: 'cold', heroSlot: 1 },
  { slug: 'equipment', value: 100, suffix: '', tone: 'warm', heroSlot: null },
  { slug: 'years', value: 20, suffix: '', tone: 'warm', heroSlot: 3 },
]

export const PROJECTS = [
  {
    slug: 'caex',
    cover: PICTURES.pr1,
    photos: [PICTURES.pr1, PICTURES.w3, PICTURES.roofUnits, PICTURES.w1],
  },
  {
    slug: 'opera',
    cover: PICTURES.pr2,
    photos: [PICTURES.pr2, PICTURES.operaExt, PICTURES.facadeUnits, PICTURES.crewRoof],
  },
  {
    slug: 'ramada',
    cover: PICTURES.pr3,
    photos: [PICTURES.pr3, PICTURES.boilerFerroli, PICTURES.w5, PICTURES.w2],
  },
  {
    slug: 'school',
    cover: PICTURES.pr4,
    photos: [PICTURES.pr4, PICTURES.w1, PICTURES.w4, PICTURES.w3],
  },
  {
    slug: 'yurt',
    cover: PICTURES.pr5,
    photos: [PICTURES.pr5, PICTURES.roofUnits, PICTURES.w5, PICTURES.w2],
  },
  {
    slug: 'renaissance',
    cover: PICTURES.pr6,
    photos: [PICTURES.pr6, PICTURES.facadeUnits, PICTURES.w4, PICTURES.boilerFerroli],
  },
]

// slug'и совпадают с теми, что сервер выводит из названия партнёра
// (см. partnerSlug в server/routes/public.content.js): подмена данных не должна
// менять ключи списка, иначе React перерисует ленту целиком.
export const PARTNERS = [
  { slug: 'shivaki', name: 'Shivaki', logo: img(brShivaki, 225, 225) },
  { slug: 'aux', name: 'AUX', logo: img(brAux, 600, 400) },
  { slug: 'toshiba', name: 'Toshiba', logo: img(brToshiba, 225, 225) },
  { slug: 'hisense', name: 'Hisense', logo: img(brHisense, 225, 225) },
  // Единственный логотип в SVG. В media такой формат не принимается (это
  // исполняемый XML), поэтому с сервера этот партнёр приходит без картинки,
  // и Partners.jsx показывает его название текстом.
  { slug: 'mitsubishi-electric', name: 'Mitsubishi Electric', logo: img(brMitsubishi, 2500, 2500) },
  { slug: 'akfa-build', name: 'AKFA Build', logo: img(brAkfa, 225, 225) },
  { slug: 'koc-construction', name: 'KOC Construction', logo: img(brKoc, 537, 450) },
  { slug: 'discover-invest', name: 'Discover Invest', logo: img(brDiscover, 225, 225) },
]

// Галерея блока «О компании». Своей сущности в API у неё нет, поэтому с сервера
// она собирается из фотографий проектов (см. useContent.js); altKey работает
// только здесь — подпись «Монтаж воздуховодов» осмысленна лишь для конкретного
// снимка, а не для произвольного файла из админки.
export const ABOUT_GALLERY = [
  { ...PICTURES.w1, altKey: 'about.alt1' },
  { ...PICTURES.facadeUnits, altKey: 'about.alt2' },
  { ...PICTURES.w4, altKey: 'about.alt3' },
]

export const PHONES = ['+998998555045', '+998998956568', '+998909161020']

export const formatPhone = (raw) => {
  const d = raw.replace(/\D/g, '')
  return `+${d.slice(0, 3)} ${d.slice(3, 5)} ${d.slice(5, 8)} ${d.slice(8, 10)} ${d.slice(10, 12)}`
}

// Навигация. inFooter отмечает пункты, которые дублируются в подвале:
// раньше подвал держал собственный массив COMPANY_LINKS, и добавленный
// в шапку раздел появлялся в меню, но не в подвале.
// footerKey — исключение для «Проекты»: в подвале у пункта своя формулировка.
export const NAV_LINKS = [
  { href: '#info', key: 'nav.info', inFooter: false },
  { href: '#about', key: 'nav.about', inFooter: true },
  { href: '#projects', key: 'nav.projects', footerKey: 'footer.projects', inFooter: true },
  { href: '#enterprises', key: 'nav.enterprises', inFooter: true },
  { href: '#services', key: 'nav.adv', inFooter: true },
]

export const FOOTER_LINKS = NAV_LINKS
  .filter((link) => link.inFooter)
  .map((link) => ({ href: link.href, key: link.footerKey ?? link.key }))

// Список языков. Тот же массив читает инициализация i18next
// (src/language/i18next.js) — до этого коды были перечислены там ещё раз,
// и новый язык требовалось добавить в двух местах.
export const LANGUAGES = [
  { code: 'ru', label: 'Русский' },
  { code: 'en', label: 'English' },
  { code: 'uz', label: "O'zbekcha" },
  { code: 'tr', label: 'Türkçe' },
  { code: 'ar', label: 'العربية' },
]
