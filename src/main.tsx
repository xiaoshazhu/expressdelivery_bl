import React from 'react';
import { createRoot } from 'react-dom/client';
import { lazy, Suspense } from 'react';
import Sidebar from './Sidebar';
import './style.css';
const Demo = lazy(() => import('./App'));
const demo = new URLSearchParams(window.location.search).get('demo') === '1';
createRoot(document.getElementById('root')!).render(<React.StrictMode><Suspense fallback={<p>正在加载…</p>}>{demo ? <Demo /> : <Sidebar />}</Suspense></React.StrictMode>);
