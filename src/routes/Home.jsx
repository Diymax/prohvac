import { useEffect } from 'react'

import Header from '../components/Header'
import Hero from '../components/Hero'
import Advantages from '../components/Advantages'
import Stats from '../components/Stats'
import Projects from '../components/Projects'
import Partners from '../components/Partners'
import About from '../components/About'
import Contact from '../components/Contact'
import Footer from '../components/Footer'
import SnowCanvas from '../components/effects/SnowCanvas'
import ContentProvider from '../content/ContentProvider'
import useReveal from '../hooks/useReveal'
import useParallax from '../hooks/useParallax'
import { captureFirstTouch } from '../analytics/attribution.js'

const Home = () => {
  // Наблюдатели навешиваются один раз на всё дерево страницы.
  useReveal()
  useParallax()

  // First-touch запоминается здесь, а не в main.jsx: main — общая точка входа
  // и для админки, а метки визита к ней отношения не имеют. Вызов идемпотентен
  // (второй раз ничего не перезаписывает), поэтому двойной прогон эффекта
  // в React StrictMode безвреден.
  useEffect(() => {
    captureFirstTouch()
  }, [])

  // Провайдер контента стоит здесь, потому что данные нужны всей странице.
  // Если он понадобится и за её пределами, обёртку следует поднять в App.jsx —
  // но не держать в обоих местах: вложенные провайдеры сделают два одинаковых
  // запроса за одним и тем же ответом.
  return (
    <ContentProvider>
      <div className="pv-page">
        <div className="pv-blobs" aria-hidden="true">
          <span className="pv-blob pv-blob--1" />
          <span className="pv-blob pv-blob--2" />
          <span className="pv-blob pv-blob--3" />
        </div>

        <SnowCanvas />
        <Header />

        <main>
          <Hero />
          <Advantages />
          <Stats />
          <Projects />
          <Partners />
          <About />

          {/* Секция связи и подвал делят одну стеклянную панель: визуально это
              один блок, поэтому и общая обёртка одна. Подвал остаётся внутри
              main, роль contentinfo задана явно — вложенный footer её теряет. */}
          <div className="pv-outro">
            <Contact />
            <Footer />
          </div>
        </main>
      </div>
    </ContentProvider>
  )
}

export default Home
