import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { installNetworkGuard } from './net/network-guard.ts'
import { privacyNetworkFromSearch } from './rpc/networks.ts'
installNetworkGuard({ privacyNetwork: privacyNetworkFromSearch(window.location.search) })
createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)
