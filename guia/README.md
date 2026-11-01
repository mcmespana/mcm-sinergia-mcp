# Guía de campos de tu instancia (`CAMPOS-RESUMEN.md`)

Cada organización adapta SinergiaCRM a su manera: campos propios (`…_c`), módulos propios y, sobre todo, **claves de
desplegable** que la API ni devuelve ni valida. Sin una chuleta, el agente las descubre a base de `get_module_fields`
y de probar, y a veces se las inventa (una clave inventada se guarda sin error y queda rota).

`CAMPOS-RESUMEN.md` es esa chuleta: **una página que el agente lee de un vistazo** con la tool `crm_fields_guide`
(entera, o solo los módulos que pida, siempre con las reglas generales). El servidor anuncia al conectar que existe.

La guía es **de tu organización, no de este repo**: este repo se puede copiar tal cual para otra instancia.

## Montarla en 4 pasos

1. **Borrador automático** desde tu CRM (solo lee):
   ```bash
   npm run guide:generate                          # módulos con campos propios o enlaces
   npm run guide:generate -- Contacts stic_Events  # o solo los que digas
   ```
   Escribe `guia/CAMPOS-RESUMEN.md` con los campos obligatorios, los propios (`_c`) y los de enlace (`_ida`).
2. **Complétala a mano**: qué es cada campo, las claves de cada desplegable (Studio → el desplegable), qué NO
   usar y las trampas que ya os han mordido. Borra lo que no uséis: más corta = más útil.
3. **Publícala** donde la mantengáis (lo normal, en el repo de vuestra documentación) y pon su URL «raw» en
   `CRM_FIELDS_GUIDE_URL`. Así se actualiza sin redesplegar (caché de 10 minutos). Si preferís tenerla aquí, dejadla en
   `guia/CAMPOS-RESUMEN.md` y quitad esa línea del `.gitignore`.
4. **Compruébala**: `npm run test:guide -- Contacts` (dice de dónde la lee, qué módulos tiene y si tiene buena forma).

Ejemplo real y completo: la de MCM, en
[`comunicaAreaPrivada/docs/comunica/CAMPOS-RESUMEN.md`](https://github.com/mcmespana/comunicaAreaPrivada/blob/main/docs/comunica/CAMPOS-RESUMEN.md).

## El formato (`campos-resumen/1`)

Markdown normal, con tres convenciones que son las que usa el servidor para trocearla:

- Una sección **`## Reglas`**: lo que vale para todo (cómo se asigna lo que se crea, formatos, datos sensibles…).
  Acompaña siempre a cualquier módulo que se pida.
- Una sección **`## ` por módulo**, con el **nombre técnico entre comillas invertidas** en el título:
  ``## `stic_Events` — Eventos``. Si una sección cubre dos, nómbralos los dos:
  ``## `stic_Sessions` / `stic_Attendances` — Sesiones``.
- Dentro, una tabla con **una fila por campo**: `| Campo | Tipo | Qué es · claves |`. Tipos cortos: `enum`, `multi`
  (llega `^a^,^b^`), `bool`, `date`, `text`, `int`, `dec`, `url`, `rel`, `link`, `id`. Claves: `` `clave` [Etiqueta] ``.
  Marca de qué te fías: ✅ claves completas (leídas en Studio) · 👁 vistas en datos · ❓ sin confirmar.

Las secciones sin módulo en el título (notas, «otros módulos») son válidas, pero solo salen con la guía entera.
Mantenla por debajo de ~25 000 caracteres: si crece más, se está convirtiendo en el documento largo, y ese va aparte.
