import React from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.jsx';
import './style.css';
const root=document.getElementById('root');
if(!root)throw new Error('Elemento root nao encontrado');
createRoot(root).render(<App/>);
