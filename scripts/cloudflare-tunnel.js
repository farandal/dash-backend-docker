#!/usr/bin/env node

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const { spawn, spawnSync } = require('child_process');
const axios = require('axios');

let envFile = '.env';
let hostnameArg = '';
let updateEnv = true;

function usage() {
  console.log(`Usage:
  ./scripts/cloudflare-tunnel.sh [--env-file FILE] [--hostname HOST] [--no-update-env]
  node ./scripts/cloudflare-tunnel.js [--env-file FILE] [--hostname HOST] [--no-update-env]

Examples:
  ./scripts/cloudflare-tunnel.sh
  node ./scripts/cloudflare-tunnel.js --hostname dev-local-api.kitchntabs.com
  node ./scripts/cloudflare-tunnel.js --env-file .env --no-update-env

Behavior:
  - Uses APP_PORT from the env file (default 8000).
  - Uses a custom hostname from CF_TUNNEL_HOSTNAME or --hostname when a tunnel token is available.
  - Falls back to a quick trycloudflare.com URL if no hostname is configured.
  - In named tunnel mode, repeated QUIC timeout errors can auto-fallback to quick tunnel URL.
  - By default, updates APP_URL in the env file when the public URL is known.

Optional DNS API automation:
  - If CF_API_TOKEN and (CF_ZONE_ID or CF_ZONE_NAME) are set, the script creates/updates a proxied CNAME for the
    selected hostname before starting the tunnel.
  - CF_TUNNEL_CNAME_TARGET is optional; if omitted, it is derived from the tunnel token.

Multi-hostname routing (one named tunnel, several public hostnames):
  - Set CF_TUNNEL_HOSTNAME_<SLOT> + CF_TUNNEL_LOCAL_<SLOT> pairs, where <SLOT> is one of:
    API, WS, WEB, SYSTEM (e.g. CF_TUNNEL_HOSTNAME_API=api-dev.kitchntabs.com,
    CF_TUNNEL_LOCAL_API=http://localhost:25000).
  - When at least one CF_TUNNEL_HOSTNAME_<SLOT> is set, the script switches to multi-route mode:
    it pushes ingress rules to the named tunnel via the Cloudflare API
    (PUT /accounts/{account}/cfd_tunnel/{tunnel}/configurations), creates a CNAME for each
    hostname, and runs cloudflared without --url so it serves all configured hostnames at once.
  - Multi-route mode requires CF_API_TOKEN and CF_ACCOUNT_ID — there is no quick-tunnel fallback
    for it, since a quick tunnel can only ever forward a single hostname.
  - If CF_TUNNEL_TOKEN / CF_TUNNEL_TOKEN_FILE are not set, the script creates (or looks up, by
    name) a named tunnel via the Cloudflare API itself — no dashboard step required — and saves
    the resulting token back into the env file as CF_TUNNEL_TOKEN. Set CF_TUNNEL_NAME to control
    the tunnel's name (default: dash-dev).
`);
}

function parseArgs(argv) {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--env-file') {
      const val = argv[i + 1];
      if (!val) {
        throw new Error('--env-file requires a value');
      }
      envFile = val;
      i += 1;
      continue;
    }

    if (arg === '--hostname') {
      const val = argv[i + 1];
      if (!val) {
        throw new Error('--hostname requires a value');
      }
      hostnameArg = val;
      i += 1;
      continue;
    }

    if (arg === '--no-update-env') {
      updateEnv = false;
      continue;
    }

    if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    }

    throw new Error(`Unknown argument: ${arg}`);
  }
}

function normalizeEnvValue(raw) {
  const trimmed = (raw || '').trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseEnvFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split(/\r?\n/);
  const values = {};

  for (const line of lines) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) {
      continue;
    }
    const key = match[1];
    const value = match[2];
    values[key] = normalizeEnvValue(value);
  }

  return { lines, values };
}

function upsertEnvValue(lines, key, value) {
  const out = [];
  let replaced = false;

  for (const line of lines) {
    if (line.match(new RegExp(`^${key}=`))) {
      if (!replaced) {
        out.push(`${key}=${value}`);
        replaced = true;
      }
      continue;
    }
    out.push(line);
  }

  if (!replaced) {
    out.push(`${key}=${value}`);
  }

  while (out.length > 0 && out[out.length - 1] === '') {
    out.pop();
  }

  return `${out.join('\n')}\n`;
}

function announceEndpoint(endpoint) {
  console.log('');
  console.log(`DEV TUNNEL ENDPOINT: ${endpoint}`);
  console.log('');
}

function commandExists(command) {
  const check = spawnSync(command, ['--version'], { stdio: 'ignore' });
  return check.status === 0;
}

function parsePositiveInt(value, defaultValue) {
  if (!value) {
    return defaultValue;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return defaultValue;
  }

  return parsed;
}

async function ensureDnsRecord({ apiToken, zoneName, zoneId, hostName, cnameTarget }) {
  const headers = {
    Authorization: `Bearer ${apiToken}`,
    'Content-Type': 'application/json',
  };

  let resolvedZoneId = zoneId || '';

  if (!resolvedZoneId) {
    const zoneResp = await axios.get(
      `https://api.cloudflare.com/client/v4/zones?name=${encodeURIComponent(zoneName)}`,
      { headers }
    );

    const zone = zoneResp.data?.result?.[0];
    if (!zone?.id) {
      throw new Error(`Cloudflare zone not found for ${zoneName}`);
    }
    resolvedZoneId = zone.id;
  }

  const listResp = await axios.get(
    `https://api.cloudflare.com/client/v4/zones/${resolvedZoneId}/dns_records`,
    {
      headers,
      params: {
        type: 'CNAME',
        name: hostName,
      },
    }
  );

  const existing = (listResp.data?.result || [])[0];
  const payload = {
    type: 'CNAME',
    name: hostName,
    content: cnameTarget,
    ttl: 1,
    proxied: true,
  };

  if (!existing) {
    const createResp = await axios.post(
      `https://api.cloudflare.com/client/v4/zones/${resolvedZoneId}/dns_records`,
      payload,
      { headers }
    );
    const created = createResp.data?.result;
    console.log(`Created DNS CNAME: ${created?.name} -> ${created?.content}`);
    return;
  }

  if (existing.content === cnameTarget && existing.proxied === true) {
    console.log(`DNS CNAME already configured: ${existing.name} -> ${existing.content}`);
    return;
  }

  const updateResp = await axios.put(
    `https://api.cloudflare.com/client/v4/zones/${resolvedZoneId}/dns_records/${existing.id}`,
    payload,
    { headers }
  );
  const updated = updateResp.data?.result;
  console.log(`Updated DNS CNAME: ${updated?.name} -> ${updated?.content}`);
}

const ROUTE_SLOTS = ['API', 'WS', 'WEB', 'SYSTEM'];

function collectMultiRoutes(values) {
  const routes = [];

  for (const slot of ROUTE_SLOTS) {
    const hostname = (values[`CF_TUNNEL_HOSTNAME_${slot}`] || '').trim();
    const service = (values[`CF_TUNNEL_LOCAL_${slot}`] || '').trim();

    if (!hostname) {
      continue;
    }

    if (!service) {
      console.warn(`CF_TUNNEL_HOSTNAME_${slot} is set but CF_TUNNEL_LOCAL_${slot} is empty — skipping ${slot}.`);
      continue;
    }

    routes.push({ slot, hostname, service });
  }

  return routes;
}

function materializeTunnelToken(tunnelToken, tunnelTokenFile) {
  if (!tunnelToken) {
    return tunnelTokenFile;
  }

  const tempTokenFile = path.join(os.tmpdir(), `cf-tunnel-token-${Date.now()}.txt`);
  fs.writeFileSync(tempTokenFile, tunnelToken, 'utf8');

  const cleanup = () => {
    if (fs.existsSync(tempTokenFile)) {
      fs.unlinkSync(tempTokenFile);
    }
  };

  process.on('exit', cleanup);
  process.on('SIGINT', () => {
    cleanup();
    process.exit(130);
  });
  process.on('SIGTERM', () => {
    cleanup();
    process.exit(143);
  });

  return tempTokenFile;
}

async function pushTunnelIngressConfig({ apiToken, accountId, tunnelId, routes }) {
  const headers = {
    Authorization: `Bearer ${apiToken}`,
    'Content-Type': 'application/json',
  };

  const ingress = routes.map((route) => ({ hostname: route.hostname, service: route.service }));
  ingress.push({ service: 'http_status:404' });

  const resp = await axios.put(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`,
    { config: { ingress } },
    { headers }
  );

  if (!resp.data?.success) {
    throw new Error(`Failed to push tunnel ingress config: ${JSON.stringify(resp.data?.errors)}`);
  }

  console.log('Pushed tunnel ingress configuration:');
  for (const route of routes) {
    console.log(`  ${route.hostname}  ->  ${route.service}`);
  }
}

async function ensureNamedTunnel({ apiToken, accountId, tunnelName }) {
  const headers = {
    Authorization: `Bearer ${apiToken}`,
    'Content-Type': 'application/json',
  };

  const listResp = await axios.get(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/cfd_tunnel`,
    { headers, params: { name: tunnelName, is_deleted: false } }
  );

  let tunnel = (listResp.data?.result || [])[0];

  if (!tunnel) {
    const tunnelSecret = crypto.randomBytes(32).toString('base64');
    const createResp = await axios.post(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/cfd_tunnel`,
      { name: tunnelName, config_src: 'cloudflare', tunnel_secret: tunnelSecret },
      { headers }
    );

    if (!createResp.data?.success) {
      throw new Error(`Failed to create Cloudflare tunnel "${tunnelName}": ${JSON.stringify(createResp.data?.errors)}`);
    }

    tunnel = createResp.data.result;
    console.log(`Created named Cloudflare tunnel "${tunnelName}" (${tunnel.id}).`);
  } else {
    console.log(`Using existing named Cloudflare tunnel "${tunnelName}" (${tunnel.id}).`);
  }

  const tokenResp = await axios.get(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/cfd_tunnel/${tunnel.id}/token`,
    { headers }
  );

  if (!tokenResp.data?.success || !tokenResp.data?.result) {
    throw new Error(
      `Failed to fetch connector token for tunnel "${tunnelName}": ${JSON.stringify(tokenResp.data?.errors)}`
    );
  }

  return { tunnelId: tunnel.id, token: tokenResp.data.result };
}

async function runMultiRouteTunnel({ parsed, routes }) {
  const apiToken = parsed.values.CF_API_TOKEN || '';
  const accountId = parsed.values.CF_ACCOUNT_ID || '';
  const zoneName = parsed.values.CF_ZONE_NAME || '';
  const zoneId = parsed.values.CF_ZONE_ID || '';
  const tunnelTokenFile = parsed.values.CF_TUNNEL_TOKEN_FILE || '';
  let tunnelToken = parsed.values.CF_TUNNEL_TOKEN || parsed.values.CLOUDFLARE_TUNNEL_TOKEN || '';

  if (!apiToken || !accountId) {
    console.error('Multi-hostname tunnel routing requires CF_API_TOKEN and CF_ACCOUNT_ID');
    console.error('(used to create/look up the named tunnel and push ingress rules via the Cloudflare API).');
    process.exit(1);
  }

  let tunnelId = '';

  if (!tunnelToken && !tunnelTokenFile) {
    const tunnelName = parsed.values.CF_TUNNEL_NAME || 'dash-dev';
    console.log(`No CF_TUNNEL_TOKEN configured — creating/looking up named tunnel "${tunnelName}" via the Cloudflare API.`);
    const created = await ensureNamedTunnel({ apiToken, accountId, tunnelName });
    tunnelId = created.tunnelId;
    tunnelToken = created.token;

    if (updateEnv) {
      writeUpdatedEnv(envFile, parsed.lines, 'CF_TUNNEL_TOKEN', tunnelToken);
      console.log(`Saved CF_TUNNEL_TOKEN to ${envFile}.`);
    }
  }

  const cnameTarget = tunnelId
    ? `${tunnelId}.cfargotunnel.com`
    : resolveCnameTarget(parsed.values, tunnelToken, tunnelTokenFile);

  if (!cnameTarget) {
    console.error('Could not determine the tunnel id from CF_TUNNEL_TOKEN / CF_TUNNEL_TOKEN_FILE.');
    process.exit(1);
  }
  if (!tunnelId) {
    tunnelId = cnameTarget.replace('.cfargotunnel.com', '');
  }

  console.log(`Configuring named tunnel ${tunnelId} with ${routes.length} hostname route(s):`);
  for (const route of routes) {
    console.log(`  ${route.hostname}  ->  ${route.service}`);
  }

  await pushTunnelIngressConfig({ apiToken, accountId, tunnelId, routes });

  if (zoneId || zoneName) {
    for (const route of routes) {
      try {
        await ensureDnsRecord({ apiToken, zoneName, zoneId, hostName: route.hostname, cnameTarget });
      } catch (err) {
        const detail = err.response?.data || err.message;
        console.error(`Failed to ensure DNS CNAME for ${route.hostname}:`, detail);
      }
    }
  } else {
    console.warn('CF_ZONE_ID/CF_ZONE_NAME not set — skipping DNS automation. Ensure CNAME records exist for:');
    for (const route of routes) {
      console.warn(`  ${route.hostname} -> ${cnameTarget}`);
    }
  }

  for (const route of routes) {
    announceEndpoint(`https://${route.hostname}  ->  ${route.service}`);
  }

  const tokenFileToUse = materializeTunnelToken(tunnelToken, tunnelTokenFile);

  runNamedTunnel({
    tokenFileToUse,
    localUrl: null,
    fallbackEnabled: false,
    fallbackThreshold: Infinity,
    fallbackWindowMs: Infinity,
    onFallbackQuickUrl: () => {},
  });
}

function writeUpdatedEnv(filePath, lines, key, value) {
  const content = upsertEnvValue(lines, key, value);
  fs.writeFileSync(filePath, content, 'utf8');
}

function decodeTunnelIdFromToken(token) {
  if (!token) {
    return '';
  }

  const tryDecodeJson = (encodedBase64) => {
    const normalized = encodedBase64.replace(/-/g, '+').replace(/_/g, '/');
    const padding = '='.repeat((4 - (normalized.length % 4)) % 4);
    const payloadJson = Buffer.from(`${normalized}${padding}`, 'base64').toString('utf8');
    const payload = JSON.parse(payloadJson);
    return payload.t || payload.tunnel_id || '';
  };

  try {
    if (token.indexOf('.') !== -1) {
      const payloadPart = token.split('.')[1] || '';
      const tunnelIdFromJwt = tryDecodeJson(payloadPart);
      if (tunnelIdFromJwt) {
        return tunnelIdFromJwt;
      }
    }
  } catch (_ignored) {
    // Fall through to raw base64 token decode.
  }

  try {
    return tryDecodeJson(token);
  } catch (_err) {
    return '';
  }
}

function resolveCnameTarget(parsedValues, tunnelToken, tunnelTokenFile) {
  const explicit = parsedValues.CF_TUNNEL_CNAME_TARGET || parsedValues.CF_TUNNEL_HOSTNAME_TARGET || '';
  if (explicit) {
    return explicit;
  }

  const tokenCandidates = [];
  if (tunnelToken) {
    tokenCandidates.push(tunnelToken);
  }

  if (tunnelTokenFile && fs.existsSync(tunnelTokenFile)) {
    try {
      const tokenFromFile = fs.readFileSync(tunnelTokenFile, 'utf8').trim();
      if (tokenFromFile) {
        tokenCandidates.push(tokenFromFile);
      }
    } catch (_err) {
      // Ignore unreadable token files; named tunnel execution will report issues later.
    }
  }

  for (const candidate of tokenCandidates) {
    const tunnelId = decodeTunnelIdFromToken(candidate);
    if (tunnelId) {
      return `${tunnelId}.cfargotunnel.com`;
    }
  }

  return '';
}

function runNamedTunnel({
  tokenFileToUse,
  localUrl,
  fallbackEnabled,
  fallbackThreshold,
  fallbackWindowMs,
  onFallbackQuickUrl,
}) {
  const args = ['tunnel', 'run', '--token-file', tokenFileToUse];
  if (localUrl) {
    args.push('--url', localUrl);
  }

  const proc = spawn('cloudflared', args, {
    stdio: ['inherit', 'pipe', 'pipe'],
  });

  let fallbackTriggered = false;
  let hasRegisteredConnection = false;
  const quicTimeoutTimestamps = [];

  const onLine = (line, stream) => {
    stream.write(`${line}\n`);

    if (!fallbackEnabled || fallbackTriggered || hasRegisteredConnection) {
      return;
    }

    if (/Registered tunnel connection|Connection .* registered|Connected to Cloudflare/i.test(line)) {
      hasRegisteredConnection = true;
      return;
    }

    if (!/Failed to dial a quic connection/i.test(line)) {
      return;
    }

    const now = Date.now();
    quicTimeoutTimestamps.push(now);

    while (quicTimeoutTimestamps.length > 0 && now - quicTimeoutTimestamps[0] > fallbackWindowMs) {
      quicTimeoutTimestamps.shift();
    }

    if (quicTimeoutTimestamps.length >= fallbackThreshold) {
      fallbackTriggered = true;
      console.warn(
        `Detected ${quicTimeoutTimestamps.length} QUIC dial timeouts within ${Math.floor(fallbackWindowMs / 1000)}s. Falling back to quick tunnel URL.`
      );
      proc.kill('SIGTERM');

      let quickUpdated = false;
      runQuickTunnel(localUrl, (quickUrl) => {
        if (quickUpdated) {
          return;
        }
        onFallbackQuickUrl(quickUrl);
        quickUpdated = true;
      });
    }
  };

  attachLineReader(proc.stdout, (line) => onLine(line, process.stdout), { write: () => {} });
  attachLineReader(proc.stderr, (line) => onLine(line, process.stderr), { write: () => {} });

  proc.on('exit', (code, signal) => {
    if (fallbackTriggered) {
      return;
    }

    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
}

function attachLineReader(stream, onLine, mirror) {
  const rl = readline.createInterface({ input: stream });
  rl.on('line', (line) => {
    mirror.write(`${line}\n`);
    onLine(line);
  });
}

function runQuickTunnel(localUrl, onPublicUrl) {
  const proc = spawn('cloudflared', ['tunnel', '--url', localUrl], {
    stdio: ['inherit', 'pipe', 'pipe'],
  });

  const matcher = /https:\/\/[a-zA-Z0-9.-]+\.trycloudflare\.com/g;

  const onLine = (line) => {
    const matches = line.match(matcher) || [];
    if (matches.length > 0) {
      onPublicUrl(matches[0]);
    }
  };

  attachLineReader(proc.stdout, onLine, process.stdout);
  attachLineReader(proc.stderr, onLine, process.stderr);

  proc.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
}

async function main() {
  try {
    parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    usage();
    process.exit(1);
  }

  if (!commandExists('cloudflared')) {
    console.error('cloudflared is not installed. Install with: brew install cloudflared');
    process.exit(1);
  }

  if (!fs.existsSync(envFile)) {
    console.error(`Env file not found: ${envFile}`);
    process.exit(1);
  }

  const parsed = parseEnvFile(envFile);

  const multiRoutes = collectMultiRoutes(parsed.values);
  if (multiRoutes.length > 0) {
    await runMultiRouteTunnel({ parsed, routes: multiRoutes });
    return;
  }

  const appPort = parsed.values.APP_PORT || '8000';
  const hostnameEnv = parsed.values.CF_TUNNEL_HOSTNAME || '';
  const hostname = hostnameArg || hostnameEnv;
  const tunnelTokenFile = parsed.values.CF_TUNNEL_TOKEN_FILE || '';
  const tunnelToken =
    parsed.values.CF_TUNNEL_TOKEN || parsed.values.CLOUDFLARE_TUNNEL_TOKEN || '';

  const localUrl = `http://localhost:${appPort}`;
  const quicFallbackEnabled = !['0', 'false', 'no', 'off'].includes(
    (parsed.values.CF_QUIC_ERROR_FALLBACK_ENABLED || '1').toLowerCase()
  );
  const quicFallbackThreshold = parsePositiveInt(parsed.values.CF_QUIC_ERROR_FALLBACK_COUNT, 3);
  const quicFallbackWindowMs = parsePositiveInt(parsed.values.CF_QUIC_ERROR_FALLBACK_WINDOW_SEC, 30) * 1000;

  console.log(`Starting Cloudflare Tunnel to ${localUrl}`);

  if (hostname) {
    const publicUrl = `https://${hostname}`;
    console.log(`Using custom hostname: ${publicUrl}`);
    announceEndpoint(publicUrl);

    const apiToken = parsed.values.CF_API_TOKEN || '';
    const zoneName = parsed.values.CF_ZONE_NAME || '';
    const zoneId = parsed.values.CF_ZONE_ID || '';
    const cnameTarget = resolveCnameTarget(parsed.values, tunnelToken, tunnelTokenFile);

    if (apiToken && (zoneId || zoneName) && cnameTarget) {
      try {
        await ensureDnsRecord({ apiToken, zoneName, zoneId, hostName: hostname, cnameTarget });
      } catch (err) {
        const detail = err.response?.data || err.message;
        console.error('Failed to ensure DNS CNAME via Cloudflare API:', detail);
      }
    } else if (apiToken && (zoneId || zoneName) && !cnameTarget) {
      console.warn('Cloudflare DNS automation skipped: no CNAME target could be resolved.');
      console.warn('Set CF_TUNNEL_CNAME_TARGET or provide a valid CF_TUNNEL_TOKEN / CF_TUNNEL_TOKEN_FILE.');
    } else if (apiToken && !zoneId && !zoneName) {
      console.warn('Cloudflare DNS automation skipped: set CF_ZONE_ID or CF_ZONE_NAME.');
    }

    if (!tunnelToken && !tunnelTokenFile) {
      console.warn('Custom hostname requested, but no tunnel token was found.');
      console.warn(`Set CF_TUNNEL_TOKEN_FILE or CF_TUNNEL_TOKEN in ${envFile} to run a named Cloudflare tunnel.`);
      console.warn('Falling back to a quick tunnel URL.');

      let didUpdateEnv = false;
      runQuickTunnel(localUrl, (quickUrl) => {
        if (!updateEnv || didUpdateEnv) {
          return;
        }

        announceEndpoint(quickUrl);
        writeUpdatedEnv(envFile, parsed.lines, 'APP_URL', quickUrl);
        console.log(`Updated APP_URL in ${envFile} -> ${quickUrl}`);
        didUpdateEnv = true;
      });
      return;
    }

    const tokenFileToUse = materializeTunnelToken(tunnelToken, tunnelTokenFile);

    if (updateEnv) {
      writeUpdatedEnv(envFile, parsed.lines, 'APP_URL', publicUrl);
      console.log(`Updated APP_URL in ${envFile} -> ${publicUrl}`);
    }

    let didUpdateEnvAfterFallback = false;
    runNamedTunnel({
      tokenFileToUse,
      localUrl,
      fallbackEnabled: quicFallbackEnabled,
      fallbackThreshold: quicFallbackThreshold,
      fallbackWindowMs: quicFallbackWindowMs,
      onFallbackQuickUrl: (quickUrl) => {
        if (!updateEnv || didUpdateEnvAfterFallback) {
          return;
        }

        announceEndpoint(quickUrl);
        writeUpdatedEnv(envFile, parsed.lines, 'APP_URL', quickUrl);
        console.log(`Updated APP_URL in ${envFile} -> ${quickUrl}`);
        didUpdateEnvAfterFallback = true;
      },
    });
    return;
  }

  console.log('No custom hostname configured. Falling back to quick tunnel URL.');
  console.log(`Tip: set CF_TUNNEL_HOSTNAME=dev-local-api.kitchntabs.com in ${envFile} to use your custom domain.`);

  let didUpdateEnv = false;
  runQuickTunnel(localUrl, (quickUrl) => {
    if (!updateEnv || didUpdateEnv) {
      return;
    }

    announceEndpoint(quickUrl);
    writeUpdatedEnv(envFile, parsed.lines, 'APP_URL', quickUrl);
    console.log(`Updated APP_URL in ${envFile} -> ${quickUrl}`);
    didUpdateEnv = true;
  });
}

main().catch((err) => {
  const detail = err.response?.data || err.message;
  console.error(detail);
  process.exit(1);
});
