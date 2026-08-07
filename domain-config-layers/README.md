# Domain Config Layers

A dedicated, **config-only** mount — distinct from the full `domain/` mount (which holds one
whole domain codebase: models, controllers, routes, config, everything). This folder exists so
config can be **layered** across multiple sources before the active domain's own config gets the
final say, without merging full PHP codebases together.

## Why this exists (vs. `domain/config/`)

`domain/config/*.php` is already auto-discovered by `dash-backend`'s `AppServiceProvider`
(`registerDomainConfigs()`/`loadDomainConfigs()`) — but it only ever holds **one** domain's
config, whichever repo `DOMAIN_PATH` in `docker-compose.yml` currently points at. There's no way
to have a shared base (e.g. a future "ecommerce vertical" defaults set, reused by more than one
brand domain) sit *underneath* a brand-specific override using that mechanism alone — you'd have
to duplicate the shared config into every domain repo, or merge two full domain codebases into
one mount, which isn't safe.

This folder is the layering mechanism for that case. It's optional and empty by default — nothing
changes for a domain that doesn't need it.

## Structure

Subfolders are layers, applied in **sorted folder-name order** — later layers win for any
overlapping config key. Prefix folders with a number to make ordering explicit:

```
domain-config-layers/
  00-shared/              ← lowest priority: e.g. a shared vertical's defaults
    tenant_settings.php
  10-kitchntabs/          ← higher priority: brand-specific additions
    tenant_settings.php
```

Each `*.php` file inside a layer has the exact same shape as a `domain/config/*.php` file —
return an array whose top-level keys become the config file's name
(`tenant_settings.php` → merged into `config('tenant_settings.*')`, same as today), and whose
values are arrays that get merged (`array_merge`) onto whatever came before:

- **List-shaped values** (e.g. `setting_formats`, a numeric array of entries) — later layers'
  entries are appended after earlier ones.
- **Map-shaped values** (e.g. `colors`, a string-keyed array) — later layers' keys overwrite
  earlier ones for the same key.

## Precedence, full picture

1. Core's own `config/*.php` defaults (baked into the image — see `dash-backend/config/`)
2. `domain-config-layers/*/` — this folder, in sorted subfolder order, lowest priority first
3. `domain/config/*.php` — the currently-mounted domain's own config (`DOMAIN_PATH`) — **always
   wins**, applied last

So a domain never has to worry about a shared layer clobbering something it explicitly sets.

## Enabling it

Unset by default (mounts an empty directory — Docker auto-creates the host path if it doesn't
exist, and the PHP loader no-ops on an empty/missing directory). Point `DOMAIN_CONFIG_LAYERS_PATH`
in your `.env` at a real folder (structured as above) to use it:

```bash
DOMAIN_CONFIG_LAYERS_PATH=../my-shared-config-layers
```

## Implementation

`dash-backend/app/Providers/AppServiceProvider.php` → `registerDomainConfigLayers()`, called in
`boot()` before the existing `domain/config/` merges.
