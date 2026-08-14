import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
// Latin subsets only: Chinese text renders through the system font stack, so
// Inter merely covers Latin characters (the full subsets added ~1 MB).
import '@fontsource/inter/latin-400.css';
import '@fontsource/inter/latin-500.css';
import '@fontsource/inter/latin-600.css';
import '@fontsource/inter/latin-700.css';
import '@fontsource/inter/latin-800.css';
import App from './App';
import './index.css';
import './components/FloatLens.css';

if (window.location.hash.replace(/^#\/?/, '') === 'float') {
  document.documentElement.classList.add('float-lens-root');
  document.body.classList.add('float-lens-root');
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
