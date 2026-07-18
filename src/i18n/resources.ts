import en from "./catalogs/en";
import fa from "./catalogs/fa";
import he from "./catalogs/he";
import ru from "./catalogs/ru";
import uk from "./catalogs/uk";
import zhCN from "./catalogs/zh-CN";

export const defaultNS = "common" as const;

export const resources = {
  en: { common: en },
  "zh-CN": { common: zhCN },
  fa: { common: fa },
  he: { common: he },
  uk: { common: uk },
  ru: { common: ru },
} as const;
