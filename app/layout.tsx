import type { Metadata, Viewport } from 'next'
import type { ReactNode } from 'react'

export const metadata: Metadata = {
  title: 'MCP SinergiaCRM',
  description: 'Servidor MCP remoto sobre la API V8 de SinergiaCRM',
  robots: { index: false, follow: false },
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="es">
      <body
        style={{
          margin: 0,
          padding: '3rem 1.5rem',
          fontFamily:
            'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
          lineHeight: 1.6,
        }}
      >
        {children}
      </body>
    </html>
  )
}
