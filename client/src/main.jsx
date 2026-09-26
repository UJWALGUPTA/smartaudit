import React from 'react';
import { createRoot } from 'react-dom/client';
import AuditDashboard from './components/AuditDashboard.jsx';
import './styles.css';

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <AuditDashboard />
  </React.StrictMode>,
);
