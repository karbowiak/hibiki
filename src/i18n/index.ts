import { sqliteLocalStorage } from "../storage/clientStorage"
import i18n from "i18next"
import { initReactI18next } from "react-i18next"
import en from "./locales/en.json"

const STORAGE_KEY = "plex-language-v1"

function getSavedLanguage(): string {
  try {
    return sqliteLocalStorage.getItem(STORAGE_KEY) ?? "en"
  } catch {
    return "en"
  }
}

export function setLanguage(lng: string): void {
  void i18n.changeLanguage(lng)
  try {
    sqliteLocalStorage.setItem(STORAGE_KEY, lng)
  } catch {}
}

export function getLanguage(): string {
  return i18n.language ?? "en"
}

void i18n
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
    },
    lng: getSavedLanguage(),
    fallbackLng: "en",
    interpolation: {
      escapeValue: false,
    },
  })

export default i18n
