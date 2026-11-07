import React from 'react';
import { createRoot } from 'react-dom/client';
import { SpacetimeDBProvider } from 'spacetimedb/react';
import { DbConnection } from './module_bindings';
import App from './App';
import './style.css';
const connectionBuilder = DbConnection.builder()
  .withUri(import.meta.env.VITE_SPACETIME_URI || 'ws://127.0.0.1:3000')
  .withDatabaseName(import.meta.env.VITE_SPACETIME_DATABASE || 'sentinel');
createRoot(document.getElementById('root')!).render(<React.StrictMode><SpacetimeDBProvider connectionBuilder={connectionBuilder}><App /></SpacetimeDBProvider></React.StrictMode>);
