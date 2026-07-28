#!/usr/bin/env node

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
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

Multi-route mode (multiple hostnames on one tunnel):
  - Set CF_TUNNEL_HOSTNAME_<SLOT> + CF_TUNNEL_LOCAL_<SLOT> pairs (slots: API, WS, WEB, SYSTEM).
    Example: CF_TUNNEL_HOSTNAME_API=api-dev.kitchntabs.com / CF_TUNNEL_LOCAL_API=http://localhost:25000
  - Takes precedence over CF_TUNNEL_HOSTNAME / --hostname when any slot is configured.
  - Requires CF_API_TOKEN + CF_ACCOUNT_ID + a tunnel token (CF_TUNNEL_TOKEN or CF_TUNNEL_TOKEN_FILE).
  - Pushes ingress rules to Cloudflare's remotely-managed tunnel config via the API and creates/updates a
    DNS CNAME for each configured hostname.
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

function resolveTunnelId(tunnelToken, tunnelTokenFile) {
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
      return tunnelId;
    }
  }

  return '';
}

function resolveCnameTarget(parsedValues, tunnelToken, tunnelTokenFile) {
  const explicit = parsedValues.CF_TUNNEL_CNAME_TARGET || parsedValues.CF_TUNNEL_HOSTNAME_TARGET || '';
  if (explicit) {
    return explicit;
  }

  const tunnelId = resolveTunnelId(tunnelToken, tunnelTokenFile);
  return tunnelId ? `${tunnelId}.cfargotunnel.com` : '';
}

function parseMultiRoutes(values) {
  const slots = ['API', 'WS', 'WEB', 'SYSTEM'];
  const routes = [];

  for (const slot of slots) {
    const hostname = values[`CF_TUNNEL_HOSTNAME_${slot}`] || '';
    const localUrl = values[`CF_TUNNEL_LOCAL_${slot}`] || '';

    if (hostname && localUrl) {
      routes.push({ slot, hostname, localUrl });
    } else if (hostname && !localUrl) {
      console.warn(`CF_TUNNEL_HOSTNAME_${slot} is set but CF_TUNNEL_LOCAL_${slot} is missing; skipping.`);
    }
  }

  return routes;
}

async function pushIngressConfig({ apiToken, accountId, tunnelId, routes }) {
  const headers = {
    Authorization: `Bearer ${apiToken}`,
    'Content-Type': 'application/json',
  };

  const ingress = routes.map((route) => ({
    hostname: route.hostname,
    service: route.localUrl,
  }));
  ingress.push({ service: 'http_status:404' });

  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`;
  const resp = await axios.put(url, { config: { ingress } }, { headers });
  return resp.data?.result;
}

function runNamedTunnel({
  tokenFileToUse,
  localUrl,
  fallbackEnabled,
  fallbackThreshold,
  fallbackWindowMs,
  onFallbackQuickUrl,
}) {
  const proc = spawn('cloudflared', ['tunnel', 'run', '--token-file', tokenFileToUse, '--url', localUrl], {
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

function runRemoteManagedTunnel({ tokenFileToUse }) {
  // No --url: ingress routing is fetched from the Cloudflare edge (pushed via pushIngressConfig).
  const proc = spawn('cloudflared', ['tunnel', 'run', '--token-file', tokenFileToUse], {
    stdio: 'inherit',
  });

  proc.on('exit', (code, signal) => {
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
  const appPort = parsed.values.APP_PORT || '8000';
  const hostnameEnv = parsed.values.CF_TUNNEL_HOSTNAME || '';
  const hostname = hostnameArg || hostnameEnv;
  const tunnelTokenFile = parsed.values.CF_TUNNEL_TOKEN_FILE || '';
  const tunnelToken =
    parsed.values.CF_TUNNEL_TOKEN || parsed.values.CLOUDFLARE_TUNNEL_TOKEN || '';

  const multiRoutes = parseMultiRoutes(parsed.values);

  if (multiRoutes.length > 0) {
    console.log(`Multi-route mode: ${multiRoutes.length} hostname(s) configured.`);

    const apiToken = parsed.values.CF_API_TOKEN || '';
    const accountId = parsed.values.CF_ACCOUNT_ID || '';
    const zoneName = parsed.values.CF_ZONE_NAME || '';
    const zoneId = parsed.values.CF_ZONE_ID || '';

    if (!apiToken || !accountId) {
      console.error('Multi-route mode requires CF_API_TOKEN and CF_ACCOUNT_ID.');
      process.exit(1);
    }

    if (!tunnelToken && !tunnelTokenFile) {
      console.error('Multi-route mode requires CF_TUNNEL_TOKEN or CF_TUNNEL_TOKEN_FILE.');
      process.exit(1);
    }

    const tunnelId = resolveTunnelId(tunnelToken, tunnelTokenFile);
    if (!tunnelId) {
      console.error('Could not determine tunnel id from CF_TUNNEL_TOKEN / CF_TUNNEL_TOKEN_FILE.');
      process.exit(1);
    }

    if (zoneId || zoneName) {
      const cnameTarget = `${tunnelId}.cfargotunnel.com`;
      for (const route of multiRoutes) {
        try {
          await ensureDnsRecord({ apiToken, zoneName, zoneId, hostName: route.hostname, cnameTarget });
        } catch (err) {
          const detail = err.response?.data || err.message;
          console.error(`Failed to ensure DNS CNAME for ${route.hostname}:`, detail);
        }
      }
    } else {
      console.warn('Multi-route DNS automation skipped: set CF_ZONE_ID or CF_ZONE_NAME.');
    }

    try {
      await pushIngressConfig({ apiToken, accountId, tunnelId, routes: multiRoutes });
      console.log('Pushed ingress configuration to Cloudflare:');
      for (const route of multiRoutes) {
        console.log(`  ${route.hostname} -> ${route.localUrl}`);
      }
    } catch (err) {
      const detail = err.response?.data || err.message;
      console.error('Failed to push ingress configuration:', detail);
      process.exit(1);
    }

    let tokenFileToUse = tunnelTokenFile;
    let tempTokenFile = '';

    if (tunnelToken) {
      tempTokenFile = path.join(os.tmpdir(), `cf-tunnel-token-${Date.now()}.txt`);
      fs.writeFileSync(tempTokenFile, tunnelToken, 'utf8');
      tokenFileToUse = tempTokenFile;

      const cleanup = () => {
        if (tempTokenFile && fs.existsSync(tempTokenFile)) {
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
    }

    const primaryRoute = multiRoutes[0];
    announceEndpoint(`https://${primaryRoute.hostname} (+${multiRoutes.length - 1} more route(s))`);

    if (updateEnv) {
      writeUpdatedEnv(envFile, parsed.lines, 'APP_URL', `https://${primaryRoute.hostname}`);
      console.log(`Updated APP_URL in ${envFile} -> https://${primaryRoute.hostname}`);
    }

    runRemoteManagedTunnel({ tokenFileToUse });
    return;
  }

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

    let tokenFileToUse = tunnelTokenFile;
    let tempTokenFile = '';

    if (tunnelToken) {
      tempTokenFile = path.join(os.tmpdir(), `cf-tunnel-token-${Date.now()}.txt`);
      fs.writeFileSync(tempTokenFile, tunnelToken, 'utf8');
      tokenFileToUse = tempTokenFile;

      const cleanup = () => {
        if (tempTokenFile && fs.existsSync(tempTokenFile)) {
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
    }

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
