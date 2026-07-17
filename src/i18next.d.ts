import 'i18next';
import type { defaultNS, resources } from './i18n/resources';

declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: typeof defaultNS;
    enableSelector: 'optimize';
    resources: typeof resources['en'];
    returnNull: false;
  }
}
