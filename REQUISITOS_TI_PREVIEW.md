# Ambiente Preview — Requisitos para el Departamento de TI

Qué necesita el equipo de desarrollo de TI para dejar operativo un ambiente **preview** de
KitchnTabs y Vanexa en una máquina dedicada. Este documento es autocontenido: describe lo que
TI debe proveer (máquina, firewall, DNS, salida a internet). El procedimiento de instalación
que ejecuta el ingeniero está en [SETUP.md](./SETUP.md) (Parte 2), en inglés.

> Los nombres de host (`api-preview.*`, `ws-preview.*`) son **propuestas**. Se ruegan confirmar
> con TI antes de comenzar; todo el resto se parametriza según los nombres finales.

---

## 1. Qué se va a alojar

Dos backends independientes en una misma máquina; cada uno expone una API y un servidor de
WebSocket (Laravel Reverb):

| Producto | Host público API | Host público WebSocket | Puerto local API | Puerto local WebSocket |
|---|---|---|---|---|
| KitchnTabs | `api-preview.kitchntabs.com` | `ws-preview.kitchntabs.com` | 25000 | 25001 |
| Vanexa | `api-preview.vanexa.cl` | `ws-preview.vanexa.cl` | 25100 | 26001 |

Los cuatro hosts se sirven por HTTPS en el puerto 443. Los navegadores y las apps móviles
consumen la API por HTTPS y mantienen una conexión `wss://` de larga duración con el host de
WebSocket.

## 2. Forma de exposición recomendada: Cloudflare Tunnel (sin puertos de entrada)

El servidor de staging actual **no acepta ninguna conexión entrante desde internet**. Un
servicio pequeño, `cloudflared`, abre conexiones **salientes** hacia Cloudflare, y Cloudflare
reenvía por ellas el tráfico HTTPS/WSS público hacia `localhost` en la máquina. Cloudflare
termina TLS y aporta protección DDoS/WAF.

Consecuencias para TI:

- **No es necesario abrir ningún puerto de entrada** en el firewall ni en el router para el
  tráfico web, API o WebSocket.
- **No se requiere IP pública, regla NAT, balanceador ni certificado** para los cuatro hosts.
- Los cuatro nombres DNS deben estar en una **zona administrada por Cloudflare**
  (`kitchntabs.com` y `vanexa.cl` ya lo están). No se puede crear un registro proxied hacia un
  túnel en una zona alojada en otro proveedor DNS.

Si la política corporativa no permite Cloudflare Tunnel, usar la alternativa de exposición
directa de la sección 7.

## 3. Máquina

| Ítem | Requisito |
|---|---|
| Tipo | VM dedicada o servidor físico, encendido 24/7 |
| CPU / RAM / disco | 8 vCPU, 32 GB RAM, 500 GB SSD (mismo dimensionamiento que [REQUERIMIENTOS_PREPRODUCCION.md](./REQUERIMIENTOS_PREPRODUCCION.md)) |
| Sistema operativo | Ubuntu 24.04 LTS (u otro Linux vigente con systemd) |
| Docker | Docker Engine 24+ con Compose v2, habilitado al arranque |
| Otro software | `git`, Node.js 20+ y `pnpm`, `cloudflared`, `curl`, `jq`, `chrony`/NTP |
| Cuentas | Un usuario de servicio (no root) en el grupo `docker`, con acceso SSH por deploy key a los repositorios de GitHub |
| Hora | Sincronizada por NTP. Un desfase de reloj rompe TLS y el registro del túnel. |
| Autoarranque | Docker y los servicios de la Parte 2 de SETUP.md deben iniciar al arrancar, sin que nadie inicie sesión |

## 4. Firewall — entrada

| Puerto | Proto | Origen | Propósito | Requerido |
|---|---|---|---|---|
| 22 | TCP | Solo IPs de administración / VPN | Administración (solo llave, sin login por contraseña) | Sí |
| 80, 443 u otro | — | — | — | **No** (con Cloudflare Tunnel) |

**Importante — Docker se salta los firewalls del host.** El archivo compose publica los puertos
de base de datos, Redis y correo en todas las interfaces (`0.0.0.0:25432`, `25379`, `25433`,
`25388`, `25025-25028`, …). Docker inserta sus propias reglas de iptables antes que las de
`ufw`/`firewalld`, por lo que una política "deny incoming" **no** los protege. TI debe
bloquearlos de forma explícita, en la cadena `DOCKER-USER` o a nivel de red / security group:

- Denegar toda entrada, salvo desde loopback, hacia los puertos TCP **25000–25999, 26001 y
  18010** (aplicación, WebSocket, Postgres, Redis, MailHog y documentación de la API). En el
  diseño con túnel, nada fuera de la máquina necesita alcanzarlos.
- Los cuatro puertos proxied (25000, 25001, 25100, 26001) solo los consume `cloudflared` por
  `localhost`.

## 5. Firewall — salida

La máquina debe poder alcanzar lo siguiente. Normalmente la salida está permitida por defecto;
si está restringida, permitir estos destinos.

| Destino | Puerto / proto | Motivo |
|---|---|---|
| `region1.v2.argotunnel.com`, `region2.v2.argotunnel.com` | **7844 UDP (QUIC) y TCP (HTTP/2 de respaldo)** | Conexiones del Cloudflare Tunnel. **Es el requisito que más se olvida.** |
| `api.cloudflare.com` | 443 | Gestión de túneles y DNS por los scripts de despliegue |
| `update.argotunnel.com`, `cfd-features.argotunnel.com` | 443 | Verificaciones de funcionalidades/actualización de `cloudflared` |
| `github.com` | 22 o 443 | Descarga de los repositorios de la aplicación |
| `registry-1.docker.io`, `auth.docker.io`, `production.cloudflare.docker.com` | 443 | Descarga de la imagen de la aplicación y de imágenes base |
| `repo.packagist.org`, `packagist.org`, `registry.npmjs.org` | 443 | Dependencias Composer / npm (los paquetes privados también se autentican aquí) |
| AWS S3, región `us-east-2` (`*.s3.us-east-2.amazonaws.com`) | 443 | Almacenamiento de archivos de la aplicación |
| `api.deepinfra.com` | 443 | Proveedor de IA usado por los agentes de Vanexa |
| Resolvers DNS, NTP | 53 UDP/TCP, 123 UDP | Resolución de nombres, sincronización de hora |

La aplicación también invoca servicios de terceros configurados por ambiente (pagos,
mensajería, notificaciones push). El ingeniero entregará a TI la lista exacta a partir de los
archivos de entorno durante la instalación; se solicita permitirlos o indicar un proxy.

## 6. DNS

Si las zonas ya están en la cuenta compartida de Cloudflare, **TI no necesita hacer nada**: el
procedimiento de instalación crea los cuatro registros mediante un API token. En caso
contrario, TI debe crear (o delegar la capacidad de crear) estos registros en las zonas de
Cloudflare:

| Nombre | Tipo | Destino | Proxy |
|---|---|---|---|
| `api-preview.kitchntabs.com` | CNAME | `<TUNNEL_ID>.cfargotunnel.com` | Proxied (nube naranja) |
| `ws-preview.kitchntabs.com` | CNAME | `<TUNNEL_ID>.cfargotunnel.com` | Proxied |
| `api-preview.vanexa.cl` | CNAME | `<TUNNEL_ID>.cfargotunnel.com` | Proxied |
| `ws-preview.vanexa.cl` | CNAME | `<TUNNEL_ID>.cfargotunnel.com` | Proxied |

`<TUNNEL_ID>` se genera durante la instalación y se entrega a TI en ese momento. En Cloudflare,
los WebSockets deben estar habilitados en la zona (por defecto lo están; Network → WebSockets).

Se solicita además entregar (o autorizar la creación de) un **API token de Cloudflare** con
permisos *Account → Cloudflare Tunnel: Edit* y *Zone → DNS: Edit* únicamente para las dos
zonas, sin permisos adicionales.

## 7. Alternativa: exposición directa (solo si no se permiten túneles)

Cambian los requisitos de las secciones 4 y 6:

| Ítem | Requisito |
|---|---|
| Entrada | **443/TCP** desde internet (y 80/TCP para redirigir a HTTPS) hacia un reverse proxy en la máquina |
| IP pública | IP pública estática o balanceador delante de la máquina |
| DNS | Cuatro registros `A`/`AAAA` hacia esa IP (o hacia el proxy delante), en lugar de CNAME al túnel |
| TLS | Certificados válidos para los cuatro hosts (Let's Encrypt o CA corporativa), con renovación automática |
| Reverse proxy | nginx/Caddy en la máquina, mapeando cada host a su puerto local (ver abajo) |
| Protección | Rate limiting / WAF, ya que deja de estar el de Cloudflare delante |

Cada host necesita soporte de upgrade a WebSocket, un límite de cuerpo de 128 MB y timeouts de
300 s. Ejemplo (nginx), un bloque `server` por host:

```nginx
server {
    listen 443 ssl http2;
    server_name api-preview.kitchntabs.com;          # ws-preview.* -> 25001, Vanexa -> 25100 / 26001
    ssl_certificate     /etc/ssl/preview/fullchain.pem;
    ssl_certificate_key /etc/ssl/preview/privkey.pem;

    client_max_body_size 128M;
    proxy_read_timeout 300s;  proxy_send_timeout 300s;  proxy_connect_timeout 300s;

    location / {
        proxy_pass http://127.0.0.1:25000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header Upgrade $http_upgrade;       # obligatorio en los hosts ws-*
        proxy_set_header Connection "upgrade";
    }
}
```

## 8. Lista de verificación para TI

- [ ] Máquina aprovisionada según la sección 3, con usuario de servicio y acceso SSH para el ingeniero
- [ ] Entrada: solo 22 desde IPs de administración/VPN; **reglas `DOCKER-USER` que bloqueen 25000–25999, 26001 y 18010** (sección 4)
- [ ] Salida permitida a todas las filas de la sección 5, en especial **7844 UDP + TCP** hacia Cloudflare
- [ ] Nombres de host de preview aprobados; zonas confirmadas en Cloudflare (sección 6)
- [ ] API token de Cloudflare entregado con los permisos acotados de la sección 6
- [ ] (Solo exposición directa) IP pública, DNS, certificados TLS y reverse proxy según la sección 7

## 9. Seguridad

- El acceso administrativo por SSH debe ser solo con llave y restringido a IPs de
  administración o VPN. Si se necesita administración remota sin abrir el puerto 22, se puede
  exponer SSH mediante una ruta de Cloudflare protegida con una política de Cloudflare Access,
  como en staging, en lugar de publicar el puerto 22.
- Los tokens (token del túnel, API token de Cloudflare) son credenciales: mantenerlos fuera de
  git y de canales de chat, y rotar cualquiera que se filtre.
- Preview no debe reutilizar las claves de staging (`APP_KEY`, credenciales de base de datos,
  claves de AWS, pagos o mensajería).
