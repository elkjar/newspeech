import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../index.css';
import { BroadcastApp } from './BroadcastApp';

// BROADCAST entry (broadcast.html). No updater check — nothing may ever pop
// a prompt over a live stream.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BroadcastApp />
  </StrictMode>
);
