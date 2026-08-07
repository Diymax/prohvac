// Полоса заполнения хранилища медиа.
//
// ПОЧЕМУ ЭТО ВООБЩЕ ЕСТЬ НА ЭКРАНЕ. На тарифе хостинга 500 МБ под всё сразу:
// код, node_modules, SQLite и загруженные картинки. Кончившееся место — это
// не «загрузка не прошла», а отказ записи в базу в произвольном месте, поэтому
// заполненность обязана быть видна ДО того, как файл не влезет, а не в тексте
// ошибки после.
//
// Порог предупреждения зашит здесь, а не приходит с сервера: это свойство
// интерфейса («пора чистить»), а не данных.

import { formatBytes } from './format.js'

const WARN_RATIO = 0.8
const DANGER_RATIO = 0.95

const QuotaBar = ({ usedBytes = 0, quotaBytes = 0, count = null }) => {
  const used = Math.max(0, Number(usedBytes) || 0)
  const quota = Math.max(0, Number(quotaBytes) || 0)

  // Квота нулевая, пока не пришёл ответ сервера. Делить на неё нельзя,
  // а рисовать полосу «на 100%» тем более: пустая квота — это отсутствие
  // данных, а не переполненное хранилище.
  const ratio = quota > 0 ? Math.min(1, used / quota) : 0
  const percent = Math.round(ratio * 100)

  const level = ratio >= DANGER_RATIO ? 'danger' : ratio >= WARN_RATIO ? 'warn' : 'ok'

  return (
    <div className={`adm-quota adm-quota--${level}`}>
      <div
        className="adm-quota__bar"
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Заполнение хранилища медиа"
      >
        <div className="adm-quota__fill" style={{ width: `${percent}%` }} />
      </div>

      <div className="adm-quota__text">
        <strong>
          {formatBytes(used)} из {quota > 0 ? formatBytes(quota) : '—'}
        </strong>
        <span className="adm-muted">
          {' '}
          ({percent}%{count == null ? '' : `, файлов: ${count}`})
        </span>
        {level === 'danger' && (
          <span className="adm-quota__note"> Место почти кончилось — удалите лишние файлы</span>
        )}
        {level === 'warn' && (
          <span className="adm-quota__note"> Свободного места остаётся мало</span>
        )}
      </div>
    </div>
  )
}

export default QuotaBar
