import React from 'react'
import ReactDOM from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
import { queryClient } from './lib/queryClient'
import App from './App.tsx'
import './index.css'
import { ConfigProvider } from './contexts/ConfigContext'
import { ThemeProvider } from './components/ThemeProvider'
import { installSigninRedirect } from './lib/signinRedirect'
import { installSheetSwipe } from './lib/phoneSheet'

installSigninRedirect()
installSheetSwipe()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <ConfigProvider>
          <App />
        </ConfigProvider>
      </ThemeProvider>
    </QueryClientProvider>
  </React.StrictMode>,
)
