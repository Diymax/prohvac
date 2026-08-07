// Стабильные идентификаторы клиента для журналов, лимитера и привязки сессии.
//
// ПОЧЕМУ НЕ СЫРОЙ IP.
// Адрес — персональные данные, а журнал входов и заявок живёт месяцами и
// уезжает в бэкап вместе со всей базой. При этом всё, ради чего адрес нужен
// (счётчик попыток, блокировка перебора, «та же ли машина у сессии»), требует
// только одного: чтобы одинаковые запросы давали одинаковую строку. Обратное
// преобразование не нужно нигде, поэтому его и не должно быть возможно.
//
// HMAC, а не голый sha256: всё пространство IPv4 — это 2^32 значений, полный
// перебор SHA-256 по нему считается на ноутбуке за минуты, и «анонимный» хеш
// раскручивается обратно в адрес. Ключ выводится из APP_SECRET, которого
// в дампе базы нет.
//
// Ключи для IP и UA разные (HKDF с разными метками): иначе строка, случайно
// попавшая и в адрес, и в User-Agent, дала бы одинаковый хеш, и по совпадению
// ua_hash с ip_hash можно было бы подтверждать догадки о содержимом.

import { createHmac } from 'node:crypto'

import { deriveKey } from './secretbox.js'

const PURPOSE_IP = 'hashid-ip'
const PURPOSE_UA = 'hashid-ua'

// Полный SHA-256 в нижнем регистре: схема БД проверяет CHECK(length(...) = 64)
// именно для того, чтобы поймать случайную запись сырого адреса в колонку
// (IPv6 максимум 45 символов, под условие не попадёт). Обрезать хеш ради места
// нельзя, не переписав миграцию.
const hmacHex = (purpose, value) =>
  createHmac('sha256', deriveKey(purpose)).update(value, 'utf8').digest('hex')

// Вход в HMAC размечен: клиентское значение всегда идёт после 'ip=' или 'ua=',
// а заглушка «неизвестно» такой формы не имеет. Иначе клиент, приславший
// в заголовке буквальное 'unknown', попадал бы в общее ведро вместе с теми,
// у кого адрес не определился, — и подмешивал бы им свои попытки.
const IP_TAG = 'ip='
const UA_TAG = 'ua='
const UNKNOWN_IP = 'ip-unknown'
const UNKNOWN_UA = 'ua-unknown'

// User-Agent приходит из заголовка, а его длину ограничивает только фронтовый
// прокси. HMAC от восьми килобайт на каждом запросе — бессмысленная работа,
// а различает клиентов и первая сотня символов.
const UA_MAX = 512

const IPV4_WITH_PORT = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/
const IPV6_BRACKETED = /^\[([^\]]+)\](?::\d+)?$/
// IPv4-mapped: '::ffff:203.0.113.5' и '203.0.113.5' — один и тот же клиент,
// а какая форма придёт, зависит от того, слушает ли Passenger двойной стек.
const IPV4_MAPPED = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/

/**
 * Приводит адрес к одному виду. Разные слои (X-Forwarded-For, socket,
 * заголовок Forwarded) отдают один и тот же адрес по-разному, а лимитер,
 * который считает 'FE80::1', '[fe80::1]:443' и 'fe80::1%eth0' тремя разными
 * клиентами, не лимитирует ничего.
 */
const normalizeIp = (ip) => {
  const value = String(ip ?? '').trim().toLowerCase()
  if (!value) return null

  const bracketed = IPV6_BRACKETED.exec(value)
  let host = bracketed ? bracketed[1] : value

  // Порт отрезаем только у IPv4: в IPv6 двоеточий много, и последнее из них
  // разделяет группы, а не порт (для IPv6 порт приходит в скобках, см. выше).
  const withPort = IPV4_WITH_PORT.exec(host)
  if (withPort) host = withPort[1]

  // Идентификатор зоны link-local ('fe80::1%eth0') относится к интерфейсу
  // сервера, а не к клиенту.
  const zone = host.indexOf('%')
  if (zone !== -1) host = host.slice(0, zone)

  const mapped = IPV4_MAPPED.exec(host)
  if (mapped) host = mapped[1]

  return host || null
}

const IPV6_GROUPS = 8
// Хешируем только /64. Провайдер выдаёт абоненту целую подсеть, и адрес внутри
// неё меняется хоть на каждом запросе (RFC 4941, privacy extensions): счётчик
// попыток по полному адресу перебор просто не заметил бы. /64 — минимальный
// блок, который назначается одному клиенту, и его смена уже требует усилий.
const IPV6_PREFIX_GROUPS = 4
const IPV6_GROUP = /^[0-9a-f]{1,4}$/

/**
 * Первые четыре группы IPv6 в каноническом виде. Возвращает null, если строка
 * не разбирается как IPv6, — вызывающий тогда хеширует её как есть, и мусорный
 * заголовок остаётся мусорным хешем, а не превращается в чужое ведро.
 */
const ipv6Prefix = (host) => {
  if (!host.includes(':')) return null

  // '::' встречается в адресе не более одного раза (RFC 4291 §2.2).
  const halves = host.split('::')
  if (halves.length > 2) return null

  const head = halves[0] ? halves[0].split(':') : []
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const zeros = halves.length === 2 ? IPV6_GROUPS - head.length - tail.length : 0
  if (zeros < 0) return null

  const groups = [...head, ...Array(zeros).fill('0'), ...tail]
  if (groups.length !== IPV6_GROUPS) return null
  // Встроенный IPv4 ('2001:db8::192.0.2.1') сюда не проходит и уйдёт в общий
  // путь: форма редкая, а отдельный разбор ради неё — лишний источник ошибок.
  if (!groups.every((group) => IPV6_GROUP.test(group))) return null

  // Ведущие нули убираем: '2001:0db8::' и '2001:db8::' — один и тот же адрес,
  // и хеш у них обязан совпасть.
  return groups
    .slice(0, IPV6_PREFIX_GROUPS)
    .map((group) => group.replace(/^0+(?=.)/, ''))
    .join(':')
}

/**
 * HMAC-хеш адреса: 64 hex-символа в нижнем регистре, как требует схема БД.
 * Неизвестный адрес даёт общий хеш-заглушку, а не null: колонка ip_hash
 * объявлена NOT NULL, и запрос без адреса должен попадать хоть в какое-то
 * ведро лимитера, а не обходить его.
 *
 * @param {string|null|undefined} ip
 * @returns {string}
 */
export const hashIp = (ip) => {
  const host = normalizeIp(ip)
  if (!host) return hmacHex(PURPOSE_IP, UNKNOWN_IP)
  return hmacHex(PURPOSE_IP, `${IP_TAG}${ipv6Prefix(host) ?? host}`)
}

/**
 * HMAC-хеш User-Agent: 64 hex-символа в нижнем регистре.
 * Регистр и пробелы внутри строки сохраняем — в UA они значимы, и любая
 * «нормализация» здесь только склеивает разных клиентов в одного.
 *
 * @param {string|null|undefined} ua
 * @returns {string}
 */
export const hashUa = (ua) => {
  const value = String(ua ?? '').trim().slice(0, UA_MAX)
  if (!value) return hmacHex(PURPOSE_UA, UNKNOWN_UA)
  return hmacHex(PURPOSE_UA, `${UA_TAG}${value}`)
}
