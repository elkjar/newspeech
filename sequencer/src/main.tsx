import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import { App } from './App';
import { StreamWindow } from './StreamWindow';

const params = new URLSearchParams(window.location.search);
const isStreamWindow = params.get('window') === 'stream';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isStreamWindow ? <StreamWindow /> : <App />}
  </StrictMode>
);
