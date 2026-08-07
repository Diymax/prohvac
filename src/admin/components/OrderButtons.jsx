// Перемещение элемента списка на шаг вверх или вниз.
//
// ПОЧЕМУ КНОПКИ, А НЕ ПЕРЕТАСКИВАНИЕ. Drag-and-drop без библиотеки — это
// ручная работа с pointer-событиями, автопрокруткой и доступностью с
// клавиатуры; с библиотекой — лишняя зависимость в бандле ради перестановки
// шести карточек. Кнопки работают на телефоне, читаются скринридером и не
// ломаются при прокрутке страницы.
//
// Порядок на сервер уходит списком целиком (POST .../reorder {ids}), поэтому
// компонент сообщает только направление, а сборкой нового порядка занимается
// экран: он один знает полный список.

const OrderButtons = ({ onUp, onDown, canUp = true, canDown = true, disabled = false }) => (
  <span className="adm-order">
    <button
      type="button"
      className="adm-btn adm-btn--icon"
      onClick={onUp}
      disabled={disabled || !canUp}
      title="Выше"
      aria-label="Переместить выше"
    >
      ↑
    </button>
    <button
      type="button"
      className="adm-btn adm-btn--icon"
      onClick={onDown}
      disabled={disabled || !canDown}
      title="Ниже"
      aria-label="Переместить ниже"
    >
      ↓
    </button>
  </span>
)

export default OrderButtons
