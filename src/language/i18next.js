import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import Backend from "i18next-http-backend";
import LanguageDetector from 'i18next-browser-languagedetector';
import { LANGUAGES } from '../data/content';

// Коды берутся из того же списка, что рисует переключатель языков: раньше
// набор был перечислен здесь ещё раз, и язык, добавленный в меню, оказывался
// за пределами supportedLngs — то есть молча не загружался.
const Languages = LANGUAGES.map((language) => language.code)

i18n
  .use(Backend)
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    fallbackLng: 'ru',
    debug: false,
    // Было `whitelist` — опция удалена в i18next v21, из-за чего список языков
    // молча игнорировался и произвольное значение `lang` приводило к 404.
    supportedLngs: Languages,
    load: 'languageOnly',
    nonExplicitSupportedLngs: true,
    interpolation: {
      // Безопасно: React экранирует значения сам (рекомендация react-i18next).
      escapeValue: false,
    },
    react: {
      // Без Suspense-границы в дереве suspension при асинхронной загрузке
      // локали давал бы белый экран на медленной сети.
      useSuspense: false,
    },
    detection: {
      order: ["cookie", "localStorage", "navigator"],
      lookupCookie: "lang",
      lookupLocalStorage: "lang",
      caches: ["cookie", "localStorage"]
    }
  });

// Атрибуты lang/dir у <html> должны следовать за выбранным языком:
// без dir="rtl" арабская версия ломается визуально и семантически.
const RTL_LANGUAGES = new Set(["ar"]);

const syncDocumentLanguage = (language) => {
  const code = (language || "ru").slice(0, 2);
  document.documentElement.lang = code;
  document.documentElement.dir = RTL_LANGUAGES.has(code) ? "rtl" : "ltr";
};

syncDocumentLanguage(i18n.resolvedLanguage || i18n.language);
i18n.on("languageChanged", syncDocumentLanguage);

export default i18n;