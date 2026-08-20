# MCP SinergiaCRM

Servidor **MCP remoto** (Streamable HTTP), en Next.js, que expone la **API V8
de SinergiaCRM (SuiteCRM 7.x)** como herramientas para agentes de IA (Claude,
ChatGPT, o cualquier otro cliente compatible con el protocolo MCP).

Las herramientas son genéricas: valen para cualquier módulo del CRM, incluidos los
custom (Contactos, Proyectos, Atenciones, Valoraciones…), sin tocar código.

> ⚠️ **SinergiaCRM va sobre SuiteCRM 7.x, no 8.x.** 
---

## Índice

1. [Qué expone](#qué-expone)
2. [Configurar SinergiaCRM](#1-configurar-sinergiacrm)
3. [Variables de entorno](#2-variables-de-entorno)
4. [Probar en local](#3-probar-en-local)
5. [Desplegar en Vercel](#4-desplegar-en-vercel)
6. [Conectar tu agente de IA](#5-conectar-tu-agente-de-ia)
7. [Activar escritura](#6-activar-escritura)
8. [Cómo está hecho por dentro](#cómo-está-hecho-por-dentro)
9. [Problemas frecuentes](#problemas-frecuentes)

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

### Escritura (solo con variable de entorno `ALLOW_WRITES=true`, ver [más abajo](#6-activar-escritura))

| Tool | Endpoint V8 |
|------|-------------|
| `create_entry` | `POST /Api/V8/module` |
| `update_entry` | `PATCH /Api/V8/module` |
| `set_relationship` | `POST /Api/V8/module/{module}/{id}/relationships/{rel}` |

### Borrado

No existe ninguna tool de borrado, no hay tanta necesidad de arriesgar a que un agente se ponga a borrar cositas :)

### Filtros

Los filtros son estructurados. El modelo envía algo así:

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

y el servidor lo traduce a la query real de la API V8. Operadores admitidos:
`eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `like` (comparación) y `and`/`or`
(lógico). Nombres de módulo y campo se validan contra
`^[A-Za-z][A-Za-z0-9_]{0,63}$` antes de salir a la red, y `page_size` está
topado a **50** para no reventar el contexto del modelo.

---

## 1. Configurar SinergiaCRM

### 1.1 Cliente OAuth2

1. Entra al CRM como administrador.
2. **Administración → Clientes y Tokens OAuth2 → Nuevo cliente de
   contraseña**.
3. En **"cambiar la clave"** pega un secreto largo e inventado (no una
   contraseña que uses en otro sitio). Puedes generarlo con
   `openssl rand -hex 32` o con un generador
   web como [este](https://numbergenerator.org/random-64-digit-hex-codes-generator).
   Guárdalo: será tu variable de entorno `SINERGIA_CLIENT_SECRET`.
4. Marca la casilla **"Es confidencial"**.
5. Guarda. En el resgistro del CRM (o en la URL del registro) aparece el campo
   **"ID"**: ese valor es tu `SINERGIA_CLIENT_ID`.
   El **nombre** que has puesto antes es el nombre del registro es solo para identificarlo a simple vista, no
   se usa para nada más.

Requisito de sistemas (se hace una vez por instalación): la API V8 necesita
las claves RSA en `Api/V8/OAuth2/` (`private.key` en 600, `public.key` en
644). Si faltan, `/Api/access_token` responde `500`. 
(no parece un problema en SinergiaCRM)

### 1.2 Usuario API dedicado y rol restringido

Puedes crear un usuario dedicado en el CRM y asignarle el rol que consideres

1. **Administración → Gestión de usuarios → Crear usuario nuevo**: tipo
   *Usuario normal* (nunca administrador), con una contraseña larga y
   aleatoria guardada en un gestor de contraseñas.
2. **Administración → Gestión de roles → Crear rol** (p.ej.
   `MCP - solo lectura`): para cada módulo que quieras exponer, `Ver` y
   `Listar` = Sí; `Editar`, `Eliminar`, `Importar`, `Exportar` = No. Los
   módulos que no quieras exponer, `Acceso` = Deshabilitado.
3. Asigna el rol al usuario.

Puedes usar el rol es la barrera de seguridad por encima de el `ALLOW_WRITES`

> **¿Por qué 4 variables (client id/secret **y** usuario/contraseña) y no
> solo el cliente OAuth2?** Porque el grant `password` de OAuth2 identifica
> **dos cosas a la vez**: la aplicación que llama (el cliente) y la persona
> en cuyo nombre actúa (el usuario del CRM). Sin usuario, el CRM no sabe qué
> rol y qué permisos aplicar a cada llamada, y las acciones no quedarían
> a nombre de nadie auditable. Si prefieres no crear un usuario dedicado,
> puedes usar `client_credentials` en su lugar (deja `SINERGIA_USERNAME` y
> `SINERGIA_PASSWORD` vacíos: el servidor lo detecta solo), que es el grant
> de los [ejemplos oficiales de SinergiaTIC](https://github.com/SinergiaTIC/SinergiaCRM-API-Examples/tree/main/v8).
> Con `password` es más fácil auditar quién hizo qué en el CRM.

---

## 2. Variables de entorno

```bash
cp .env.example .env.local
```

| Variable | Obligatoria | Descripción |
|----------|-------------|-------------|
| `SINERGIA_URL` | Sí | URL base de la instancia, **sin** `/Api` y **sin** `/legacy` |
| `SINERGIA_CLIENT_ID` | Sí | Campo "ID" del cliente OAuth2 (paso 1.1) |
| `SINERGIA_CLIENT_SECRET` | Sí | El secreto que pegaste en "cambiar la clave" (paso 1.1) |
| `SINERGIA_USERNAME` | Con grant `password` | Usuario API dedicado (paso 1.2) |
| `SINERGIA_PASSWORD` | Con grant `password` | Su contraseña |
| `MCP_AUTH_SECRET` | Sí | Secreto propio de este servidor. Genéralo igual que el anterior, con `openssl rand -hex 32` o el generador web |
| `ALLOW_WRITES` | No | `false` por defecto; `true` registra las tools de escritura |
| `PUBLIC_BASE_URL` | No | Solo con dominio propio, para fijar la URL que anuncia el descubrimiento OAuth |

`MCP_AUTH_SECRET` es distinto del cliente OAuth2 del CRM: es la clave de
entrada a *este* servidor MCP, y hace tres papeles — bearer estático, clave
de la pantalla de consentimiento OAuth, y semilla para firmar los tokens que
emite este mismo servidor. Cambiarla invalida todas las sesiones de golpe (a
propósito, es la forma de revocar acceso).

Nunca se hardcodean credenciales en el código; `.env*` está en `.gitignore`.

---

## 3. Probar en local (opcional)

```bash
npm install
npm run test:auth   # login OAuth2 + listado de módulos, no escribe nada
npm run dev         # http://localhost:3000/api/mcp
```

`npm run test:auth` valida URL, cliente OAuth2, usuario y permisos del rol, e
imprime los primeros módulos accesibles. Es el paso previo a cualquier
despliegue.

```bash
# Sin credenciales debe dar 401:
curl -i -X POST http://localhost:3000/api/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}'

# Con el secreto, para ver las tools registradas:
curl -s -X POST http://localhost:3000/api/mcp \
  -H "Authorization: Bearer $MCP_AUTH_SECRET" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
```

Otros comandos: `npm run typecheck`, `npm run build`.

---

## 4. Desplegar en Vercel (u otra plataforma)

1. Importa el repositorio en Vercel (Next.js se detecta solo).
2. **Settings → Environment Variables**: añade las variables de la tabla
   anterior y márcalas como *Sensitive*.
3. Despliega. El endpoint queda en `https://<tu-deploy>.vercel.app/api/mcp` (o en el dominio que condifures)

Notas sueltas:

- El token OAuth se cachea en memoria del proceso y se reaprovecha mientras
  Vercel reutilice la instancia; no se persiste en disco ni en ningún
  almacén externo.
- Cada cambio de variable de entorno necesita un redeploy para aplicarse.

---

## 5. Conectar tu agente de IA

El servidor acepta dos formas de autenticarse, ambas contra la misma
`MCP_AUTH_SECRET`. Cualquier cliente MCP genérico (Streamable HTTP) puede
usar la primera:

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

Esto vale para Claude Code, MCP Inspector, y cualquier agente que permita
configurar cabeceras personalizadas en sus conectores MCP.

**Claude Code:**

```bash
claude mcp add --transport http sinergiacrm https://<tu-deploy>.vercel.app/api/mcp \
  --header "Authorization: Bearer <MCP_AUTH_SECRET>"
```

**Clientes que solo hablan stdio** (vía [`mcp-remote`](https://www.npmjs.com/package/mcp-remote)):

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

**Claude en la web (claude.ai):** no permite cabeceras personalizadas en
conectores, solo OAuth — por eso el **servidor incluye uno mínimo**.

1. [claude.ai → Ajustes → Conectores](https://claude.ai/customize/connectors)
   (plan Pro/Max/Team/Enterprise).
2. **"+" → "Añadir conector personalizado"**, y pega la URL con `/api/mcp` al
   final. Deja Client ID y Client Secret vacíos: se registra solo.
3. **Añadir → Conectar**. Se abrirá una pantalla pidiendo una clave de
   acceso: pega ahí `MCP_AUTH_SECRET`.

Si cambias `MCP_AUTH_SECRET`, todas las sesiones OAuth dejan de valer y hay
que reconectar (es la forma de revocar acceso de golpe).

---

## 6. Activar escritura

Por defecto solo lectura, a propósito:

1. Revisa que el rol del usuario API tenga `Editar` **solo** en los módulos
   que toque (el CRM manda, aunque el flag esté activo).
2. `ALLOW_WRITES=true` en Vercel y redeploy.
3. Comprueba que `tools/list` ahora incluye `create_entry`, `update_entry` y
   `set_relationship`.

Con `ALLOW_WRITES=false` esas tools **ni se registran**: el modelo no las ve,
no puede intentar llamarlas. Para volver atrás, `ALLOW_WRITES=false` y
redeploy.

---

## Cómo está hecho por dentro

```
app/
  api/mcp/route.ts       Endpoint MCP + verificación del token de entrada
  oauth/register/        Dynamic Client Registration (RFC 7591)
  oauth/authorize/       Pantalla de consentimiento + emisión del código (PKCE)
  oauth/token/           Canje del código y refresco, con rotación
  .well-known/…          Metadatos RFC 9728 y RFC 8414
lib/
  config.ts              Lectura y validación de variables de entorno
  mcp/auth.ts            Comparación en tiempo constante contra MCP_AUTH_SECRET
  mcp/tools.ts           Definición y registro de las tools (flag de escritura)
  oauth/tokens.ts        Firma y verificación HMAC de los artefactos OAuth
  sinergia/auth.ts       OAuth2 contra el CRM: login, refresh y caché de token
  sinergia/client.ts     Cliente HTTP de la API V8, errores y reintento en 401
  sinergia/query.ts      Filtros estructurados, orden, paginación, validaciones
  sinergia/flatten.ts    Aplanado de JSON:API a respuestas compactas
scripts/test-auth.ts     Smoke test de credenciales
```



Referencias usadas: [SuiteCRM V8 JSON:API](https://docs.suitecrm.com/developer/api/developer-setup-guide/json-api/)
y [SinergiaTIC/SinergiaCRM-API-Examples](https://github.com/SinergiaTIC/SinergiaCRM-API-Examples).

---

## Problemas frecuentes

| Síntoma | Causa probable |
|---------|----------------|
| `404` al pedir el token | `SINERGIA_URL` mal puesta, o incluye `/legacy` o `/Api` |
| `Respuesta no-JSON de …/Api/access_token` | La URL apunta a la interfaz web, no a la API; o la API V8 no está habilitada |
| `500` al pedir el token | Faltan o tienen mal los permisos las claves RSA de `Api/V8/OAuth2/` |
| `invalid_client` | Client ID/Secret mal, o el cliente OAuth2 tiene otro grant configurado |
| `invalid_credentials` | Usuario o contraseña incorrectos, o usuario desactivado |
| Todas las peticiones MCP dan `401` | Falta `MCP_AUTH_SECRET`, o el cliente manda otro valor |
| `Filter field X in Y module is not found` | El campo no existe en ese módulo: compruébalo con `get_module_fields` |
| No aparecen las tools de escritura | `ALLOW_WRITES` no es `true`, o falta el redeploy |
| Un módulo no aparece en `get_available_modules` | El rol del usuario API no le da acceso |
| Claude web: "No se pudo conectar" | La URL no acaba en `/api/mcp`, o pusiste algo en Client ID/Secret |
| Claude web: "Cliente no válido" al autorizar | Cambiaste `MCP_AUTH_SECRET`: borra el conector y vuelve a añadirlo |
| Claude web pide la clave una y otra vez | La clave tecleada no coincide con `MCP_AUTH_SECRET` (ojo a espacios al copiar) |

---

## Créditos

**Movimiento Consolación para el Mundo** · Equipo de desarrollo · admin@movimientoconsolacion.com

Primera versión / prototipo, hecho para explorar cómo montar un servidor MCP
sobre la API de SuiteCRM/SinergiaCRM.
No es un producto cerrado ni la única forma de
hacerlo — revísalo, adáptalo y rómpelo si hace falta.
