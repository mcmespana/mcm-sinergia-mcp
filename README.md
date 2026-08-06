# MCP SinergiaCRM

Servidor **MCP remoto** (Streamable HTTP) en Next.js App Router, pensado para
desplegar en Vercel, que expone la **API V8 de SinergiaCRM** como herramientas
para modelos de lenguaje.

Las tools son genéricas: valen para cualquiera de los 50+ módulos de
SinergiaCRM, incluidos los custom (Subvenciones, Proyectos, Atenciones,
Valoraciones…).

> ⚠️ **SinergiaCRM va sobre SuiteCRM 7.x, no 8.x.** Los endpoints son
> `{SINERGIA_URL}/Api/V8/...` y `{SINERGIA_URL}/Api/access_token`, **sin** el
> prefijo `/legacy/`. Muchos ejemplos que circulan por internet usan
> `/legacy/Api/V8/` porque asumen SuiteCRM 8.x: aquí eso da 404.

---

## Índice

1. [Qué expone](#qué-expone)
2. [Crear el cliente OAuth2 en SinergiaCRM](#1-crear-el-cliente-oauth2-en-sinergiacrm)
3. [Crear el usuario API y su rol restringido](#2-crear-el-usuario-api-y-su-rol-restringido)
4. [Variables de entorno](#3-variables-de-entorno)
5. [Probar en local](#4-probar-en-local)
6. [Desplegar en Vercel](#5-desplegar-en-vercel)
7. [Conectar un cliente MCP](#6-conectar-un-cliente-mcp)
8. [Activar escritura](#7-activar-escritura)
9. [Detalles de implementación](#detalles-de-implementación)
10. [Resolución de problemas](#resolución-de-problemas)

---

## Qué expone

### Lectura (siempre disponible)

| Tool | Endpoint V8 | Para qué |
|------|-------------|----------|
| `get_available_modules` | `GET /Api/V8/meta/modules` | Módulos accesibles, con etiqueta y ACLs |
| `get_module_fields` | `GET /Api/V8/meta/fields/{module}` | Campos de un módulo (tipo, obligatorio, si es custom) |
| `get_entry` | `GET /Api/V8/module/{module}/{id}` | Un registro por id |
| `get_entry_list` | `GET /Api/V8/module/{module}` | Listado con filtros, orden y paginación |
| `get_relationships` | `GET /Api/V8/module/{module}/{id}/relationships/{rel}` | Registros relacionados |

### Escritura (solo con `ALLOW_WRITES=true`)

| Tool | Endpoint V8 |
|------|-------------|
| `create_entry` | `POST /Api/V8/module` |
| `update_entry` | `PATCH /Api/V8/module` |
| `set_relationship` | `POST /Api/V8/module/{module}/{id}/relationships/{rel}` |

### Borrado

**No existe.** No hay ninguna tool de borrado de registros ni de relaciones, y
no se va a añadir. Si algún día hace falta borrar algo, se hace desde el CRM.

### Filtros

Los filtros son **estructurados**, nunca SQL. El modelo envía:

```json
{
  "module": "Contacts",
  "filter": {
    "operator": "and",
    "conditions": [
      { "field": "last_name", "operator": "like", "value": "%García%" },
      { "field": "date_entered", "operator": "gte", "value": "2024-01-01" }
    ]
  },
  "sort": "-date_entered",
  "page": 1,
  "page_size": 20,
  "fields": ["name", "email1"]
}
```

y el servidor lo traduce a la query de la API V8:

```
/Api/V8/module/Contacts?fields[Contacts]=name,email1&filter[operator]=and
  &filter[last_name][like]=%García%&filter[date_entered][gte]=2024-01-01
  &sort=-date_entered&page[number]=1&page[size]=20
```

- Operadores de comparación: `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `like`.
- Operador lógico: `and` (por defecto) u `or`.
- Con `like` los comodines `%` los pone quien llama (`"%García%"`).
- Los nombres de módulo y campo se validan contra `^[A-Za-z][A-Za-z0-9_]{0,63}$`
  antes de salir a la red.
- `page_size` está topado a **50**.

---

## 1. Crear el cliente OAuth2 en SinergiaCRM

1. Entra en el CRM como administrador.
2. **Administración → OAuth2 Clients → Nuevo**.
3. Tipo de grant: **Password** (es el que usa este servidor por defecto).
4. Rellena un nombre reconocible, p.ej. `MCP Sinergia (solo lectura)`.
5. Guarda y copia el **Client ID** (un UUID) y el **Client Secret**.
   El secret solo se muestra al crearlo: guárdalo ya en un gestor de
   contraseñas.

Requisito del servidor (cosa de sistemas, se hace una vez): la API V8 necesita
las claves RSA en `Api/V8/OAuth2/` (`private.key` con permisos 600,
`public.key` con 644, propiedad del usuario del servidor web). Si no están, el
`/Api/access_token` devuelve error 500. En instalaciones gestionadas por
SinergiaTIC ya suelen venir configuradas.

> **Alternativa:** si prefieres `client_credentials`, crea el cliente con ese
> grant y deja `SINERGIA_USERNAME` y `SINERGIA_PASSWORD` vacíos; el servidor lo
> detecta solo. Es el grant que usan los
> [ejemplos oficiales de SinergiaTIC](https://github.com/SinergiaTIC/SinergiaCRM-API-Examples/tree/main/v8).
> Con `password` es más fácil auditar quién hizo qué, porque las acciones
> quedan a nombre del usuario API.

## 2. Crear el usuario API y su rol restringido

No uses tu usuario personal ni un administrador. Crea uno dedicado:

1. **Administración → Gestión de usuarios → Crear usuario nuevo**.
   - Nombre de usuario: `api.mcp` (o similar).
   - Tipo de usuario: **Usuario normal** (nunca administrador).
   - Marca el usuario como *no receptor de notificaciones* para no llenarle el
     correo.
   - Ponle una contraseña larga y aleatoria y guárdala en el gestor de
     contraseñas.
2. **Administración → Gestión de roles → Crear rol**, p.ej.
   `MCP - solo lectura`:
   - Para cada módulo al que quieras dar acceso: `Ver` = **Sí** (o *Todos*),
     `Listar` = **Sí**.
   - `Editar`, `Eliminar`, `Importar`, `Exportar`, `Acceso masivo a la
     actualización` = **No**.
   - Los módulos que no quieras exponer: `Acceso` = **Deshabilitado**.
3. Asigna el rol al usuario `api.mcp`.

El rol es la barrera de seguridad de verdad: aunque alguien active
`ALLOW_WRITES`, el CRM seguirá rechazando lo que el rol no permita. Cuando más
adelante quieras escritura, crea un segundo rol con `Editar = Sí` solo en los
módulos concretos que necesites.

> `get_available_modules` devuelve los ACLs efectivos del usuario API, así que
> es la forma rápida de comprobar que el rol quedó como querías.

## 3. Variables de entorno

Copia `.env.example` a `.env.local` y rellénalo:

```bash
cp .env.example .env.local
```

| Variable | Obligatoria | Descripción |
|----------|-------------|-------------|
| `SINERGIA_URL` | Sí | URL base de la instancia, **sin** `/Api` y **sin** `/legacy` |
| `SINERGIA_CLIENT_ID` | Sí | Client ID del cliente OAuth2 |
| `SINERGIA_CLIENT_SECRET` | Sí | Client Secret |
| `SINERGIA_USERNAME` | Con grant `password` | Usuario API dedicado |
| `SINERGIA_PASSWORD` | Con grant `password` | Su contraseña |
| `MCP_AUTH_SECRET` | Sí | Secreto que deben mandar los clientes MCP. `openssl rand -hex 32` |
| `ALLOW_WRITES` | No | `false` por defecto. `true` registra las tools de escritura |

Nunca se hardcodean credenciales en el código, y `.env*` está en `.gitignore`.

## 4. Probar en local

```bash
npm install
npm run test:auth   # login OAuth2 + listado de módulos, no escribe nada
npm run dev         # http://localhost:3000/api/mcp
```

`npm run test:auth` es el paso previo a cualquier despliegue: valida URL,
cliente OAuth2, usuario y permisos del rol, e imprime los primeros módulos
accesibles. Lee `.env.local` y `.env` automáticamente.

Comprobación rápida del endpoint MCP (debe dar `401` sin credenciales):

```bash
curl -i -X POST http://localhost:3000/api/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}'
```

Y con el secreto, para ver las tools registradas:

```bash
curl -s -X POST http://localhost:3000/api/mcp \
  -H "Authorization: Bearer $MCP_AUTH_SECRET" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
```

Otros comandos: `npm run typecheck`, `npm run build`.

## 5. Desplegar en Vercel

1. Importa el repositorio en Vercel. Next.js se detecta solo; no hace falta
   tocar el build.
2. **Settings → Environment Variables**: añade las siete variables de la tabla
   anterior (Production y, si la usas, Preview). Márcalas como *Sensitive*.
3. Despliega.
4. Tu endpoint MCP queda en `https://<tu-deploy>.vercel.app/api/mcp`.

Notas:

- Si la instancia de SinergiaCRM está detrás de VPN o con IPs filtradas, hay
  que permitir las IPs de salida de Vercel (o usar Vercel Secure Compute).
- El token OAuth se cachea en memoria del proceso, así que se reaprovecha
  mientras Vercel reutilice la instancia (Fluid compute). No se persiste en
  disco ni en ningún almacén externo.
- `maxDuration` del endpoint está en 60 s.
- Cada cambio de variable de entorno necesita un redeploy para aplicarse.

## 6. Conectar un cliente MCP

Clientes con soporte de Streamable HTTP y cabeceras:

```json
{
  "mcpServers": {
    "sinergiacrm": {
      "url": "https://<tu-deploy>.vercel.app/api/mcp",
      "headers": { "Authorization": "Bearer <MCP_AUTH_SECRET>" }
    }
  }
}
```

Claude Code:

```bash
claude mcp add --transport http sinergiacrm https://<tu-deploy>.vercel.app/api/mcp \
  --header "Authorization: Bearer <MCP_AUTH_SECRET>"
```

Clientes que solo hablan stdio, vía [`mcp-remote`](https://www.npmjs.com/package/mcp-remote):

```json
{
  "mcpServers": {
    "sinergiacrm": {
      "command": "npx",
      "args": [
        "-y", "mcp-remote",
        "https://<tu-deploy>.vercel.app/api/mcp",
        "--header", "Authorization: Bearer <MCP_AUTH_SECRET>"
      ]
    }
  }
}
```

## 7. Activar escritura

Arrancamos en solo lectura a propósito. Para habilitar escritura:

1. Revisa que el rol del usuario API tenga `Editar` **solo** en los módulos que
   toque. Si el rol es de solo lectura, activar el flag no sirve de nada (y es
   lo correcto: el CRM manda).
2. En Vercel, pon `ALLOW_WRITES=true`.
3. Redeploy.
4. Comprueba que `tools/list` ahora incluye `create_entry`, `update_entry` y
   `set_relationship`.

Con `ALLOW_WRITES=false` esas tools **ni siquiera se registran**: el modelo no
las ve, así que no puede ni intentar llamarlas.

Para volver a solo lectura: `ALLOW_WRITES=false` y redeploy.

---

## Detalles de implementación

```
app/
  api/mcp/route.ts       Endpoint MCP + comprobación del bearer de entrada
  page.tsx               Página informativa (sin datos del CRM)
lib/
  config.ts              Lectura y validación de variables de entorno
  mcp/auth.ts            Comparación en tiempo constante contra MCP_AUTH_SECRET
  mcp/tools.ts           Definición y registro de las tools (flag de escritura)
  sinergia/auth.ts       OAuth2: login, refresh y caché de token
  sinergia/client.ts     Cliente HTTP de la API V8, errores y reintento en 401
  sinergia/query.ts      Filtros estructurados, orden, paginación, validaciones
  sinergia/flatten.ts    Aplanado de JSON:API a respuestas compactas
  sinergia/operations.ts Operaciones de alto nivel usadas por las tools
scripts/test-auth.ts     Smoke test de credenciales
```

**Autenticación de entrada.** Antes de nada, el endpoint compara el header
`Authorization: Bearer …` con `MCP_AUTH_SECRET` usando `timingSafeEqual` sobre
los digests SHA-256 (tiempo constante y sin filtrar longitudes). Si no
coincide, o si `MCP_AUTH_SECRET` no está configurado, responde `401` sin llegar
a tocar el CRM.

**Autenticación de salida.** `POST /Api/access_token` con `grant_type=password`
y `Content-Type: application/vnd.api+json`. El token se guarda en una variable
a nivel de módulo con su fecha de expiración; se renueva 60 s antes de caducar
usando `grant_type=refresh_token` y, si el refresh falla, se hace login
completo. Las llamadas concurrentes comparten una sola petición de token. Si la
API responde `401`, se invalida el token y se reintenta la llamada una vez.

**Respuestas compactas.** Las respuestas JSON:API se aplanan antes de
devolverlas: `{id, module, ...atributos}`, se descartan los campos vacíos y el
`deleted=0`, se truncan los textos de más de 800 caracteres y el listado
devuelve solo `module`, `page`, `page_size`, `count`, `total_pages` y
`records`. Aun así, usa siempre `fields` cuando sepas qué campos necesitas.

**Referencias usadas.**

- [SuiteCRM V8 JSON:API](https://docs.suitecrm.com/developer/api/developer-setup-guide/json-api/)
- [SinergiaTIC/SinergiaCRM-API-Examples](https://github.com/SinergiaTIC/SinergiaCRM-API-Examples)
  (carpetas `v8` y `PortalOauth`) — referencia autorizada para esta instalación
- Código de `Api/V8` de SuiteCRM 7.x, para confirmar los operadores de filtro
  soportados (`Api\V8\JsonApi\Repository\Filter`)

## Resolución de problemas

| Síntoma | Causa probable |
|---------|----------------|
| `404` al pedir el token | `SINERGIA_URL` mal puesta, o has incluido `/legacy` o `/Api` en ella |
| `Respuesta no-JSON de …/Api/access_token` | La URL apunta a la interfaz web, no a la API; o la API V8 no está habilitada |
| `500` al pedir el token | Faltan o tienen mal los permisos las claves RSA de `Api/V8/OAuth2/` |
| `invalid_client` | Client ID/Secret mal, o el cliente OAuth2 tiene otro grant configurado |
| `invalid_credentials` | Usuario o contraseña del usuario API incorrectos, o usuario desactivado |
| Todas las peticiones MCP dan `401` | Falta `MCP_AUTH_SECRET` en el entorno, o el cliente manda otro valor |
| `Filter field X in Y module is not found` | El campo no existe en ese módulo: compruébalo con `get_module_fields` |
| No aparecen las tools de escritura | `ALLOW_WRITES` no es `true`, o falta el redeploy |
| Un módulo no aparece en `get_available_modules` | El rol del usuario API no le da acceso |
