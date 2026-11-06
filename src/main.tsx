import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { installNetworkGuard } from './net/network-guard'
import { privacyNetworkFromSearch } from './rpc/networks'

// Payment-only services are blocked in the agent entry, even if an accidental
// dependency tries to contact them. Moving between entries reloads this policy.
const entry = new URLSearchParams(window.location.search).get('view')
installNetworkGuard({ paymentServices: entry !== 'agents', marketData: entry === 'agents',
  privacyNetwork: privacyNetworkFromSearch(window.location.search) })

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
