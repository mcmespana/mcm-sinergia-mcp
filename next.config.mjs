/** @type {import('next').NextConfig} */
const nextConfig = {
  // mysql2 se carga tal cual desde node_modules en vez de empaquetarlo.
  serverExternalPackages: ['mysql2'],
  // La guía de campos local (si la hay) se lee del disco en tiempo de ejecución.
  outputFileTracingIncludes: {
    '/api/mcp': ['./guia/CAMPOS-RESUMEN.md'],
  },
}

export default nextConfig
