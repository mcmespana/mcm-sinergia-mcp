import { writesAllowed } from '@/lib/config'

export const dynamic = 'force-dynamic'

export default function HomePage() {
  const escritura = writesAllowed()

  return (
    <main style={{ maxWidth: '42rem', margin: '0 auto' }}>
      <h1 style={{ marginBottom: '0.25rem' }}>MCP SinergiaCRM</h1>
      <p style={{ marginTop: 0, color: '#666' }}>
        Servidor MCP remoto (Streamable HTTP) sobre la API V8 de SinergiaCRM.
      </p>

      <ul>
        <li>
          Endpoint MCP: <code>/api/mcp</code>
        </li>
        <li>
          Autenticación: header <code>Authorization: Bearer &lt;MCP_AUTH_SECRET&gt;</code>
        </li>
        <li>
          Escritura: <strong>{escritura ? 'activada' : 'desactivada'}</strong> (
          <code>ALLOW_WRITES</code>)
        </li>
        <li>Borrado: no implementado.</li>
      </ul>

      <p style={{ color: '#666', fontSize: '0.9rem' }}>
        Esta página no expone datos del CRM. Consulta el README para la configuración.
      </p>
    </main>
  )
}
