import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './index.css'
// i18n инициализируется здесь явно, а не побочным эффектом импорта в компоненте.
import './language/i18next.js'

ReactDOM.createRoot(document.getElementById('root')).render(<App />)
