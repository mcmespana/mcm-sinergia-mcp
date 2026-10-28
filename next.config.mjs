/** @type {import('next').NextConfig} */
const nextConfig = {
  // mysql2 se carga tal cual desde node_modules en vez de empaquetarlo.
  serverExternalPackages: ['mysql2'],
}

export default nextConfig
