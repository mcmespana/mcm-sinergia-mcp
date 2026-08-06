/** @type {import('next').NextConfig} */
const nextConfig = {
  // El handler MCP corre en Node (usa node:crypto y fetch con timeouts largos).
  serverExternalPackages: ['@modelcontextprotocol/server'],
}

export default nextConfig
