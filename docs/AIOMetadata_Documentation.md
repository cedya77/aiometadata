# 📚 AIOMetadata — Documentación Completa

> Guía en español para usuarios y administradores del addon de metadatos todo-en-uno para Stremio.

---

## 📋 Tabla de Contenidos

1. [¿Qué es AIOMetadata?](#-qué-es-aiometadata)
2. [Primeros Pasos](#-primeros-pasos)
3. [Despliegue](#-despliegue)
4. [Configuración](#-configuración)
5. [Proveedores de Metadata](#-proveedores-de-metadata)
6. [Catálogos](#-catálogos)
7. [Búsqueda](#-búsqueda)
8. [Caché y Rendimiento](#-caché-y-rendimiento)
9. [Seguridad](#-seguridad)
10. [Variables de Entorno](#-variables-de-entorno)
11. [API REST](#-api-rest)
12. [Solución de Problemas](#-solución-de-problemas)

---

## 🎬 ¿Qué es AIOMetadata?

**AIOMetadata** es un addon de metadatos para [Stremio](https://www.stremio.com/) orientado a usuarios avanzados. Su función principal es enriquecer el catálogo de Stremio con información detallada (pósters, descripciones, calificaciones, reparto, etc.) obtenida de múltiples fuentes simultáneamente.

### Características principales

| Característica | Descripción |
|---|---|
| 🌐 **Multi-fuente** | Combina datos de TMDB, TVDB, MAL, AniList, IMDb, TVmaze, Fanart.tv y más |
| 🖼️ **Imágenes ricas** | Pósters, fondos y logos de alta calidad con selección por idioma y fallback automático |
| 🎌 **Anime avanzado** | Soporte profundo de MAL, AniList, Kitsu, AniDB, con mapeo por estudio, género, temporada y horario |
| 📋 **Catálogos personalizables** | Añade, reordena y elimina catálogos con interfaz de arrastrar y soltar |
| 📡 **Catálogos de streaming** | Integración con Netflix, Disney+, Amazon, Max y más (con filtros por región) |
| 🔍 **Búsqueda dinámica** | Motores de búsqueda configurables por tipo; búsqueda con IA mediante Gemini o OpenRouter |
| 🔐 **Multi-usuario** | Cada usuario tiene su UUID y contraseña; la configuración se guarda por separado |
| ⚡ **Caché Redis** | Caché distribuida con auto-reparación, TTLs configurables y calentamiento programado |
| 🗺️ **Mapeo de IDs** | Traducción entre todos los sistemas de IDs principales (MAL, TMDB, TVDB, IMDb, AniList, Kitsu, etc.) |

### Arquitectura resumida

```
Usuario de Stremio
       │
       ▼
  Express Server (Node.js + TypeScript)
       │
       ├── SQLite / PostgreSQL  (configuraciones de usuario)
       ├── Redis                (caché de respuestas)
       └── APIs externas        (TMDB, TVDB, MAL, Fanart.tv, etc.)
```

El servidor sirve una interfaz React (disponible en `/configure` y `/dashboard`) y el protocolo Stremio se expone bajo `/stremio/:uuid/`.

---

## 🚀 Primeros Pasos

### Acceder a una instancia hospedada

Si alguien ya administra una instancia, solo necesitas:

1. Ir a la URL que te proporcionaron (por ejemplo `https://mi-instancia.com/configure`)
2. Si la instancia requiere contraseña de administrador, se mostrará un formulario de acceso. Puedes entrar como administrador o como **invitado** (solo lectura).
3. Una vez dentro, introduce tu **UUID** de usuario (o créalo presionando el botón para generar uno nuevo) y opcionalmente una contraseña personal.
4. Configura tus catálogos, proveedores y claves de API preferidas.
5. Guarda la configuración y copia la URL del manifest que aparecerá en pantalla.
6. En Stremio, ve a **Addons → Buscar addons → Pegar URL del manifest** e instala el addon.

### Primera vez como administrador (instancia propia)

Después de desplegar (ver sección siguiente):

1. Abre `http://tu-dominio:3232/` — verás la página de inicio con botones de "Configurar" y "Dashboard".
2. Si configuraste `ADMIN_KEY`, se pedirá esa clave al entrar en `/configure` o `/dashboard`.
3. En el dashboard puedes monitorear el servidor, gestionar usuarios, ver logs y ajustar configuraciones.

---

## 🐳 Despliegue

### Docker Compose (recomendado)

Crea un archivo `docker-compose.yml`:

```yaml
services:
  aiometadata:
    image: ghcr.io/cedya77/aiometadata:latest
    container_name: aiometadata
    restart: unless-stopped
    ports:
      - "3232:3232"
    env_file:
      - .env
    volumes:
      - ${DOCKER_DATA_DIR}/aiometadata/data:/app/addon/data
    depends_on:
      aiometadata_redis:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "wget", "--no-verbose", "--tries=1", "--spider", "http://localhost:3232/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 40s

  aiometadata_redis:
    image: redis:latest
    container_name: aiometadata_redis
    restart: unless-stopped
    volumes:
      - ${DOCKER_DATA_DIR}/aiometadata/cache:/data
    command: redis-server --appendonly yes --save 3600 1
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 5s
      retries: 5
```

Crea el archivo `.env` con las variables necesarias (ver sección de [Variables de Entorno](#-variables-de-entorno)) y luego:

```bash
docker compose up -d
```

### Verificar que el servidor está activo

```bash
curl http://localhost:3232/health
# {"status":"healthy","timestamp":"...","version":"..."}
```

### PostgreSQL (opcional)

Por defecto se usa SQLite. Para usar PostgreSQL, añade el servicio al `docker-compose.yml` y cambia `DATABASE_URI`:

```yaml
#aiometadata_postgres:
#  image: postgres:latest
#  container_name: aiometadata_postgres
#  restart: unless-stopped
#  environment:
#    - POSTGRES_DB=aiometadata
#    - POSTGRES_USER=postgres
#    - POSTGRES_PASSWORD=password
#  volumes:
#    - ${DOCKER_DATA_DIR}/aiometadata/postgres:/var/lib/postgresql/data
```

```env
DATABASE_URI=postgresql://postgres:password@aiometadata_postgres:5432/aiometadata
```

### Proxy de pósters (opcional)

Para cachear las imágenes de pósters localmente y servirlas instantáneamente, puedes añadir un servicio `nginx` como proxy inverso de imágenes. Esto reduce la latencia en peticiones repetidas y, combinado con el calentamiento de caché, sirve imágenes desde disco.

Variables relevantes para el proxy de pósters:

| Variable | Descripción |
|---|---|
| `POSTER_PROXY_PREFIX_URL` | URL pública del proxy (Stremio usará esta URL para cargar imágenes) |
| `POSTER_WARMUP_URL` | URL interna del proxy para el calentamiento del servidor |
| `POSTER_WARMUP_DELAY_MS` | Pausa entre lotes de calentamiento (default: `50`) |
| `POSTER_WARMUP_CONCURRENCY` | Peticiones paralelas por lote (default: `1`) |

### Traefik

El `docker-compose.yml` incluye comentarios para configurar etiquetas de Traefik con TLS automático. Descomenta las líneas de `labels` y `expose` según tu configuración.

---

## ⚙️ Configuración

### Página `/configure`

La interfaz principal de configuración está en `/configure`. Se organiza en pestañas (escritorio) o acordeón (móvil):

#### Autenticación de usuario

Antes de poder guardar configuración, debes iniciar sesión:

1. Haz clic en el icono de usuario en la esquina superior derecha.
2. Introduce tu UUID (puedes generarlo automáticamente) y contraseña opcional.
3. Al guardar, el servidor valida las credenciales y devuelve tu configuración existente o crea una nueva.

Las URLs del tipo `/stremio/:uuid/configure` pre-rellenan el UUID automáticamente.

#### Claves de API

En la pestaña de **Claves de API** introduces tus tokens personales para los distintos proveedores. Hay un botón de validación para probar cada clave antes de guardar:

| Campo | Proveedor | Obligatorio |
|---|---|---|
| TMDB API | The Movie Database | Muy recomendado |
| TVDB API Key | The TV Database | Muy recomendado para series |
| Fanart.tv API Key | Arte alternativo (logos, fondos) | Opcional |
| RPDB API Key | Rating Poster DB (ratings en pósters) | Opcional |
| MDBList API Key | Listas personalizadas de MDBList | Opcional |
| Gemini API Key | Búsqueda con IA (Google Gemini) | Opcional |
| OpenRouter API Key | Búsqueda con IA alternativa | Opcional |

#### Idioma y preferencias generales

- **Idioma**: Afecta los títulos de catálogos, géneros y metadatos en la interfaz. Usa códigos BCP-47 (ej. `es-ES`, `en-US`, `pt-BR`).
- **Nombre del addon**: Personaliza cómo aparece el addon en Stremio.
- **Mostrar prefijo**: Añade el nombre del addon antes de cada catálogo (ej. "AIOMetadata - Popular").

#### Proveedores de metadatos

En la pestaña de **Proveedores** seleccionas qué fuente usar para cada tipo de contenido:

- **Películas**: TMDB (por defecto), TVDB, IMDb
- **Series**: TVDB (por defecto), TMDB, TVmaze, IMDb
- **Anime (series)**: MAL (por defecto), AniList, TVDB
- **Anime (películas)**: MAL (por defecto), AniList

#### Arte y pósters

Configura qué fuentes usar para imágenes:
- Proveedores de arte por tipo (TMDB, TVDB, Fanart.tv, AniList)
- Solo arte en inglés (útil si los pósters en otros idiomas son de baja calidad)
- RPDB: superpone la calificación directamente sobre el póster

#### Guardar y reinstalar

Cada vez que modificas la configuración:

1. Haz clic en **Guardar**.
2. La URL del manifest se actualiza automáticamente (incluye la configuración comprimida).
3. Si ya tenías el addon instalado en Stremio, desinstálalo y vuelve a instalar con la nueva URL, o usa la opción de actualizar si la URL no cambió.

### Flujo de guardado

```
POST /api/config/save
  └── Valida la contraseña del addon (ADDON_PASSWORD)
  └── Sanitiza tokens OAuth (Trakt, Simkl)
  └── Comprueba límite de catálogos (MAX_CATALOGS)
  └── Guarda en SQLite/PostgreSQL
  └── Invalida caché Redis del usuario
  └── Devuelve { uuid, configHash }
```

---

## 🎭 Proveedores de Metadata

### TMDB (The Movie Database)

- **Tipo**: Películas y series
- **Datos**: Títulos, descripciones, pósters, fondos, reparto, géneros, calificaciones, proveedores de streaming por país
- **Cuándo usarlo**: Primera opción para películas. Excelente cobertura global, datos actualizados frecuentemente.
- **Clave**: `TMDB_API` — obtén la tuya en [themoviedb.org](https://www.themoviedb.org/settings/api)
- **ID format**: `tmdb:12345`

También soporta **autenticación TMDB** para acceder a tu lista de favoritos y watchlist personales:
```
POST /api/tmdb/auth/request_token  → obtiene token temporal
POST /api/tmdb/auth/session         → crea sesión con el token aprobado
```

### TVDB (The TV Database)

- **Tipo**: Series, anime y películas
- **Datos**: Episodios detallados, artwork oficial, colecciones, clasificaciones por contenido
- **Cuándo usarlo**: Primera opción para series (especialmente anime con mapeo TVDB). Mejor cobertura de episodios que TMDB.
- **Clave**: `TVDB_API_KEY` — obtén la tuya en [thetvdb.com](https://thetvdb.com/api-information)
- **ID format**: `tvdb:67890`
- **Extra**: Soporta catálogos de **Colecciones** (sagas y universos cinematográficos)

### MAL — MyAnimeList (vía Jikan)

- **Tipo**: Anime (series y películas)
- **Datos**: Rankings de popularidad, favoritos, géneros, estudios, temporadas, horarios de emisión
- **Cuándo usarlo**: Primera opción para anime. No requiere clave de API (usa la API pública de Jikan).
- **ID format**: `mal:456`
- **Catálogos disponibles**:
  - Emitiendo actualmente (`mal.airing`)
  - Próximamente (`mal.upcoming`)
  - Por género (`mal.genres`)
  - Por estudio (`mal.studios`)
  - Por temporada (`mal.seasons`) — Invierno, Primavera, Verano, Otoño + año
  - Horario semanal (`mal.schedule`)
  - Décadas: 80s, 90s, 00s, 10s, 20s
  - Top general (`mal.top_anime`), top películas, top series, más populares, más favoritos

### AniList

- **Tipo**: Anime (series y películas)
- **Datos**: Tendencias, géneros, calificaciones de la comunidad AniList
- **Cuándo usarlo**: Alternativa o complemento a MAL, especialmente para usuarios de la comunidad AniList.
- **OAuth**: Requiere `ANILIST_CLIENT_ID` y `ANILIST_CLIENT_SECRET` para listas personales
- **ID format**: `anilist:789`

### IMDb

- **Tipo**: Películas y series
- **Datos**: Calificaciones IMDb, identificadores universales
- **Cuándo usarlo**: Complementario, especialmente para calificaciones. El addon carga datos de calificaciones de IMDb localmente al arrancar.
- **ID format**: `tt1234567`

### TVmaze

- **Tipo**: Series de televisión
- **Datos**: Horarios de emisión por país, información de episodios
- **Cuándo usarlo**: Para el catálogo de programación televisiva actual (`tvmaze.schedule`).
- **Filtros de país disponibles**: US, CA, GB, AU, DE, FR, ES, BR

### Fanart.tv

- **Tipo**: Proveedor de arte exclusivamente
- **Datos**: Logos, fondos, pósters en alta resolución
- **Cuándo usarlo**: Para mejorar la calidad visual del addon con logos y fondos premium.
- **Clave**: `FANART_API_KEY` y opcionalmente `FANART_API_PROJECT_KEY`

### RPDB (Rating Poster DB)

- **Tipo**: Superposición de calificaciones en pósters
- **Función**: Sustituye el póster original por una versión con la calificación impresa encima
- **Clave**: `RPDB_API_KEY`

### MDBList

- **Tipo**: Listas curadas de películas y series
- **Datos**: Listas públicas y privadas del usuario, metadatos adicionales (ratings de múltiples fuentes)
- **Cuándo usarlo**: Para añadir listas temáticas o de recomendaciones de la comunidad MDBList.
- **Clave**: `MDBLIST_API_KEY`

### Trakt

- **Tipo**: Listas personales, historial de visualización
- **OAuth**: Requiere `TRAKT_CLIENT_ID` y `TRAKT_CLIENT_SECRET`
- **Catálogos disponibles**: Watchlist, Favoritos, Historial, Recomendaciones, Calendarios, listas de usuario y del equipo Trakt

### Simkl

- **Tipo**: Listas personales de seguimiento
- **OAuth**: Requiere `SIMKL_CLIENT_ID` y `SIMKL_CLIENT_SECRET`
- **Catálogos**: Tendencias (hoy/semana/mes) por tipo y género, watchlist personal

### Letterboxd

- **Tipo**: Listas de películas de Letterboxd
- **Función**: Importa listas públicas de Letterboxd por URL o nombre de lista

### FlixPatrol

- **Tipo**: Rankings de streaming
- **Función**: Top 10 de plataformas por país según FlixPatrol

### StremThru / Addons externos

- **Tipo**: Catálogos de otros addons de Stremio
- **Función**: Importa catálogos de addons externos (catálogos genéricos tipo StremThru)

### PublicMetaDB

- **Tipo**: Base de datos pública de metadatos
- **Catálogos**: Resume (seguimiento de visualización), listas y picks curados

---

## 📂 Catálogos

### ¿Qué es un catálogo?

Un catálogo es una lista de contenido que aparece en la pantalla de inicio de Stremio o al explorar el addon. Cada catálogo tiene:
- **ID único** (`tmdb.popular`, `mal.airing`, `mdblist.12345`, etc.)
- **Tipo** (`movie`, `series`, `anime`)
- **Nombre** visible en Stremio
- **Filtros** (géneros, año, idioma, etc.)
- **showInHome**: si aparece en el inicio de Stremio sin seleccionar género

### Tipos de catálogos

#### Catálogos estándar (TMDB)

| ID | Descripción |
|---|---|
| `tmdb.top` | Populares |
| `tmdb.trending` | En tendencia (día/semana) |
| `tmdb.top_rated` | Mejor valorados |
| `tmdb.year` | Por año de lanzamiento |
| `tmdb.language` | Por idioma original |
| `tmdb.airing_today` | Emitiendo hoy (por país) |

#### Catálogos TVDB

| ID | Descripción |
|---|---|
| `tvdb.trending` | En tendencia en TVDB |
| `tvdb.genres` | Por género |
| `tvdb.collections` | Colecciones/sagas |

#### Catálogos de anime (MAL)

| ID | Descripción |
|---|---|
| `mal.airing` | Anime en emisión |
| `mal.upcoming` | Próximos estrenos |
| `mal.genres` | Por género de anime |
| `mal.studios` | Por estudio de animación |
| `mal.seasons` | Por temporada y año |
| `mal.schedule` | Horario semanal |
| `mal.top_anime` | Top general |
| `mal.top_movies` / `mal.top_series` | Top por tipo |
| `mal.80sDecade` … `mal.20sDecade` | Por década |

#### Catálogos de streaming

Los catálogos de streaming usan los **Watch Providers** de TMDB filtrados por plataforma y región:

| ID | Plataforma |
|---|---|
| `streaming.nfx` | Netflix |
| `streaming.dnp` | Disney+ |
| `streaming.amp` | Amazon Prime Video |
| `streaming.hlu` | Hulu |
| `streaming.hbm` | Max (HBO Max) |
| `streaming.atp` | Apple TV+ |
| `streaming.pmp` / `streaming.pcp` | Peacock |
| `streaming.mgl` | Mubi / otros |

#### Catálogos personales (requieren OAuth)

| ID | Descripción |
|---|---|
| `trakt.watchlist` | Watchlist de Trakt |
| `trakt.favorites` | Favoritos de Trakt |
| `trakt.history` | Historial de visualización |
| `trakt.calendar` | Calendario de estrenos |
| `anilist.favorites` | Favoritos de AniList |
| `simkl.watchlist` | Watchlist de Simkl |
| `favorites` | Favoritos TMDB (autenticado) |
| `watchlist` | Watchlist TMDB (autenticado) |

#### Catálogos personalizados

- **MDBList** (`mdblist.<listId>`): cualquier lista de MDBList pública o propia
- **TMDB List** (`tmdb.list.<listId>`): cualquier lista curada de TMDB
- **TMDB Discover** (`tmdb.discover.<id>`): búsqueda avanzada con filtros (género, proveedor, fechas, etc.)
- **TVDB Discover** (`tvdb.discover.<id>`): exploración avanzada de TVDB
- **MAL Discover** (`mal.discover.<id>`): exploración personalizada de MAL
- **AniList Discover** (`anilist.discover.<id>`): exploración personalizada de AniList
- **Letterboxd** (`letterboxd.<id>`): lista de Letterboxd por URL
- **Trakt List** (`trakt.<id>`): lista específica de Trakt por usuario y slug
- **StremThru** (`stremthru.<manifestId>.<catalogId>`): catálogo externo

### Gestionar catálogos en la UI

En la pestaña **Catálogos** de `/configure`:

1. **Añadir catálogo**: Usa el botón "+" o "Añadir catálogo". Aparece un panel donde seleccionas el proveedor y tipo.
2. **Reordenar**: Arrastra los catálogos para cambiar el orden en que aparecen en Stremio.
3. **Activar/Desactivar**: El toggle junto a cada catálogo lo incluye o excluye del manifest.
4. **showInHome**: Activa para que el catálogo aparezca en el inicio de Stremio sin necesidad de seleccionar un filtro.
5. **Nombre personalizado**: Haz clic en el nombre para editarlo.
6. **Eliminar**: Botón de papelera junto al catálogo.

### Constructor de catálogos Discover

Para TMDB Discover, TVDB Discover y MAL Discover, hay un asistente visual que te permite configurar:
- Géneros incluidos/excluídos
- Plataformas de streaming
- Rango de fechas
- Idioma original
- Ordenación (popularidad, calificación, fecha)
- Estado (emitiendo, finalizado, etc.)
- Clasificación por contenido

---

## 🔍 Búsqueda

### Configuración de búsqueda

En la pestaña **Búsqueda** puedes:
- Activar/desactivar la búsqueda globalmente
- Seleccionar el motor de búsqueda por tipo de contenido
- Activar la búsqueda con IA (Gemini / OpenRouter)
- Reordenar los catálogos de búsqueda

### Motores de búsqueda disponibles

| Motor | Tipo | Descripción |
|---|---|---|
| `tmdb.search` | Películas y series | Búsqueda en TMDB (por defecto para películas) |
| `tvdb.search` | Series | Búsqueda en TVDB (por defecto para series) |
| `mal.search.series` | Anime series | Búsqueda en MAL vía Jikan |
| `mal.search.movie` | Anime películas | Búsqueda en MAL vía Jikan |
| `tvdb.collections.search` | Colecciones | Búsqueda en colecciones TVDB |
| `people_search_movie` | Películas | Búsqueda por actor/director en TMDB |
| `people_search_series` | Series | Búsqueda por actor/director en TMDB |

### Búsqueda con IA (Gemini / OpenRouter)

Cuando activas la búsqueda con IA y proporcionas una clave de Gemini o OpenRouter, aparece un catálogo especial **"AI Search"** en Stremio.

**Cómo funciona:**
1. Escribes una consulta en lenguaje natural (ej. "películas de ciencia ficción de los 90 con naves espaciales")
2. El modelo de IA interpreta la consulta y devuelve una lista de títulos sugeridos
3. AIOMetadata busca cada título en TMDB/TVDB y devuelve los resultados con metadatos completos

**Modelos de Gemini disponibles:**
- `gemini-2.5-flash-lite` (por defecto, más rápido)
- `gemini-2.5-flash`
- `gemini-2.5-pro`
- `gemini-3-flash`
- `gemini-3.1-flash-lite`
- `gemini-3.1-pro`

Los modelos que soportan **grounding** (conexión a datos actuales de Google) tienen un timeout de 45 segundos; el resto usa 30 segundos.

**Nota**: La búsqueda con IA solo aparece si `config.search.ai_enabled === true` Y hay una clave válida de Gemini u OpenRouter.

### Búsqueda por IMDb ID

Si escribes directamente un ID de IMDb (formato `tt1234567`) en la búsqueda, el servidor lo detecta y lo resuelve directamente sin pasar por el motor de búsqueda.

```javascript
function isImdbId(query) {
  return /^tt\d{7,8}$/i.test(query.trim());
}
```

### Actores de voz (MAL)

Si usas MAL como motor de búsqueda de anime, aparecen catálogos adicionales:
- **Voice Actor Roles** (`mal.va_search`): muestra todos los animes en los que participa un actor de voz específico
- **Anime Genre** (`mal.genre_search`): exploración por ID de género de MAL

---

## 🚀 Caché y Rendimiento

### Arquitectura de caché

AIOMetadata usa **Redis** como caché principal para todos los datos obtenidos de APIs externas. Sin Redis, el servidor sigue funcionando pero realiza peticiones a las APIs en cada request (más lento y con riesgo de rate limiting).

### TTLs por tipo de dato

| Tipo de dato | TTL por defecto | Variable de entorno |
|---|---|---|
| Catálogos | 24 horas | `CATALOG_TTL` |
| Metadatos (meta) | 7 días | `META_TTL` |
| Trending TMDB | 3 horas | `TMDB_TRENDING_TTL` |
| API de Jikan (MAL) | 30 días | (fijo) |
| Catálogos estáticos | 30 días | (fijo) |
| API de TVDB | 12 horas | (fijo) |
| API de TVmaze | 12 horas | (fijo) |
| Géneros de MDBList | 30 días | (fijo) |
| Catálogos AniList | 24 horas | `ANILIST_CATALOG_TTL` |

### Calentamiento de caché (Cache Warming)

El calentamiento precarga datos en Redis para que los usuarios obtengan respuestas instantáneas. Se divide en tres sistemas:

#### 1. Calentamiento esencial (`cacheWarmer.js`)
- Carga datos básicos de TMDB y MAL al arrancar
- Se repite cada `CACHE_WARMING_INTERVAL` minutos (default: 720 = 12 horas)
- Variables: `ENABLE_CACHE_WARMING`, `CACHE_WARMING_INTERVAL`

#### 2. Calentamiento de contenido popular (`warmPopularContent`)
- Precarga tendencias y contenido popular de TMDB
- Frecuencia configurable: `CACHE_WARM_INTERVAL_HOURS` (default: 24h, mínimo 12h)
- Idioma: `CACHE_WARM_LANGUAGE` (default: `en-US`)

#### 3. Calentamiento de catálogos MAL (`malCatalogWarmer.js`)
- Precarga catálogos de anime (géneros, temporadas, horarios)
- Frecuencia: `MAL_WARMUP_INTERVAL_HOURS` (default: 6h)
- Delay inicial: `MAL_WARMUP_INITIAL_DELAY_SECONDS` (default: 30s)
- Admite **horas tranquilas** (`MAL_WARMUP_QUIET_HOURS_ENABLED`, `MAL_WARMUP_QUIET_HOURS_RANGE`)

#### 4. Calentamiento comprensivo (`comprehensiveCatalogWarmer.js`)
- Calienta TODOS los catálogos configurados para un UUID específico
- Requiere `CACHE_WARMUP_UUID` configurado
- Solo activo con `CACHE_WARMUP_MODE=comprehensive`
- Configurable: páginas máximas, delay entre tareas, horas tranquilas

#### Configurar UUID de calentamiento

Para que el calentamiento funcione con tu configuración específica:

```env
CACHE_WARMUP_UUID=tu-uuid-de-usuario
CACHE_WARMUP_MODE=comprehensive
CATALOG_WARMUP_MAX_PAGES_PER_CATALOG=50
CATALOG_WARMUP_QUIET_HOURS_ENABLED=true
CATALOG_WARMUP_QUIET_HOURS=02:00-06:00
```

### Limpieza de caché

Un programador de limpieza elimina entradas expiradas o corruptas:
- Se activa con `CACHE_CLEANUP_AUTO_ENABLED=true` (default)
- Admite horas tranquilas: `CACHE_CLEANUP_QUIET_HOURS_ENABLED`, `CACHE_CLEANUP_QUIET_HOURS`

### Auto-reparación de caché

El sistema de caché tiene una capa de auto-reparación (`SELF_HEALING_CONFIG`):
- Reintentos automáticos ante fallos (`CACHE_MAX_RETRIES`, default: 2)
- Pausa entre reintentos (`CACHE_RETRY_DELAY`, default: 1000ms)
- Threshold para entradas corruptas (`CACHE_CORRUPTED_THRESHOLD`, default: 10)
- Desactivar: `ENABLE_SELF_HEALING=false`

### Dashboard de rendimiento

El **Dashboard** (`/dashboard`) muestra en tiempo real:
- Estado de Redis y métricas de hits/misses/errores
- Uso de memoria del proceso Node.js
- Tiempo de actividad del servidor (persiste entre reinicios)
- Estado del calentamiento de caché
- Estadísticas del mapeador de IDs

---

## 🔒 Seguridad

### ADMIN_KEY — Protección del panel de administración

Cuando defines `ADMIN_KEY`, las páginas `/configure` y `/dashboard` mostrarán un formulario de autenticación antes de cargarse.

```env
ADMIN_KEY=mi-clave-secreta-aleatoria
```

**Cómo funciona:**
1. El navegador carga la página y detecta que hay autenticación requerida (endpoint público `/api/dashboard/config`)
2. Se muestra el modal `AdminAuthGate` con opción de "Admin Login" o "Continuar como invitado"
3. Al introducir la clave correcta, se llama a `GET /api/dashboard/auth/check` con el header `x-admin-key`
4. La sesión se guarda en `sessionStorage` del navegador (se pierde al cerrar la pestaña)

**Notas importantes:**
- Las rutas `/stremio/*` nunca están protegidas por `ADMIN_KEY`
- La API pública (`/manifest.json`, `/api/config`) tampoco requiere `ADMIN_KEY`
- Solo los endpoints de dashboard (`/api/dashboard/*`) requieren la clave

### Modo invitado

Por defecto, cuando hay `ADMIN_KEY`, los usuarios pueden acceder al dashboard como **invitado** (solo lectura de métricas públicas). Para desactivar esto:

```env
DISABLE_GUEST_MODE=true
```

Con `DISABLE_GUEST_MODE=true`, el dashboard solo es accesible con la clave de administrador.

### ADDON_PASSWORD — Contraseña global del addon

Si defines `ADDON_PASSWORD`, todos los usuarios necesitarán esta contraseña además de su UUID para cargar o guardar configuración:

```env
ADDON_PASSWORD=contraseña-compartida
```

Útil para instancias privadas donde quieres controlar quién puede usar el addon.

### Contraseña de usuario (por-usuario)

Cada usuario puede establecer su propia contraseña al guardar la configuración. Esta contraseña:
- Se guarda hasheada en la base de datos
- Se requiere al cargar la configuración desde un nuevo dispositivo
- Es independiente del `ADMIN_KEY` y del `ADDON_PASSWORD`

### Trusted UUIDs

El endpoint `GET /api/config/is-trusted/:uuid` permite pre-verificar si un UUID existe en la base de datos sin necesidad de contraseña. Útil para el flujo de reconexión automática en Stremio.

### Limitación de catálogos

Para instancias públicas, puedes limitar cuántos catálogos puede tener cada usuario:

```env
MAX_CATALOGS=200
```

Si se excede este límite al guardar, el servidor rechaza la solicitud con error.

---

## 🌍 Variables de Entorno

### Configuración básica

| Variable | Descripción | Default |
|---|---|---|
| `PORT` | Puerto HTTP del servidor | `3232` |
| `HOST_NAME` | Hostname público con esquema (ej. `https://mi-dominio.com`) | **Requerido** |
| `NODE_ENV` | Entorno de Node.js (`production` o `development`) | `development` |
| `LOG_LEVEL` | Nivel de logs (`silent`, `fatal`, `error`, `warn`, `info`, `debug`, `trace`) | `info` |

### Base de datos y caché

| Variable | Descripción | Default |
|---|---|---|
| `DATABASE_URI` | URI de SQLite o PostgreSQL | `sqlite://addon/data/db.sqlite` |
| `REDIS_URL` | URL de conexión a Redis | `redis://aiometadata_redis:6379` |

### Seguridad y administración

| Variable | Descripción | Default |
|---|---|---|
| `ADMIN_KEY` | Clave de acceso al panel de administración | *(sin definir = sin protección)* |
| `ADDON_PASSWORD` | Contraseña global requerida para todos los usuarios | *(sin definir)* |
| `DISABLE_GUEST_MODE` | `true` para requerir `ADMIN_KEY` (sin acceso de invitado) | *(sin definir = invitado permitido)* |
| `DISABLE_METRICS` | `true` para desactivar toda la telemetría del dashboard | `false` |
| `MAX_CATALOGS` | Límite de catálogos por usuario | *(sin límite)* |

### Claves de API externas

| Variable | Descripción |
|---|---|
| `TMDB_API` | Clave de The Movie Database |
| `TVDB_API_KEY` | Clave de The TV Database |
| `FANART_API_KEY` | Clave de Fanart.tv |
| `FANART_API_PROJECT_KEY` | Clave de proyecto de Fanart.tv |
| `RPDB_API_KEY` | Clave de Rating Poster DB |
| `MDBLIST_API_KEY` | Clave de MDBList |
| `GEMINI_API_KEY` | Clave de Google Gemini (búsqueda IA) |
| `SIMKL_CLIENT_ID` / `SIMKL_CLIENT_SECRET` | OAuth de Simkl |
| `SIMKL_REDIRECT_URI` | URI de redirección OAuth de Simkl |
| `ANILIST_CLIENT_ID` / `ANILIST_CLIENT_SECRET` | OAuth de AniList |
| `ANILIST_REDIRECT_URI` | URI de redirección OAuth de AniList |
| `TRAKT_CLIENT_ID` / `TRAKT_CLIENT_SECRET` | OAuth de Trakt |
| `TRAKT_REDIRECT_URI` | URI de redirección OAuth de Trakt |
| `DISABLE_TRAKT_SEARCH` | `true` para deshabilitar Trakt como motor de búsqueda (recomendado en instancias públicas) |

### TTLs de caché

| Variable | Descripción | Default |
|---|---|---|
| `CATALOG_TTL` | TTL de catálogos en segundos | `86400` (24h) |
| `META_TTL` | TTL de metadatos en segundos | `604800` (7 días) |
| `TMDB_TRENDING_TTL` | TTL de tendencias TMDB en segundos | `10800` (3h) |
| `ANILIST_CATALOG_TTL` | TTL de catálogos AniList en segundos | `86400` (24h) |
| `SIMKL_ACTIVITIES_TTL` | TTL de actividad de Simkl en segundos | `21600` (6h) |

### Calentamiento de caché

| Variable | Descripción | Default |
|---|---|---|
| `ENABLE_CACHE_WARMING` | Activa el calentamiento de caché | `true` |
| `CACHE_WARMUP_UUID` | UUID para el calentamiento esencial | `system-cache-warmer` |
| `CACHE_WARMUP_UUIDS` | UUIDs adicionales separados por coma | *(vacío)* |
| `CACHE_WARMUP_MODE` | `essential` o `comprehensive` | `essential` |
| `CACHE_WARM_INTERVAL_HOURS` | Frecuencia del calentamiento popular (mínimo 12h) | `24` |
| `CACHE_WARM_LANGUAGE` | Idioma para el calentamiento | `en-US` |
| `CATALOG_WARMUP_MAX_PAGES_PER_CATALOG` | Páginas máximas por catálogo en calentamiento comprensivo | `100` |
| `CATALOG_WARMUP_QUIET_HOURS_ENABLED` | Activa horas tranquilas para calentamiento | `false` |
| `CATALOG_WARMUP_QUIET_HOURS` | Rango de horas tranquilas (ej. `02:00-06:00`) | `02:00-06:00` |

### Calentamiento MAL

| Variable | Descripción | Default |
|---|---|---|
| `MAL_WARMUP_ENABLED` | Activa el calentamiento específico de MAL | `true` |
| `MAL_WARMUP_INTERVAL_HOURS` | Frecuencia del calentamiento MAL | `6` |
| `MAL_WARMUP_QUIET_HOURS_ENABLED` | Activa horas tranquilas para MAL | `false` |
| `MAL_WARMUP_QUIET_HOURS_RANGE` | Rango de horas tranquilas para MAL (ej. `2-8`) | `2-8` |

### Personalización

| Variable | Descripción | Default |
|---|---|---|
| `ADDON_NAME_SUFFIX` | Sufijo añadido al nombre del addon en el manifest | *(vacío)* |
| `CUSTOM_DESCRIPTION_BLURB` | HTML personalizado mostrado en `/configure` | *(vacío)* |
| `ADDON_LOGO_URL` | URL personalizada para el logo del addon | `/logo.png` |
| `CATALOG_LIST_ITEMS_SIZE` | Ítems por página en catálogos | `20` |

### Rendimiento y concurrencia

| Variable | Descripción | Default |
|---|---|---|
| `TRAKT_CONCURRENCY` | Peticiones paralelas máximas a Trakt | `5` |
| `TRAKT_MIN_TIME` | Espaciado mínimo entre peticiones a Trakt (ms) | `200` |
| `META_CONCURRENCY` | Llamadas concurrentes a `getMeta()` por request | *(sin límite)* |
| `HEAP_LOG_INTERVAL_MIN` | Intervalo para loggear estadísticas de memoria (minutos) | `0` (desactivado) |
| `FANART_CLIENT_CACHE_MAX` | Máximo de entradas en caché del cliente Fanart.tv | `2000` |
| `TMDB_SCRAPED_IMDB_CACHE_MAX` | Máximo de IDs de IMDb en caché de TMDB | `10000` |
| `TEST_KEYS_RATE_LIMIT_PER_MIN` | Límite de validaciones de claves por minuto | `60` |

### Proxy

| Variable | Descripción |
|---|---|
| `SOCKS_PROXY_URL` | Proxy SOCKS5 para todas las peticiones |
| `HTTP_PROXY` / `HTTPS_PROXY` | Proxy HTTP/HTTPS global |
| `TMDB_SOCKS_PROXY_URL` | Proxy específico para TMDB |
| `MAL_SOCKS_PROXY_URL` | Proxy específico para Jikan/MAL |
| `GEMINI_HTTPS_PROXY` | Proxy específico para Gemini |
| `POSTER_PROXY_PREFIX_URL` | URL del proxy de pósters (prefijo en respuestas) |

---

## 🔌 API REST

### Endpoints públicos (sin autenticación)

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/health` | Estado del servidor: `{"status":"healthy","version":"..."}` |
| `GET` | `/manifest.json` | Manifest básico de Stremio |
| `GET` | `/stremio/:uuid/manifest.json` | Manifest específico del usuario |
| `GET` | `/api/config` | Configuración pública del servidor (claves configuradas, versión, TTLs) |
| `GET` | `/api/dashboard/config` | `{"guestModeEnabled":bool,"adminKeyConfigured":bool}` |
| `GET` | `/api/config/addon-info` | `{"requiresAddonPassword":bool}` |
| `GET` | `/api/config/is-trusted/:uuid` | `{"trusted":bool,"requiresAddonPassword":bool}` |

### Endpoints de configuración de usuario

| Método | Ruta | Auth requerida | Descripción |
|---|---|---|---|
| `POST` | `/api/config/save` | Contraseña addon (si aplica) | Guarda nueva configuración |
| `POST` | `/api/config/load/:userUUID` | Contraseña usuario | Carga configuración existente |
| `PUT` | `/api/config/update/:userUUID` | Contraseña usuario | Actualiza configuración |
| `POST` | `/api/test-keys` | — | Valida claves de API (con rate limit) |
| `POST` | `/api/config/migrate` | — | Migra config de localStorage a base de datos |

**Ejemplo — cargar configuración:**
```bash
curl -X POST https://mi-instancia.com/api/config/load/mi-uuid \
  -H "Content-Type: application/json" \
  -d '{"password":"mi-contraseña"}'
```

### Endpoints de dashboard (requieren `x-admin-key`)

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/api/dashboard/auth/check` | Valida la clave de admin |
| `GET` | `/api/dashboard/overview` | Resumen del sistema (uptime, versión, salud) |
| `GET` | `/api/dashboard/stats` | Estadísticas rápidas de rendimiento |
| `GET` | `/api/dashboard/system` | Config del sistema y uso de recursos |
| `GET` | `/api/dashboard/operations` | Datos de operaciones y mantenimiento |
| `GET` | `/api/dashboard/logs` | Logs del servidor |
| `GET` | `/api/dashboard/analytics` | Analíticas de peticiones |
| `GET` | `/api/dashboard/users` | Lista de todos los usuarios |
| `DELETE` | `/api/admin/users/:uuid` | Elimina un usuario |

**Ejemplo — verificar autenticación:**
```bash
curl https://mi-instancia.com/api/dashboard/auth/check \
  -H "x-admin-key: mi-clave-de-admin"
# {"authenticated":true}
```

### Endpoints de MDBList

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/api/mdblist/user` | Información del usuario MDBList |
| `GET` | `/api/mdblist/lists/user` | Listas propias del usuario |
| `GET` | `/api/mdblist/lists/top` | Listas top de MDBList |
| `GET` | `/api/mdblist/lists/:username/:listname` | Lista específica por usuario y nombre |
| `GET` | `/api/mdblist/lists/:listId` | Lista por ID |

### Endpoints de TMDB

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/api/tmdb/list/:listId` | Detalles de una lista de TMDB |
| `GET` | `/api/tmdb/discover/reference` | Referencia de parámetros de Discover |
| `GET` | `/api/tmdb/discover/providers` | Proveedores de watch (por país) |
| `GET` | `/api/tmdb/discover/search/:entity` | Búsqueda de personas/compañías para Discover |
| `GET` | `/api/tmdb/discover/preview` | Vista previa de resultados de Discover |
| `POST` | `/api/tmdb/auth/request_token` | Inicia autenticación TMDB |
| `POST` | `/api/tmdb/auth/session` | Crea sesión TMDB con token aprobado |

### Endpoints de TVDB

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/api/tvdb/discover/reference` | Referencia de parámetros de Discover de TVDB |
| `GET` | `/api/tvdb/discover/search/:entity` | Búsqueda de entidades TVDB |
| `GET` | `/api/tvdb/discover/preview` | Vista previa de Discover TVDB |

### OAuth (Trakt, Simkl, AniList)

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/api/auth/trakt/authorize` | Inicia flujo OAuth de Trakt |
| `GET` | `/api/auth/trakt/callback` | Callback OAuth de Trakt |
| `POST` | `/api/auth/trakt/disconnect` | Desconecta cuenta de Trakt |
| `GET` | `/api/auth/simkl/authorize` | Inicia flujo OAuth de Simkl |
| `GET` | `/api/auth/simkl/callback` | Callback OAuth de Simkl |
| `POST` | `/api/auth/simkl/disconnect` | Desconecta cuenta de Simkl |
| `GET` | `/anilist/callback` | Callback OAuth de AniList |

### Caché y mantenimiento

| Método | Ruta | Descripción |
|---|---|---|
| `POST` | `/api/cache/warm` | Dispara calentamiento manual de caché |
| `GET` | `/api/cache/status` | Estado de la caché |
| `GET` | `/api/config/stats` | Estadísticas de configuraciones |

### Stremio — Rutas de addon

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/stremio/:uuid/manifest.json` | Manifest personalizado del usuario |
| `GET` | `/stremio/:uuid/catalog/:type/:id.json` | Catálogo |
| `GET` | `/stremio/:uuid/catalog/:type/:id/:extra.json` | Catálogo con filtros |
| `GET` | `/stremio/:uuid/meta/:type/:id.json` | Metadatos de un ítem |
| `GET` | `/stremio/:uuid/subtitles/:type/:id.json` | Subtítulos |

---

## 🛠️ Solución de Problemas

### El addon no aparece en Stremio

**Causa probable**: URL del manifest incorrecta o servidor no accesible desde internet.

**Solución**:
1. Verifica que el servidor responde: `curl https://tu-dominio.com/health`
2. Comprueba que `HOST_NAME` en el `.env` incluye el esquema `https://` y es accesible desde el exterior
3. Asegúrate de que el puerto está expuesto correctamente (o que el proxy inverso está configurado)
4. Confirma que la URL del manifest que copias termina en `/manifest.json`

### Errores de autenticación (401)

**Síntoma**: Los endpoints de dashboard devuelven `401 Unauthorized`.

**Causa**: El header `x-admin-key` falta o es incorrecto.

**Solución**: Asegúrate de que `ADMIN_KEY` en el `.env` coincide con la clave que introduces en la UI.

### Redis no disponible

**Síntoma**: El servidor arranca pero los logs muestran "Redis caching disabled".

**Causa**: Redis no está accesible en la URL configurada.

**Solución**:
1. Verifica que el servicio Redis está corriendo: `docker compose ps`
2. Comprueba `REDIS_URL` en el `.env` (debe ser `redis://nombre-servicio:6379`)
3. Asegúrate de que el servicio `aiometadata` tiene la dependencia correcta sobre `aiometadata_redis`

### Los catálogos aparecen vacíos

**Posibles causas y soluciones**:

| Causa | Solución |
|---|---|
| Clave de API inválida o expirada | Ve a `/configure` → Claves de API → usa el botón de validación |
| Catálogo desactivado | Activa el toggle junto al catálogo en la pestaña Catálogos |
| `showInHome` desactivado | Actívalo si quieres que aparezca sin seleccionar filtro |
| Rate limit de API externa | Espera unos minutos o reduce `CATALOG_LIST_ITEMS_SIZE` |
| Error de caché corrupta | Ve al dashboard → Operaciones → limpia la caché |

### Metadatos incorrectos o desactualizados

**Síntoma**: Los pósters, títulos o descripciones son incorrectos.

**Solución**:
1. El TTL de metadatos es 7 días por defecto. Puedes reducirlo con `META_TTL=86400`.
2. Ve al dashboard → Operaciones → "Clear Cache" para invalidar la caché del usuario
3. Verifica que el proveedor seleccionado en `/configure` → Proveedores es correcto para ese tipo de contenido

### El calentamiento de caché no funciona

**Síntoma**: El dashboard muestra que el calentamiento no ha corrido.

**Solución**:
1. Verifica que `ENABLE_CACHE_WARMING=true` (es el default)
2. Para el modo comprensivo, asegúrate de que `CACHE_WARMUP_UUID` tiene un UUID válido con configuración guardada
3. Comprueba las horas tranquilas: si `CATALOG_WARMUP_QUIET_HOURS_ENABLED=true`, el calentamiento no corre en ese rango horario
4. Revisa los logs: `docker compose logs aiometadata | grep "Cache Warming"`

### Búsqueda con IA no aparece

**Síntoma**: El catálogo "AI Search" no aparece en Stremio.

**Causa**: La búsqueda con IA requiere tres condiciones simultáneas:
1. `config.search.ai_enabled === true` (actívalo en `/configure` → Búsqueda)
2. Una clave válida de Gemini (`GEMINI_API_KEY` o clave en la configuración del usuario) o OpenRouter
3. El motor `gemini.search` no está desactivado explícitamente

### Errores de OAuth (Trakt / Simkl / AniList)

**Síntoma**: La autenticación OAuth redirige a una URL incorrecta.

**Solución**:
1. Verifica que `TRAKT_REDIRECT_URI` (o `SIMKL_REDIRECT_URI` / `ANILIST_REDIRECT_URI`) coincide exactamente con la URI registrada en la aplicación del proveedor
2. Asegúrate de que `HOST_NAME` está correctamente configurado con la URL pública del servidor
3. La URI debe ser exactamente `https://tu-dominio.com/api/auth/trakt/callback`

### El servidor consume demasiada memoria

**Síntoma**: El proceso Node.js crece en memoria con el tiempo.

**Solución**:
1. Activa el logging de heap para diagnosticar: `HEAP_LOG_INTERVAL_MIN=30`
2. Limita las peticiones concurrentes de metadatos: `META_CONCURRENCY=20`
3. Reduce las cachés en memoria: `FANART_CLIENT_CACHE_MAX=500`, `TMDB_SCRAPED_IMDB_CACHE_MAX=2000`
4. Ajusta la concurrencia de Trakt: `TRAKT_CONCURRENCY=5`

### Logs de diagnóstico

Para ver logs detallados temporalmente:
```env
LOG_LEVEL=debug
```

Para ver qué ocurre con la caché específicamente:
```bash
docker compose logs aiometadata | grep -E "\[Cache|Cache-Health|Global-Cache\]"
```

Para monitorear el calentamiento:
```bash
docker compose logs -f aiometadata | grep "Cache Warm"
```

---

*Documentación generada basándose en el código fuente de [github.com/aghermida/aiometadata](https://github.com/aghermida/aiometadata). Si encuentras algún error o algo ha cambiado en el código, actualiza esta documentación en consecuencia.*
