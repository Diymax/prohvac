// Разделы админки в том виде, в каком их ждёт AdminApp: id совпадает с хешем
// маршрута (#/content — раздел 'content'), Component — сам экран.
//
// Собраны в отдельный файл, а не перечислены в AdminApp: каркас не должен
// знать про конкретные разделы, иначе каждый новый экран требовал бы правки
// корня приложения.

import Analytics from './Analytics.jsx'
import Content from './Content.jsx'
import Entities from './Entities.jsx'
import Leads from './Leads.jsx'
import Media from './Media.jsx'
import Overview from './Overview.jsx'
import Settings from './Settings.jsx'
import Users from './Users.jsx'

const screens = [
  { id: 'overview', title: 'Обзор', Component: Overview },
  { id: 'content', title: 'Тексты', Component: Content },
  { id: 'entities', title: 'Каталоги', Component: Entities },
  { id: 'media', title: 'Медиа', Component: Media },
  { id: 'leads', title: 'Заявки', Component: Leads },
  { id: 'analytics', title: 'Аналитика', Component: Analytics },
  { id: 'settings', title: 'Настройки', Component: Settings },
  { id: 'users', title: 'Пользователи', Component: Users },
]

export default screens
