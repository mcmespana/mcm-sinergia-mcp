/**
 * Smoke test de la documentación: comprueba que desde esta máquina se llega a
 * la wiki de SinergiaTIC, que se leen los índices y que la búsqueda funciona.
 *
 *   npm run test:docs
 *   npm run test:docs -- "recuperar registros borrados"
 */

import { checkDocsHealth, getCorpus, searchCorpus } from '../lib/wiki/manual'

async function main() {
  const health = await checkDocsHealth()
  console.log(JSON.stringify(health, null, 2))
  if (!health.ok) process.exit(1)

  const started = Date.now()
  const { value: corpus } = await getCorpus()
  const docs = corpus.docs
  console.log(`\nManuales descargados: ${docs.length} páginas en ${Date.now() - started} ms`)
  if (corpus.failed.length > 0) console.log(`No descargadas: ${corpus.failed.join(', ')}`)

  const query = process.argv[2] ?? 'recuperar registros eliminados'
  console.log(`\nBúsqueda: "${query}"`)
  for (const hit of searchCorpus(docs, query, 5)) {
    console.log(`- [${hit.puntuacion}] ${hit.pagina} › ${hit.seccion}\n  ${hit.url}`)
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
