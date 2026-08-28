# REQUERIMIENTOS TÉCNICOS - AMBIENTE PREPRODUCCIÓN
## Despliegue Ecosistema Dockerizado KitchnTabs & Vanexa

**Solicitante:** Departamento TI  
**Fecha:** Agosto 2026  
**Ambiente:** Preproducción (Staging)  
**Proyectos:** KitchnTabs y Vanexa  
**Versión:** 1.0

---

## 📋 Tabla de Contenidos

- [Resumen Ejecutivo](#resumen-ejecutivo)
- [Arquitectura del Sistema](#arquitectura-del-sistema)
- [Especificaciones de Hardware](#especificaciones-de-hardware)
- [Configuración de Puertos](#configuración-de-puertos)
- [Servicios Docker](#servicios-docker)
- [Automatización y Monitoreo](#automatización-y-monitoreo)
- [Seguridad](#seguridad)
- [Plan de Migración](#plan-de-migración)
- [Formulario de Solicitud](#formulario-de-solicitud)

---

## Resumen Ejecutivo

Se requiere asignación de una **Máquina Virtual dedicada** para alojar el ecosistema de aplicaciones dockerizado con dos proyectos principales (KitchnTabs y Vanexa) en ambiente de preproducción.

### Cambio de Infraestructura

```mermaid
graph LR
    A["Servidor Mac Local<br/>(Dev/Staging actual)"] -->|Migración| B["VM Dedicada<br/>(Producción-like)"]
    
    A --> A1["Desarrollo local<br/>PM2 automation"]
    B --> B1["Preproducción 24/7<br/>Auto-recovery"]
    B --> B2["Cloudflare Tunnel<br/>Acceso público"]
    B --> B3["Backups automáticos<br/>Monitoreo"]
```

**El Sistema Requiere:**
- ✅ Máquina Virtual dedicada con 8 vCPU, 32 GB RAM, 500 GB SSD
- ✅ Docker Engine v24.x + Docker Compose v2.x
- ✅ PostgreSQL (2 instancias), Redis (2 instancias)
- ✅ Túnel Cloudflare para acceso público
- ✅ PM2 para automatización y recuperación
- ✅ Backups automáticos y monitoreo 24/7

---

## Arquitectura del Sistema

### Diagrama de Arquitectura General

```mermaid
graph TB
    subgraph Internet["🌐 INTERNET PÚBLICA"]
        Users["Usuarios/Clientes"]
    end
    
    subgraph CF["☁️ CLOUDFLARE"]
        WAF["WAF + DDoS<br/>SSL/TLS"]
        Tunnel["Reverse Proxy<br/>Tunnel Connector"]
    end
    
    subgraph VM["🖥️ MÁQUINA VIRTUAL<br/>Linux/macOS - 8vCPU, 32GB RAM, 500GB SSD"]
        subgraph KitchStack["KITCHNTABS STACK"]
            KApp["kitchntabs-app<br/>PHP-FPM + Nginx<br/>Puerto 25000"]
            KDB["kitchntabs-pgsql<br/>PostgreSQL<br/>Puerto 54321"]
            KRedis["kitchntabs-redis<br/>Redis<br/>Puerto 25379"]
            KMail["kitchntabs-mailhog<br/>MailHog<br/>Puerto 25025-26"]
        end
        
        subgraph VaneStack["VANEXA STACK"]
            VApp["vanexa-app<br/>PHP-FPM + Nginx<br/>Puerto 25100"]
            VDB["vanexa-pgsql<br/>PostgreSQL<br/>Puerto 25433"]
            VRedis["vanexa-redis<br/>Redis<br/>Puerto 25388"]
            VMail["vanexa-mailhog<br/>MailHog<br/>Puerto 25027-28"]
        end
        
        subgraph PM2["PM2 PROCESSES"]
            Watcher["dash-watcher<br/>Git Monitor"]
            TunnelProc["staging-tunnel<br/>Cloudflare"]
            Recovery["staging-recovery<br/>Actions"]
            LogTails["10 Log Tails<br/>Real-time Monitoring"]
        end
        
        KApp --> KDB
        KApp --> KRedis
        VApp --> VDB
        VApp --> VRedis
    end
    
    Users -->|HTTPS 443| WAF
    WAF --> Tunnel
    Tunnel -->|localhost:25000-26001| KApp
    Tunnel -->|localhost:25100+| VApp
```

### Flujo de Solicitud HTTP

```mermaid
sequenceDiagram
    participant User as Cliente Web
    participant CF as Cloudflare<br/>Tunnel
    participant Docker as Docker<br/>Network
    participant Nginx as Nginx<br/>Reverse Proxy
    participant FPM as PHP-FPM
    participant DB as PostgreSQL
    participant Redis as Redis
    
    User->>CF: HTTPS GET /api/users
    CF->>Docker: localhost:25000
    Docker->>Nginx: Ruta request
    Nginx->>FPM: FastCGI call
    FPM->>Redis: Check cache
    alt Cache Hit
        Redis-->>FPM: Datos cacheados
    else Cache Miss
        FPM->>DB: Query datos
        DB-->>FPM: Resultados
        FPM->>Redis: Store cache
    end
    FPM-->>Nginx: JSON Response
    Nginx-->>CF: HTTP 200 + Body
    CF-->>User: HTTPS 200 + Body
```

### Flujo WebSocket (Reverb)

```mermaid
graph TB
    Client["🖥️ Cliente Web<br/>(Browser)"]
    CF["Cloudflare<br/>wss://"]
    Reverb["Reverb Server<br/>Puerto 6001"]
    Redis["Redis<br/>Pub/Sub"]
    App["Laravel App<br/>Broadcasting"]
    
    Client -->|"WSS<br/>ws-staging.kitchntabs.com"| CF
    CF -->|Proxy| Reverb
    Reverb -->|Subscribe| Redis
    App -->|Publish Event| Redis
    Redis -->|Broadcast| Reverb
    Reverb -->|Push| Client
    
    style Client fill:#e1f5ff
    style CF fill:#fff3e0
    style Reverb fill:#f3e5f5
    style Redis fill:#e8f5e9
    style App fill:#fce4ec
```

---

## Especificaciones de Hardware

### Recursos de Máquina Virtual

| Parámetro | Requerimiento | Justificación |
|---|---|---|
| **vCPU** | 8 (mínimo) | 4 apps Node.js + Docker daemon + servicios |
| **RAM** | 32 GB | Docker VM + 4 contenedores + BD + caché |
| **Storage** | 500 GB SSD | BD (100GB c/u), logs, assets, backups |
| **Tipo Storage** | NVMe RAID 1 | Performance + redundancia |
| **Red** | Gigabit (1 Gbps) | Comunicación intra-contenedores + tráfico externo |

### Distribución de Recursos

```mermaid
graph LR
    CPU["8 vCPU"]
    RAM["32 GB RAM"]
    SSD["500 GB SSD"]
    
    CPU --> C1["PHP-FPM (2)"]
    CPU --> C2["DB (2)"]
    CPU --> C3["Redis (2)"]
    CPU --> C4["PM2/Docker (2)"]
    
    RAM --> R1["kitchntabs-app: 4GB"]
    RAM --> R2["vanexa-app: 4GB"]
    RAM --> R3["PostgreSQL: 8GB c/u"]
    RAM --> R4["Redis: 2GB c/u"]
    RAM --> R5["Buffer/Sistema: 4GB"]
    
    SSD --> S1["DB KitchnTabs: 50GB"]
    SSD --> S2["DB Vanexa: 50GB"]
    SSD --> S3["Redis/Caché: 5GB"]
    SSD --> S4["Logs/Assets: 40GB"]
    SSD --> S5["Espacio Libre: 200GB"]
    
    style CPU fill:#bbdefb
    style RAM fill:#c8e6c9
    style SSD fill:#ffe0b2
```

---

## Configuración de Puertos

### Puertos Internos (Docker)

```mermaid
graph TB
    subgraph Kit["KITCHNTABS"]
        K1["25000 - App HTTP"]
        K2["25001 - Reverb WS"]
        K3["25010 - API Docs"]
        K4["25025 - MailHog SMTP"]
        K5["25026 - MailHog UI"]
        K6["54321 - PostgreSQL"]
        K7["25379 - Redis"]
    end
    
    subgraph Van["VANEXA"]
        V1["25100 - App HTTP"]
        V2["26001 - Reverb WS"]
        V3["25027 - MailHog SMTP"]
        V4["25028 - MailHog UI"]
        V5["25433 - PostgreSQL"]
        V6["25388 - Redis"]
    end
    
    subgraph Shared["COMPARTIDOS"]
        S1["443 - Cloudflare HTTPS"]
        S2["80 - Redireccionamiento"]
        S3["22 - SSH Admin"]
    end
```

### Reglas de Firewall Requeridas

| Dirección | Puerto | Protocolo | Origen/Destino | Persistencia |
|---|---|---|---|---|
| **ENTRADA** |  |  |  |  |
|  | 443 (HTTPS) | TCP | Internet (0.0.0.0/0) | Permanente |
|  | 80 (HTTP) | TCP | Internet (0.0.0.0/0) | Permanente |
|  | 22 (SSH) | TCP | IPs autorizadas | Permanente |
| **SALIDA** |  |  |  |  |
|  | 443 (HTTPS) | TCP | Internet (0.0.0.0/0) | Permanente |
|  | 53 (DNS) | UDP/TCP | 8.8.8.8, 1.1.1.1 | Permanente |
|  | * (Todas) | TCP | Repos, npm, Composer | Permanente |

---

## Servicios Docker

### Stack de Contenedores

```mermaid
graph TB
    subgraph Kit["KITCHNTABS"]
        KA["📦 kitchntabs-app<br/>PHP-FPM 8.2 + Nginx<br/>Restart: unless-stopped"]
        KDB["🗄️ kitchntabs-pgsql<br/>PostgreSQL 15+<br/>Restart: unless-stopped"]
        KR["⚡ kitchntabs-redis<br/>Redis:alpine<br/>Restart: unless-stopped"]
        KM["📧 kitchntabs-mailhog<br/>MailHog:latest<br/>Restart: unless-stopped"]
        KD["📚 api-docs<br/>Nginx:alpine<br/>Restart: unless-stopped"]
    end
    
    subgraph Van["VANEXA"]
        VA["📦 vanexa-app<br/>PHP-FPM 8.2 + Nginx<br/>Restart: unless-stopped"]
        VDB["🗄️ vanexa-pgsql<br/>PostgreSQL 15+<br/>Restart: unless-stopped"]
        VR["⚡ vanexa-redis<br/>Redis:alpine<br/>Restart: unless-stopped"]
        VM["📧 vanexa-mailhog<br/>MailHog:latest<br/>Restart: unless-stopped"]
    end
    
    subgraph Network["Docker Network: dash"]
        direction LR
        style Network fill:#e0f2f1
    end
    
    KA --> KDB
    KA --> KR
    KA -.-> KM
    VA --> VDB
    VA --> VR
    VA -.-> VM
    
    KA --> Network
    KDB --> Network
    KR --> Network
    VA --> Network
    VDB --> Network
    VR --> Network
```

### Servicios dentro de kitchntabs-app

```mermaid
graph TB
    subgraph "kitchntabs-app (supervisor)"
        PHP["🔷 PHP-FPM<br/>FastCGI Processor<br/>Workers: Auto-scaled"]
        NGX["🌐 Nginx<br/>Web Server<br/>Port 80"]
        HORIZON["📬 Horizon<br/>Queue Worker<br/>Redis backend"]
        REVERB["📡 Reverb<br/>WebSocket Server<br/>Port 6001"]
        SCHEDULER["⏰ Scheduler<br/>Cron tasks<br/>* * * * *"]
        LOGROTATE["📋 Logrotate<br/>Log rotation<br/>Daily"]
    end
    
    style PHP fill:#bbdefb
    style NGX fill:#c8e6c9
    style HORIZON fill:#ffe0b2
    style REVERB fill:#f8bbd0
    style SCHEDULER fill:#d1c4e9
    style LOGROTATE fill:#b2dfdb
```

---

## Almacenamiento y Volúmenes

### Estructura de Almacenamiento

```mermaid
graph TB
    Root["/opt/applications/dash-backend-docker/"]
    
    Storage["storage/"]
    Kit["kitchntabs-backend-domain/"]
    Van["vanexa-backend-domain/"]
    
    KitData["pgsql-data/<br/>(50GB PostgreSQL)"]
    KitCache["redis-data/"]
    KitLogs["logs/laravel.log"]
    KitAssets["uploads/"]
    
    VanData["pgsql-data/<br/>(50GB PostgreSQL)"]
    VanCache["redis-data/"]
    VanLogs["logs/laravel.log"]
    VanAssets["uploads/"]
    
    Root --> Storage
    Storage --> Kit
    Storage --> Van
    Kit --> KitData
    Kit --> KitCache
    Kit --> KitLogs
    Kit --> KitAssets
    Van --> VanData
    Van --> VanCache
    Van --> VanLogs
    Van --> VanAssets
    
    style Root fill:#fff9c4
    style Storage fill:#ffe0b2
    style Kit fill:#e1bee7
    style Van fill:#bbdefb
```

### Volúmenes Docker

| Tipo | Nombre | Montaje | Tamaño | Persistencia |
|---|---|---|---|---|
| **Named Volume** | `dash-redis` | `/data` | 2 GB | Entre reboots |
| **Named Volume** | `dash-composer-cache` | `/.composer` | 1 GB | Entre reboots |
| **Bind Mount** | `./storage/kitchntabs/` | `/var/www/dash/storage` | 50 GB | Permanente (host) |
| **Bind Mount** | `./storage/vanexa/` | `/var/www/dash/storage` | 50 GB | Permanente (host) |

---

## Automatización y Monitoreo

### Procesos PM2

```mermaid
graph TB
    PM2["PM2 Process Manager<br/>(Supervisor)"]
    
    WATCH["dash-watcher<br/>Git Monitor<br/>Polls: 60s"]
    TUNNEL["staging-tunnel<br/>Cloudflare Connector<br/>Status: Online"]
    RECOVERY["staging-recovery<br/>Emergency Actions<br/>Idle + Listening"]
    
    KL["kitchntabs-laravel-log<br/>App logs"]
    KH["kitchntabs-horizon-log<br/>Queue logs"]
    KR["kitchntabs-reverb-log<br/>WebSocket logs"]
    KA["kitchntabs-ai-agents-log<br/>AI tracking"]
    KC["kitchntabs-container-log<br/>Docker stdout"]
    
    VL["vanexa-laravel-log<br/>App logs"]
    VH["vanexa-horizon-log<br/>Queue logs"]
    VR["vanexa-reverb-log<br/>WebSocket logs"]
    VA["vanexa-ai-agents-log<br/>AI tracking"]
    VC["vanexa-container-log<br/>Docker stdout"]
    
    PM2 --> WATCH
    PM2 --> TUNNEL
    PM2 --> RECOVERY
    PM2 --> KL
    PM2 --> KH
    PM2 --> KR
    PM2 --> KA
    PM2 --> KC
    PM2 --> VL
    PM2 --> VH
    PM2 --> VR
    PM2 --> VA
    PM2 --> VC
    
    style PM2 fill:#fff9c4
    style WATCH fill:#e1bee7
    style TUNNEL fill:#c8e6c9
    style RECOVERY fill:#ffccbc
    style KL fill:#bbdefb
    style VL fill:#b2dfdb
```

### Dashboard PM2 Monit

```
┌────────────────────────────────────────────────────────────┐
│ PM2 MONIT - Real-time Monitoring                           │
├────────────────────────────────────────────────────────────┤
│                                                             │
│ Name                    Mode  Status  CPU   Memory          │
│ ─────────────────────────────────────────────────────────  │
│ dash-watcher            fork  online  0.2%  45 MB           │
│ staging-tunnel          fork  online  0.5%  120 MB          │
│ staging-recovery        fork  online  0.0%  30 MB           │
│ kitchntabs-laravel-log  fork  online  0.1%  15 MB           │
│ kitchntabs-horizon-log  fork  online  0.1%  12 MB           │
│ kitchntabs-reverb-log   fork  online  0.2%  18 MB           │
│ kitchntabs-ai-agents-log fork  online  0.0%  8 MB            │
│ kitchntabs-container-log fork  online  0.1%  12 MB           │
│ vanexa-laravel-log      fork  online  0.1%  15 MB           │
│ vanexa-horizon-log      fork  online  0.1%  12 MB           │
│ vanexa-reverb-log       fork  online  0.2%  18 MB           │
│ vanexa-ai-agents-log    fork  online  0.0%  8 MB            │
│ vanexa-container-log    fork  online  0.1%  12 MB           │
│                                                             │
└────────────────────────────────────────────────────────────┘
```

### Acciones de Recuperación Disponibles

```mermaid
graph LR
    Recovery["staging-recovery<br/>Emergency Actions"]
    
    Restart["restart:supervisor<br/>Reinicia Horizon,<br/>Reverb, Scheduler"]
    Horizon["restart:horizon<br/>Reinicia solo<br/>procesador de colas"]
    Reverb["restart:reverb<br/>Reinicia solo<br/>WebSocket"]
    Cache["clear:cache<br/>Limpia config<br/>y caché"]
    Migrate["migrate<br/>Ejecuta<br/>migraciones"]
    Docker["restart:docker<br/>Reinicia contenedor<br/>ÚLTIMO RECURSO"]
    
    Recovery --> Restart
    Recovery --> Horizon
    Recovery --> Reverb
    Recovery --> Cache
    Recovery --> Migrate
    Recovery --> Docker
    
    style Restart fill:#ffccbc
    style Horizon fill:#ffccbc
    style Reverb fill:#ffccbc
    style Cache fill:#fff9c4
    style Migrate fill:#fff9c4
    style Docker fill:#ef9a9a
```

---

## Seguridad

### Arquitectura de Seguridad por Capas

```mermaid
graph TB
    subgraph "CAPA 1: Perímetro Internet"
        L1["🔐 Cloudflare WAF<br/>Filtra tráfico malicioso"]
        L1B["🛡️ DDoS Protection<br/>Rate limiting"]
        L1C["🔒 SSL/TLS 1.3<br/>Encriptación"]
    end
    
    subgraph "CAPA 2: Acceso VM"
        L2["🔑 SSH Key Auth<br/>Sin passwords"]
        L2B["🚪 Firewall (ufw)<br/>Whitelist IPs"]
        L2C["🚫 fail2ban<br/>Brute-force protection"]
    end
    
    subgraph "CAPA 3: Aplicación"
        L3["🐳 Network Isolation<br/>Docker bridge"]
        L3B["📝 Role-based Access<br/>Permisos granulares"]
        L3C["✅ Input Validation<br/>Laravel sanitization"]
    end
    
    subgraph "CAPA 4: Base de Datos"
        L4["👤 Restricted DB User<br/>Permisos app-only"]
        L4B["🔐 Encrypted Backups<br/>Almacenamiento seguro"]
        L4C["📊 Audit Logging<br/>Queries registradas"]
    end
    
    L1 --> L2
    L2 --> L3
    L3 --> L4
```

### Manejo de Secretos

| Secreto | Ubicación | Rotación | Acceso |
|---|---|---|---|
| DB Passwords | Bóveda corporativa | Semestral | Solo TI |
| API Keys | Bóveda corporativa | Anual | Solo app |
| SSH Keys | ~/.ssh/ (640) | Según política | Usuario |
| CF Tokens | ~/.cloudflared/ (600) | Anual | PM2 process |
| App Key | Variables sistema | Generado | Contenedor |

### Backups y Recuperación

```mermaid
graph TB
    DB1["PostgreSQL<br/>KitchnTabs"]
    DB2["PostgreSQL<br/>Vanexa"]
    Storage["Storage/<br/>Assets & Logs"]
    
    Backup["🔄 Backup Scheduler<br/>Daily 00:00 UTC"]
    
    DB1 --> Backup
    DB2 --> Backup
    Storage --> Backup
    
    Backup --> Local["Local<br/>Snapshots<br/>7 días"]
    Backup --> Remote["Remote<br/>NAS/S3<br/>30+ días"]
    
    Remote --> Verify["✅ Verify Restore<br/>Monthly"]
    
    style Backup fill:#e1bee7
    style Local fill:#fff9c4
    style Remote fill:#c8e6c9
    style Verify fill:#bbdefb
```

---

## Plan de Migración

### Fases de Implementación

```mermaid
graph LR
    P1["FASE 1<br/>Preparación<br/>Semana 1"]
    P2["FASE 2<br/>Configuración<br/>Semana 2"]
    P3["FASE 3<br/>Migración Datos<br/>Semana 2-3"]
    P4["FASE 4<br/>Tunnels<br/>Semana 3"]
    P5["FASE 5<br/>Automatización<br/>Semana 3-4"]
    P6["FASE 6<br/>Testing<br/>Semana 4"]
    
    P1 --> P2
    P2 --> P3
    P3 --> P4
    P4 --> P5
    P5 --> P6
    
    style P1 fill:#bbdefb
    style P2 fill:#c8e6c9
    style P3 fill:#ffe0b2
    style P4 fill:#f8bbd0
    style P5 fill:#d1c4e9
    style P6 fill:#b2dfdb
```

### Checklist de Implementación

#### Fase 1: Preparación
- [ ] Solicitud de VM aprobada por TI
- [ ] VM aprovisionada (8 vCPU, 32 GB, 500 GB SSD)
- [ ] Acceso SSH configurado (key-only)
- [ ] Volúmenes de almacenamiento montados
- [ ] Firewall configurado (443, 80, 22)

#### Fase 2: Configuración
- [ ] Docker Engine v24.x instalado
- [ ] Docker Compose v2.x instalado
- [ ] Node.js 18.x + pnpm instalados
- [ ] PM2 instalado globalmente
- [ ] Archivos `.env.*.staging` transferidos (SEGURO)

#### Fase 3: Migración de Datos
- [ ] Backup de BD producción obtenido
- [ ] PostgreSQL iniciado en ambos proyectos
- [ ] Datos restaurados en staging
- [ ] Verificación de integridad BD
- [ ] Redis inicializado

#### Fase 4: Tuneles y Networking
- [ ] Cloudflare tunnel creado (`kitchntabs-staging-server`)
- [ ] Token almacenado en `~/.cloudflared/`
- [ ] DNS configurado (4 dominios)
- [ ] Test: `curl https://api-staging.kitchntabs.com` ✓
- [ ] Test: WebSocket connectivity ✓

#### Fase 5: Automatización
- [ ] PM2 startup script configurado
- [ ] Auto-login habilitado (si macOS)
- [ ] Docker restart policies verificadas
- [ ] PM2 processes salvados
- [ ] Test de reboot completo

#### Fase 6: Testing
- [ ] Pruebas funcionales completas
- [ ] Pruebas de carga básicas (1000 req/s)
- [ ] Logs accesibles vía `pm2 monit`
- [ ] Alertas configuradas
- [ ] Documentación actualizada

---

## Diagrama de Flujo de Recuperación

```mermaid
graph TD
    A["⚠️ SITIO RETORNA 502"] --> B{"¿Tunnel<br/>conectado?"}
    
    B -->|No| C["ps aux | grep cloudflared"]
    C -->|Proceso muerto| D["Reiniciar staging-tunnel"]
    D --> Z1["✅ Resuelto"]
    
    B -->|Sí| E{"¿Docker<br/>containers<br/>activos?"}
    
    E -->|No| F["docker ps"]
    F -->|No running| G["docker compose up -d"]
    G --> Z2["✅ Resuelto"]
    
    E -->|Sí| H{"¿PostgreSQL<br/>healthy?"}
    
    H -->|No| I["docker logs pgsql"]
    I --> J["Diagnóstico DB"]
    
    H -->|Sí| K{"¿Redis<br/>connected?"}
    
    K -->|No| L["docker compose restart redis"]
    L --> Z3["✅ Resuelto"]
    
    K -->|Sí| M["Revisar Laravel logs"]
    M --> N{"¿Error<br/>visible?"}
    
    N -->|Sí| O["Fix error específico"]
    O --> Z4["✅ Resuelto"]
    
    N -->|No| P["Limpiar caché"]
    P --> Q["artisan optimize:clear"]
    Q --> R["¿Aún falla?"]
    
    R -->|Sí| S["🚨 ÚLTIMO RECURSO"]
    S --> T["pm2 trigger staging-recovery<br/>restart:docker"]
    T --> U["DOWNTIME ~30s"]
    T --> Z5["✅ Resuelto"]
    
    R -->|No| Z6["✅ Resuelto"]
    
    style A fill:#ef9a9a
    style Z1 fill:#a5d6a7
    style Z2 fill:#a5d6a7
    style Z3 fill:#a5d6a7
    style Z4 fill:#a5d6a7
    style Z5 fill:#a5d6a7
    style Z6 fill:#a5d6a7
    style S fill:#ef9a9a
    style U fill:#fff9c4
```

---

## Requisitos de Red y Conectividad

### Ancho de Banda Estimado

| Tráfico | Estimado | Tipo | Prioridad |
|---|---|---|---|
| Entrada HTTP/HTTPS | 1-5 Mbps promedio | Variable | Alta |
| Salida (API, webhooks) | 0.5-2 Mbps | Variable | Alta |
| Sincronización código (Git) | 100 Mbps ráfagas | Ocasional | Media |
| Dependencias (npm/composer) | 50 Mbps ráfagas | En deploys | Media |
| **Recomendación** | **100 Mbps dedicados** | Mínimo | - |

### Latencia Aceptable

```
Hacia Cloudflare:    < 50 ms
Intra-contenedores:  < 1 ms
PostgreSQL:          < 10 ms
Redis:               < 1 ms
DNS resolution:      < 50 ms
```

---

## Software Requerido

### Sistema Operativo

- **Recomendado:** Ubuntu 22.04 LTS (servidor)
- **Alternativa:** macOS 12+ (desarrollo permanente)

### Paquetes Obligatorios

```bash
# Ubuntu 22.04 LTS
docker.io                 # Docker Engine v24+
docker-compose            # v2.x
git                       # Control de versiones
curl, wget                # HTTP clients
nodejs                    # 18.x LTS (para PM2)
npm, pnpm                 # Package managers
openssh-server            # Acceso remoto
ufw                       # Firewall
fail2ban                  # Brute-force protection
htop                      # Monitoreo
rsync                     # Backups
```

### Imágenes Docker Requeridas

| Imagen | Versión | Uso |
|---|---|---|
| `local/dash-backend-core` | latest | App container (PHP 8.2) |
| `postgres` | latest (15+) | Base de datos |
| `redis` | alpine | Caché y colas |
| `mailhog/mailhog` | latest | Email testing |
| `nginx` | alpine | Documentación API |

---

## Configuración de Aplicación

### Variables de Entorno Requeridas

**Archivo: `.env.kitchntabs.staging`**
```env
# Database
DB_HOST=pgsql
DB_PORT=5432
DB_DATABASE=kitchntabs
DB_USERNAME=sail
DB_PASSWORD=[CONTRASEÑA_SEGURA_32_CARACTERES]

# Application
APP_ENV=staging
APP_KEY=[LARAVEL_GENERATED_KEY]
APP_URL=https://api-staging.kitchntabs.com

# WebSocket (Reverb)
REVERB_HOST=ws-staging.kitchntabs.com
REVERB_PORT=443
REVERB_SCHEME=https

# Redis
REDIS_HOST=redis
REDIS_PORT=6379
```

**Archivo: `.env.vanexa.staging`**
```env
# Idéntico a kitchntabs pero con:
DB_DATABASE=vanexa
APP_URL=https://api-staging.vanexa.cl
REVERB_HOST=ws-staging.vanexa.cl
```

---

## Métricas y Monitoreo

### KPIs del Sistema

```mermaid
graph TB
    Metrics["📊 MÉTRICAS DEL SISTEMA"]
    
    Availability["Disponibilidad<br/>Target: 99%<br/>SLA: < 1h/mes downtime"]
    Performance["Performance<br/>Response: < 500ms<br/>DB: < 50ms"]
    Reliability["Confiabilidad<br/>Job success: > 99%<br/>Crashes: < 1/mes"]
    Capacity["Capacidad<br/>CPU: < 70%<br/>RAM: < 75%"]
    
    Metrics --> Availability
    Metrics --> Performance
    Metrics --> Reliability
    Metrics --> Capacity
    
    style Metrics fill:#fff9c4
    style Availability fill:#bbdefb
    style Performance fill:#c8e6c9
    style Reliability fill:#f8bbd0
    style Capacity fill:#ffe0b2
```

### Alertas Recomendadas

| Métrica | Umbral | Severidad |
|---|---|---|
| CPU utilization | > 80% por 5 min | ALTO |
| Memoria disponible | < 10% libre | ALTO |
| Espacio disco | < 10% libre | CRÍTICO |
| Endpoint 502/503 | > 5 en 5 min | CRÍTICO |
| Response time p95 | > 2s | ALTO |
| Job failed rate | > 5 por hora | ALTO |
| Tunnel desconectado | > 2 min | CRÍTICO |
| DB Connection pool | > 80% usado | MEDIO |

---

## Roadmap Futuro

```mermaid
graph LR
    Now["NOW<br/>Docker Compose<br/>Single VM"]
    
    Q4["Q4 2026<br/>Prometheus +<br/>Grafana"]
    Q1["Q1 2027<br/>ELK Stack<br/>Logs centralizados"]
    Q2["Q2 2027<br/>Kubernetes<br/>Orchestration"]
    Q3["Q3 2027<br/>Multi-region<br/>Disaster Recovery"]
    
    Now --> Q4
    Q4 --> Q1
    Q1 --> Q2
    Q2 --> Q3
    
    style Now fill:#fff9c4
    style Q4 fill:#bbdefb
    style Q1 fill:#c8e6c9
    style Q2 fill:#f8bbd0
    style Q3 fill:#ffe0b2
```

---

# 📝 FORMULARIO DE SOLICITUD - DEPARTAMENTO TI

**Para ser completado y enviado a:** `[email_TI@departamento]`

---

## PARTE I: INFORMACIÓN DE LA SOLICITUD

### Datos del Solicitante

```
Nombre Completo:        _________________________________
Departamento:           _________________________________
Correo Electrónico:     kitchntabs@gmail.com
Teléfono:              _________________________________
Fecha de Solicitud:     _________________________________
```

### Información del Proyecto

```
Nombre del Proyecto:    Preproducción KitchnTabs & Vanexa

Descripción Breve:      Despliegue de ecosistema dockerizado en 
                        ambiente de staging/preproducción para 
                        validación pre-release

Duración Requerida:     Permanente (24/7 crítico)

Prioridad:             [  ] Alta  [  ] Media  [  ] Baja
```

---

## PARTE II: ESPECIFICACIONES TÉCNICAS

### Máquina Virtual Requerida

```
☑ Tipo:                 Máquina Virtual dedicada
☑ Hypervisor:           [  ] VMware  [  ] KVM  [  ] Hyper-V
☑ Sistema Operativo:    [  ] Ubuntu 22.04 LTS  [  ] CentOS  [  ] macOS 12+
☑ CPU:                  8 vCPU mínimo
☑ RAM:                  32 GB mínimo
☑ Almacenamiento:       500 GB SSD NVMe (RAID 1 recomendado)
☑ Red:                  Gigabit (1 Gbps) dedicado
☑ IP Pública:           Sí (requerida para Cloudflare Tunnel)
```

### Software a Instalar

**Obligatorio:**
- [ ] Docker Engine v24.x
- [ ] Docker Compose v2.x
- [ ] Git
- [ ] curl, wget, net-tools, htop
- [ ] openssh-server
- [ ] ufw (firewall)
- [ ] fail2ban (seguridad)
- [ ] Node.js 18.x LTS
- [ ] pnpm 8.x

---

## PARTE III: CONFIGURACIÓN DE RED

### Puertos a Abrir en Firewall

**ENTRADA:**
```
☑ Puerto 443 (HTTPS)        Desde 0.0.0.0/0         [Permanente]
☑ Puerto 80 (HTTP)          Desde 0.0.0.0/0         [Permanente]
☑ Puerto 22 (SSH)           Desde [IPs autorizadas] [Permanente]
```

**SALIDA:**
```
☑ Todos los puertos         Hacia 0.0.0.0/0         [Permanente]
  (Requerido para Docker pull, npm, composer, Cloudflare)
```

### DNS y Resolución

```
Dominios a Configurar (Cloudflare DNS):
  ☑ api-staging.kitchntabs.com
  ☑ ws-staging.kitchntabs.com
  ☑ api-staging.vanexa.cl
  ☑ ws-staging.vanexa.cl
```

---

## PARTE IV: ALMACENAMIENTO Y BACKUP

### Volúmenes Requeridos

```
Punto de Montaje Principal:  /opt/applications/dash-backend-docker/
Tipo:                        SSD NVMe
Tamaño Total:               500 GB
RAID:                       RAID 1 (espejo recomendado)
```

### Política de Backups

```
☑ Backup Automático:       Sí - Diariamente
☑ Horario Backup:          00:00 UTC
☑ Destino:                 [NAS / S3 / Sistema backup corporativo]
☑ Retención Backups:       30 días diarios + 90 días semanales
☑ RTO (Recovery Time):     < 1 hora
☑ RPO (Recovery Point):    < 1 día
```

**Datos a Respaldar:**
- PostgreSQL (KitchnTabs + Vanexa)
- Volúmenes de almacenamiento (`./storage/`)
- Configuración de aplicación

---

## PARTE V: SEGURIDAD

### Requisitos de Acceso

```
SSH:
  ☑ Autenticación:    Clave privada SSH (RSA 4096 o Ed25519)
  ☑ Usuarios:         [Especificar usernames]
  ☑ Sudoers:          Acceso sudo requerido
  ☑ Restricción IP:   Solo desde IPs autorizadas

Credenciales:
  ☑ Almacenamiento:   Gestor de secretos corporativo
  ☑ DB Passwords:     Mínimo 32 caracteres
  ☑ Rotación:         Semestral
```

### Monitoreo de Seguridad

```
☑ fail2ban:                Habilitado (protección SSH)
☑ Firewall (ufw):          Habilitado con whitelist
☑ Audit Logging:           Habilitado en PostgreSQL
☑ Alertas:                 Configadas para fallos de autenticación
```

---

## PARTE VI: MONITOREO Y ALERTAS

### Métricas Críticas

```
☑ CPU utilización         Alerta si > 80%
☑ Memoria utilización     Alerta si > 85%
☑ Espacio disco           Alerta si < 10% libre
☑ Disponibilidad HTTP     Health check cada 60s
☑ Response time           Alerta si > 2s
☑ Errores aplicativos     Alerta si rate > 1/min
```

### Canales de Notificación

```
☐ Email:        kitchntabs@gmail.com
☐ Slack:        [Webhook URL]
☐ PagerDuty:    [Integración URL]
☐ Otro:         [Especificar]
```

---

## PARTE VII: APROBACIÓN

### Checklist Pre-Implementación

```
VALIDACIÓN:
  ☐ Especificaciones revisadas por TI
  ☐ Capacidad de infraestructura confirmada
  ☐ Política de backup validada
  ☐ Seguridad revisada
  
APROBACIÓN:
  ☐ Gerente TI:           _____________________ Fecha: ______
  ☐ Responsable Seguridad: _____________________ Fecha: ______
  ☐ Responsable Proyecto:  _____________________ Fecha: ______

CRONOGRAMA:
  Fase 1 - Preparación:      [Semana 1]
  Fase 2 - Configuración:    [Semana 2]
  Fase 3 - Migración Datos:  [Semana 2-3]
  Fase 4 - Tunnels:          [Semana 3]
  Fase 5 - Automatización:   [Semana 3-4]
  Fase 6 - Testing:          [Semana 4]
  
  Fecha Objetivo Go-Live:    _________________________________
```

---

## Contacto y Soporte

**Responsable Proyecto:**
- Email: kitchntabs@gmail.com
- Documentación: `PM2_AUTOMATION.md`, `README.md`
- Repositorio: `dash-backend-docker`

**Escalación Técnica:**
- Contacto TI: [A definir por departamento]
- Teléfono: [A definir]
- Horario: Lunes-Viernes 9:00-18:00 UTC

---

**Documento preparado:** Agosto 2026  
**Versión:** 1.0  
**Estado:** Listo para envío a departamento TI
