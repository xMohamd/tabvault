import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { t } from '@/lib/i18n';
import { initTheme } from '@/lib/theme';
import '@/assets/globals.css';
import { App } from './App';

// Before React renders: theme and view class are on <html> before the first paint.
initTheme();
document.title = t('extName');

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
