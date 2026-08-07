// Точка подключения админки к приложению.
//
// Отдельный файл нужен, чтобы React.lazy() вырезал в самостоятельный чанк
// ВСЮ панель целиком — вместе с экранами и стилями. Если бы AdminApp
// импортировался напрямую в App.jsx, её код уехал бы в основной бандл
// лендинга: посетитель сайта качал бы админку, а её наличие было бы видно
// в исходниках страницы.

import AdminApp from './admin/AdminApp.jsx'
import screens from './admin/screens/index.js'

const AdminEntry = () => <AdminApp screens={screens} />

export default AdminEntry
