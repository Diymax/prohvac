// Минимальный кодировщик QR: байтовый режим, уровень коррекции M.
//
// ПОЧЕМУ СВОЙ, А НЕ БИБЛИОТЕКА. Готовые пакеты рисуют код одним из двух
// способов: возвращают строку <svg>...</svg> под dangerouslySetInnerHTML либо
// canvas.toDataURL(). Первое — вставка размеченного HTML из чужого кода,
// второе требует data: в img-src. Наш CSP (server/http/spa.js) держит
// script-src без 'unsafe-inline', и ослаблять политику ради картинки, которую
// можно построить из полутора сотен строк арифметики, — плохой обмен.
// Отсюда же формат результата: не строка и не URL, а матрица модулей.
// Компонент превращает её в настоящие DOM-узлы (React), а не в разметку.
//
// ГРАНИЦЫ РЕАЛИЗАЦИИ. Только то, что нужно для otpauth-ссылки:
//   - режим один, байтовый (в ссылке есть строчные буквы, значит
//     алфавитно-цифровой режим неприменим);
//   - уровень коррекции один, M (~15% — стандартный выбор для экрана);
//   - версии 1..10.
// Верхняя граница именно 10, а не 6: боевая ссылка вида
// otpauth://totp/PROHVAC:admin?secret=<32 символа>&issuer=PROHVAC&algorithm=SHA1
// &digits=6&period=30 — это ~117 байт, а версия 6 на уровне M вмещает 106.
// То есть на шести версиях привязка второго фактора просто не нарисовалась бы.
// Версия 10-M вмещает 213 байт: хватает и на длинный логин (до 32 символов).
//
// Соответствие ISO/IEC 18004. Порядок шагов канонический: кодирование данных →
// блоки Рида — Соломона → чередование → размещение по зигзагу → выбор маски
// по штрафам → информация о формате и версии.

// Наибольшая поддерживаемая версия. Прибавлять новые — это дописать строку
// в VERSIONS: остальные таблицы (выравнивание, ёмкость) считаются формулами.
const MAX_VERSION = 10

// Уровень коррекции M. Два бита в информации о формате — 0b00 (см. таблицу 12
// стандарта). Константа существует, чтобы это число не выглядело случайным.
const EC_FORMAT_BITS = 0b00

// Байтовый режим: индикатор 0100 и счётчик символов в 8 бит для версий 1..9,
// в 16 бит начиная с версии 10.
const MODE_BYTE = 0b0100
const countBits = (version) => (version < 10 ? 8 : 16)

// Байты-заполнители после терминатора, чередуются (стандарт, 7.4.10).
const PAD_BYTES = [0xec, 0x11]

// Структура блоков коррекции для уровня M: сколько байт коррекции на блок
// и как данные делятся на группы [количество блоков, байт данных в блоке].
// Числа взяты из таблицы 9 стандарта и проверяются суммой: общее число
// кодовых слов версии = данные + ec * число блоков.
const VERSIONS = [
  { ec: 10, groups: [[1, 16]] },
  { ec: 16, groups: [[1, 28]] },
  { ec: 26, groups: [[1, 44]] },
  { ec: 18, groups: [[2, 32]] },
  { ec: 24, groups: [[2, 43]] },
  { ec: 16, groups: [[4, 27]] },
  { ec: 18, groups: [[4, 31]] },
  { ec: 22, groups: [[2, 38], [2, 39]] },
  { ec: 22, groups: [[3, 36], [2, 37]] },
  { ec: 26, groups: [[4, 43], [1, 44]] },
]

// ---------------------------------------------------------------------------
// Арифметика GF(256)
// ---------------------------------------------------------------------------

// Поле строится по образующему многочлену 0x11d — тому самому, что задан
// стандартом. Таблицы логарифмов считаются один раз при загрузке модуля:
// умножение в поле сводится к сложению показателей.
const GF_EXP = new Uint8Array(512)
const GF_LOG = new Uint8Array(256)

{
  let value = 1
  for (let i = 0; i < 255; i += 1) {
    GF_EXP[i] = value
    GF_LOG[value] = i
    value <<= 1
    if (value & 0x100) value ^= 0x11d
  }
  // Второй период таблицы избавляет умножение от взятия остатка по 255.
  for (let i = 255; i < 512; i += 1) GF_EXP[i] = GF_EXP[i - 255]
}

const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : GF_EXP[GF_LOG[a] + GF_LOG[b]])

/** Порождающий многочлен степени degree: произведение (x - a^i). */
const generatorPoly = (degree) => {
  let poly = [1]
  for (let i = 0; i < degree; i += 1) {
    const next = new Array(poly.length + 1).fill(0)
    for (let j = 0; j < poly.length; j += 1) {
      next[j] ^= poly[j]
      next[j + 1] ^= gfMul(poly[j], GF_EXP[i])
    }
    poly = next
  }
  return poly
}

/** Байты коррекции блока — остаток от деления на порождающий многочлен. */
const errorCorrection = (data, ecLength) => {
  const gen = generatorPoly(ecLength)
  const buffer = new Uint8Array(data.length + ecLength)
  buffer.set(data)

  for (let i = 0; i < data.length; i += 1) {
    const factor = buffer[i]
    if (factor === 0) continue
    // gen[0] всегда 1, поэтому старший разряд обнуляется сам.
    for (let j = 0; j < gen.length; j += 1) {
      buffer[i + j] ^= gfMul(gen[j], factor)
    }
  }

  return buffer.slice(data.length)
}

// ---------------------------------------------------------------------------
// Данные
// ---------------------------------------------------------------------------

const dataCapacity = (version) =>
  VERSIONS[version - 1].groups.reduce((sum, [count, size]) => sum + count * size, 0)

/** Наименьшая версия, в которую влезают length байт данных. */
const pickVersion = (length) => {
  for (let version = 1; version <= MAX_VERSION; version += 1) {
    const bits = 4 + countBits(version) + length * 8
    if (bits <= dataCapacity(version) * 8) return version
  }
  return 0
}

/** Поток данных версии: заголовок, байты, терминатор, заполнители. */
const buildDataCodewords = (bytes, version) => {
  const total = dataCapacity(version)
  const out = new Uint8Array(total)
  let bitPos = 0

  const push = (value, width) => {
    for (let i = width - 1; i >= 0; i -= 1) {
      const bit = (value >>> i) & 1
      if (bit) out[bitPos >>> 3] |= 0x80 >>> (bitPos & 7)
      bitPos += 1
    }
  }

  push(MODE_BYTE, 4)
  push(bytes.length, countBits(version))
  for (const byte of bytes) push(byte, 8)

  // Терминатор — до четырёх нулей, но не больше, чем осталось места.
  push(0, Math.min(4, total * 8 - bitPos))
  // Дополнение до границы байта: незаписанные биты уже нули.
  bitPos = (bitPos + 7) & ~7

  for (let i = bitPos >>> 3, pad = 0; i < total; i += 1, pad += 1) {
    out[i] = PAD_BYTES[pad % PAD_BYTES.length]
  }

  return out
}

/**
 * Чередование блоков. Данные и коррекция в потоке идут не блоками подряд,
 * а по одному байту из каждого блока: так царапина на коде повреждает
 * понемногу в каждом блоке, а не убивает один целиком.
 */
const interleave = (dataCodewords, version) => {
  const { ec, groups } = VERSIONS[version - 1]

  const blocks = []
  let offset = 0
  for (const [count, size] of groups) {
    for (let i = 0; i < count; i += 1) {
      const data = dataCodewords.subarray(offset, offset + size)
      offset += size
      blocks.push({ data, ec: errorCorrection(data, ec) })
    }
  }

  const result = new Uint8Array(dataCodewords.length + ec * blocks.length)
  let pos = 0

  const longest = Math.max(...blocks.map((block) => block.data.length))
  for (let i = 0; i < longest; i += 1) {
    for (const block of blocks) {
      if (i < block.data.length) result[pos++] = block.data[i]
    }
  }
  for (let i = 0; i < ec; i += 1) {
    for (const block of blocks) result[pos++] = block.ec[i]
  }

  return result
}

// ---------------------------------------------------------------------------
// Матрица
// ---------------------------------------------------------------------------

const sizeOf = (version) => version * 4 + 17

/**
 * Центры совмещающих узоров. Формула из стандарта: первый всегда на 6,
 * последний — на size - 7, промежуточные равномерно с чётным шагом.
 */
const alignmentCenters = (version) => {
  if (version === 1) return []

  const count = Math.floor(version / 7) + 2
  const step = Math.floor((version * 4 + count * 2 + 1) / (count * 2 - 2)) * 2

  const centers = []
  for (let pos = sizeOf(version) - 7; centers.length < count - 1; pos -= step) {
    centers.unshift(pos)
  }
  centers.unshift(6)
  return centers
}

const createMatrix = (size) => {
  const modules = new Uint8Array(size * size)
  // Отдельная карта служебных модулей: маска накладывается только на данные,
  // а без этой карты «тёмный служебный» и «тёмный из данных» неразличимы.
  const reserved = new Uint8Array(size * size)
  return { size, modules, reserved }
}

const setFunction = (grid, row, col, dark) => {
  if (row < 0 || col < 0 || row >= grid.size || col >= grid.size) return
  grid.modules[row * grid.size + col] = dark ? 1 : 0
  grid.reserved[row * grid.size + col] = 1
}

/** Поисковые узоры по трём углам вместе с разделителями вокруг них. */
const drawFinder = (grid, row, col) => {
  for (let dy = -4; dy <= 4; dy += 1) {
    for (let dx = -4; dx <= 4; dx += 1) {
      const dist = Math.max(Math.abs(dx), Math.abs(dy))
      // dist === 2 — белое кольцо внутри узора, dist === 4 — разделитель.
      setFunction(grid, row + dy, col + dx, dist !== 2 && dist !== 4)
    }
  }
}

const drawAlignment = (grid, row, col) => {
  for (let dy = -2; dy <= 2; dy += 1) {
    for (let dx = -2; dx <= 2; dx += 1) {
      setFunction(grid, row + dy, col + dx, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)
    }
  }
}

/** Служебные узоры и резерв под информацию о формате и версии. */
const drawFunctionPatterns = (grid, version) => {
  const { size } = grid

  for (let i = 0; i < size; i += 1) {
    // Синхронизирующие полосы: чередование по шестой строке и шестому столбцу.
    setFunction(grid, 6, i, i % 2 === 0)
    setFunction(grid, i, 6, i % 2 === 0)
  }

  drawFinder(grid, 3, 3)
  drawFinder(grid, 3, size - 4)
  drawFinder(grid, size - 4, 3)

  const centers = alignmentCenters(version)
  for (let i = 0; i < centers.length; i += 1) {
    for (let j = 0; j < centers.length; j += 1) {
      // Три угловых центра заняты поисковыми узорами.
      const corner =
        (i === 0 && j === 0) ||
        (i === 0 && j === centers.length - 1) ||
        (i === centers.length - 1 && j === 0)
      if (!corner) drawAlignment(grid, centers[i], centers[j])
    }
  }

  // Место под информацию о формате занимаем тем же кодом, который её потом
  // и запишет, только с фиктивной маской. Иначе пришлось бы дублировать
  // список из пятнадцати позиций «просто чтобы зарезервировать», а он
  // неочевиден: две из них выпадают на синхрополосы и в него не входят.
  // Настоящее значение ляжет сюда после выбора маски.
  drawFormat(grid, 0)

  if (version >= 7) {
    // Информация о версии: два блока 3x6 у левого нижнего и правого верхнего
    // поисковых узоров. Значение не зависит от маски, пишем сразу.
    let rem = version
    for (let i = 0; i < 12; i += 1) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25)
    const bits = (version << 12) | rem

    for (let i = 0; i < 18; i += 1) {
      const bit = ((bits >>> i) & 1) === 1
      const a = size - 11 + (i % 3)
      const b = Math.floor(i / 3)
      setFunction(grid, b, a, bit)
      setFunction(grid, a, b, bit)
    }
  }
}

/** Зигзаг снизу вверх парами столбцов справа налево (стандарт, 7.7.3). */
const placeData = (grid, codewords) => {
  const { size } = grid
  const totalBits = codewords.length * 8
  let bit = 0

  for (let right = size - 1; right >= 1; right -= 2) {
    // Шестой столбец занят синхрополосой и в зигзаге не участвует.
    if (right === 6) right = 5

    for (let vertical = 0; vertical < size; vertical += 1) {
      for (let j = 0; j < 2; j += 1) {
        const col = right - j
        const upward = ((right + 1) & 2) === 0
        const row = upward ? size - 1 - vertical : vertical
        if (grid.reserved[row * size + col]) continue

        // Хвостовые модули (остаточные биты версии) остаются светлыми:
        // данных на них нет, но маска на них накладывается как на данные.
        let dark = 0
        if (bit < totalBits) dark = (codewords[bit >>> 3] >>> (7 - (bit & 7))) & 1
        grid.modules[row * size + col] = dark
        bit += 1
      }
    }
  }
}

// Восемь масок стандарта. Маска инвертирует модуль там, где условие истинно:
// без неё в коде появляются сплошные поля и ложные поисковые узоры.
const MASKS = [
  (row, col) => (row + col) % 2 === 0,
  (row) => row % 2 === 0,
  (row, col) => col % 3 === 0,
  (row, col) => (row + col) % 3 === 0,
  (row, col) => (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0,
  (row, col) => ((row * col) % 2) + ((row * col) % 3) === 0,
  (row, col) => (((row * col) % 2) + ((row * col) % 3)) % 2 === 0,
  (row, col) => (((row + col) % 2) + ((row * col) % 3)) % 2 === 0,
]

const applyMask = (grid, maskIndex) => {
  const mask = MASKS[maskIndex]
  for (let row = 0; row < grid.size; row += 1) {
    for (let col = 0; col < grid.size; col += 1) {
      const index = row * grid.size + col
      if (grid.reserved[index]) continue
      if (mask(row, col)) grid.modules[index] ^= 1
    }
  }
}

/** Информация о формате: уровень коррекции и номер маски, код BCH(15,5). */
const drawFormat = (grid, maskIndex) => {
  const { size } = grid
  const data = (EC_FORMAT_BITS << 3) | maskIndex

  let rem = data
  for (let i = 0; i < 10; i += 1) rem = (rem << 1) ^ ((rem >>> 9) * 0x537)
  // XOR с 0x5412 не даёт всей строке оказаться нулевой.
  const bits = ((data << 10) | rem) ^ 0x5412
  const bitAt = (i) => ((bits >>> i) & 1) === 1

  for (let i = 0; i <= 5; i += 1) setFunction(grid, i, 8, bitAt(i))
  setFunction(grid, 7, 8, bitAt(6))
  setFunction(grid, 8, 8, bitAt(7))
  setFunction(grid, 8, 7, bitAt(8))
  for (let i = 9; i < 15; i += 1) setFunction(grid, 8, 14 - i, bitAt(i))

  // Вторая копия: та же строка бит вдоль другого края. Одна из двух должна
  // читаться даже при повреждении угла.
  for (let i = 0; i < 8; i += 1) setFunction(grid, 8, size - 1 - i, bitAt(i))
  for (let i = 8; i < 15; i += 1) setFunction(grid, size - 15 + i, 8, bitAt(i))
  setFunction(grid, size - 8, 8, true)
}

// ---------------------------------------------------------------------------
// Выбор маски
// ---------------------------------------------------------------------------

// Штрафы из таблицы 11 стандарта.
const PENALTY_RUN = 3
const PENALTY_BLOCK = 3
const PENALTY_PATTERN = 40
const PENALTY_BALANCE = 10

const FINDER_LIKE = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0]

const matchesAt = (line, start, pattern, reverse) => {
  for (let i = 0; i < pattern.length; i += 1) {
    const expected = reverse ? pattern[pattern.length - 1 - i] : pattern[i]
    if (line[start + i] !== expected) return false
  }
  return true
}

const linePenalty = (line) => {
  let score = 0

  let runLength = 1
  for (let i = 1; i <= line.length; i += 1) {
    if (i < line.length && line[i] === line[i - 1]) {
      runLength += 1
      continue
    }
    // Правило 1: пять и больше одинаковых модулей подряд.
    if (runLength >= 5) score += PENALTY_RUN + (runLength - 5)
    runLength = 1
  }

  // Правило 3: последовательность, которую сканер принимает за поисковый узор.
  for (let i = 0; i + FINDER_LIKE.length <= line.length; i += 1) {
    if (matchesAt(line, i, FINDER_LIKE, false)) score += PENALTY_PATTERN
    if (matchesAt(line, i, FINDER_LIKE, true)) score += PENALTY_PATTERN
  }

  return score
}

const penalty = (grid) => {
  const { size, modules } = grid
  let score = 0
  let dark = 0

  const row = new Uint8Array(size)
  const col = new Uint8Array(size)

  for (let i = 0; i < size; i += 1) {
    for (let j = 0; j < size; j += 1) {
      row[j] = modules[i * size + j]
      col[j] = modules[j * size + i]
      dark += row[j]
    }
    score += linePenalty(row) + linePenalty(col)
  }

  // Правило 2: одноцветные квадраты 2x2.
  for (let i = 0; i + 1 < size; i += 1) {
    for (let j = 0; j + 1 < size; j += 1) {
      const value = modules[i * size + j]
      if (
        value === modules[i * size + j + 1] &&
        value === modules[(i + 1) * size + j] &&
        value === modules[(i + 1) * size + j + 1]
      ) {
        score += PENALTY_BLOCK
      }
    }
  }

  // Правило 4: перекос доли тёмных модулей относительно половины.
  const ratio = (dark * 100) / (size * size)
  score += Math.floor(Math.abs(ratio - 50) / 5) * PENALTY_BALANCE

  return score
}

// ---------------------------------------------------------------------------
// Публичный интерфейс
// ---------------------------------------------------------------------------

/**
 * Строит матрицу QR для строки.
 *
 * @param {string} text содержимое кода (для нас — otpauth-ссылка)
 * @returns {{size: number, version: number, mask: number, modules: Uint8Array}}
 *   modules — size*size байт, 1 — тёмный модуль. Зона тишины НЕ включена:
 *   её добавляет отрисовка, потому что она зависит от того, куда рисуем.
 * @throws {RangeError} если строка не помещается в поддерживаемые версии
 */
export const encodeQr = (text) => {
  const bytes = new TextEncoder().encode(String(text ?? ''))
  if (bytes.length === 0) throw new RangeError('qr: пустая строка')

  const version = pickVersion(bytes.length)
  if (!version) {
    throw new RangeError(
      `qr: ${bytes.length} байт не помещается в версию ${MAX_VERSION} (уровень M)`
    )
  }

  const codewords = interleave(buildDataCodewords(bytes, version), version)
  const size = sizeOf(version)

  const base = createMatrix(size)
  drawFunctionPatterns(base, version)
  placeData(base, codewords)

  // Маску выбираем перебором всех восьми: стандарт требует минимального
  // штрафа, а считать его дешевле, чем ловить потом код, который не читается
  // конкретной моделью телефона.
  let best = null
  for (let maskIndex = 0; maskIndex < MASKS.length; maskIndex += 1) {
    const candidate = {
      size,
      modules: base.modules.slice(),
      reserved: base.reserved,
    }
    applyMask(candidate, maskIndex)
    drawFormat(candidate, maskIndex)

    const score = penalty(candidate)
    if (!best || score < best.score) best = { score, maskIndex, modules: candidate.modules }
  }

  return { size, version, mask: best.maskIndex, modules: best.modules }
}

/**
 * Матрица в виде атрибута d для одного <path>.
 *
 * Один путь вместо тысячи <rect>: у версии 10 матрица 57x57, то есть под три
 * тысячи модулей, и столько DOM-узлов React будет создавать заметно дольше,
 * чем строку. Строка при этом попадает в АТРИБУТ элемента, а не в разметку, —
 * никакого dangerouslySetInnerHTML.
 *
 * @param {{size: number, modules: Uint8Array}} qr результат encodeQr
 * @param {number} [quiet] зона тишины в модулях; меньше 4 стандарт не допускает
 * @returns {string}
 */
export const qrPath = ({ size, modules }, quiet = 4) => {
  const parts = []

  for (let row = 0; row < size; row += 1) {
    let col = 0
    while (col < size) {
      if (!modules[row * size + col]) {
        col += 1
        continue
      }
      // Соседние тёмные модули строки сливаем в один прямоугольник:
      // путь становится в разы короче без изменения картинки.
      let run = 1
      while (col + run < size && modules[row * size + col + run]) run += 1
      parts.push(`M${col + quiet} ${row + quiet}h${run}v1h-${run}z`)
      col += run
    }
  }

  return parts.join('')
}

/** Сторона холста в модулях вместе с зоной тишины. */
export const qrCanvasSize = (size, quiet = 4) => size + quiet * 2
