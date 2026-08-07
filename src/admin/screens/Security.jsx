// Раздел «Безопасность»: второй фактор и смена пароля на одном экране.
//
// Оба действия защищают вход в одну и ту же учётную запись, и разносить их
// по двум пунктам меню значило прятать смену пароля в соседней вкладке, а
// раздел «Безопасность» оставлять наполовину пустым. Экран только ставит два
// самостоятельных блока друг под друга; вся логика остаётся в Setup2fa и
// ChangePassword — здесь нет ни одного собственного состояния.

import ChangePassword from './ChangePassword.jsx'
import Setup2fa from './Setup2fa.jsx'

const Security = ({ session, onDone }) => (
  <div className="adm-screen adm-screen--security">
    <Setup2fa session={session} onDone={onDone} />
    <ChangePassword session={session} onDone={onDone} />
  </div>
)

export default Security
