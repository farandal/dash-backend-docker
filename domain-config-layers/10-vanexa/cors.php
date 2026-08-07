<?php

/**
 * vanexa.cl frontend origins, layered onto config('cors.allowed_origins') /
 * config('cors.allowed_origins_patterns') by
 * AppServiceProvider::registerDomainConfigLayers() — additive, does not touch
 * or replace core's existing kitchntabs.com entries in dash-backend/config/cors.php.
 *
 * Confirmed necessary 2026-08-05: a login attempt from https://www.vanexa.cl
 * against https://api-dev.vanexa.cl/api/login failed CORS preflight because
 * core's cors.php only knew about kitchntabs.com origins.
 */

return [
    'allowed_origins' => [
        // Production frontends (Cloudflare Pages)
        'https://vanexa.cl',
        'https://www.vanexa.cl',
        'https://system.vanexa.cl',
        'https://app.vanexa.cl',

        // Staging
        'https://web-staging.vanexa.cl',
        'https://system-staging.vanexa.cl',
        'https://app-staging.vanexa.cl',

        // Local tunnel dev
        'https://api-dev.vanexa.cl',
        'https://ws-dev.vanexa.cl',
    ],

    'allowed_origins_patterns' => [
        // Any vanexa.cl subdomain over HTTPS (covers staging/preview subdomains
        // not explicitly listed above).
        '#^https://([a-z0-9-]+\\.)?vanexa\\.cl$#',
    ],
];
