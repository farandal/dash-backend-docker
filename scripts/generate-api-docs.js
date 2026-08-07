#!/usr/bin/env node
const { execSync } = require("child_process");
const { mkdirSync, writeFileSync, existsSync } = require("fs");
const { dirname, join } = require("path");
const https = require("https");
const http = require("http");

const PROJECT_DIR = dirname(__dirname);
const OUTPUT_DIR = `${PROJECT_DIR}/docs/api-docs`;
const OUTPUT_FILE = `${OUTPUT_DIR}/openapi.json`;
const OUTPUT_INDEX = `${OUTPUT_DIR}/index.html`;

function runCommand(command) {
  return execSync(command, {
    cwd: PROJECT_DIR,
    stdio: ["ignore", "pipe", "inherit"],
    encoding: "utf8",
  }).trim();
}

function runSilent(command) {
  execSync(command, {
    cwd: PROJECT_DIR,
    stdio: "inherit",
    encoding: "utf8",
  });
}

function normalizePath(uri) {
  return uri.startsWith("/") ? uri : `/${uri}`;
}

function parameterSchema(name) {
  return {
    name,
    in: "path",
    required: true,
    schema: {
      type: "string",
    },
    description: `Path parameter ${name}`,
  };
}

function buildSpec(routes) {
  const paths = {};
  const tags = new Set();

  routes.forEach((route) => {
    if (!route.uri || !route.method || route.uri === "_ignition/health-check") {
      return;
    }

    const uri = route.uri;
    const action = route.action || "";
    if (action === "Closure" || action === "") {
      return;
    }

    const isApiRoute =
      uri.startsWith("api/") ||
      action.includes("Http\\Controllers\\API\\") ||
      (route.name && route.name.startsWith("api."));

    if (!isApiRoute) {
      return;
    }

    const path = normalizePath(uri.replace(/\/{2,}/g, "/"));
    const methods = route.method
      .split("|")
      .filter((m) => m !== "HEAD" && m !== "OPTIONS");
    if (!methods.length) {
      return;
    }

    const tag = action.includes("Domain\\App\\Http\\Controllers")
      ? "Domain"
      : action.includes("App\\Http\\Controllers")
      ? "Core"
      : "Other";
    tags.add(tag);

    const pathParams = Array.from(path.matchAll(/\{([^}]+)\}/g)).map((m) => m[1]);
    const parameters = pathParams.map(parameterSchema);
    const description = route.name || action || path;

    paths[path] = paths[path] || {};

    methods.forEach((method) => {
      const lower = method.toLowerCase();
      paths[path][lower] = {
        tags: [tag],
        summary: description,
        operationId: route.name || route.action || `${lower}${path.replace(/[^a-zA-Z0-9]/g, "_")}`,
        parameters,
        responses: {
          "200": {
            description: "Successful response",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                },
              },
            },
          },
        },
      };

      if (["POST", "PUT", "PATCH"].includes(method)) {
        paths[path][lower].requestBody = {
          description: "Request payload",
          content: {
            "application/json": {
              schema: {
                type: "object",
              },
            },
          },
          required: false,
        };
      }
    });
  });

  return {
    openapi: "3.1.0",
    info: {
      title: "Dash Backend API Docs",
      description: "Auto-generated API documentation for core and domain routes.",
      version: "1.0.0",
    },
    servers: [{ url: "/" }],
    tags: Array.from(tags).map((name) => ({ name })),
    paths,
    components: {
      schemas: {},
    },
  };
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = require("fs").createWriteStream(dest);
    const mod = url.startsWith("https") ? https : http;
    mod.get(url, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        file.close();
        downloadFile(response.headers.location, dest).then(resolve).catch(reject);
        return;
      }
      response.pipe(file);
      file.on("finish", () => file.close(resolve));
    }).on("error", (err) => {
      require("fs").unlink(dest, () => {});
      reject(err);
    });
  });
}

async function main() {
  // `docker compose exec` matches running containers by project label, which
  // is normally sourced from a literal `.env` (no longer present in this repo)
  // or an inherited COMPOSE_PROJECT_NAME export. Without either, Compose falls
  // back to the directory name and reports "service app is not running" even
  // though the container is up under a different project. Default to the
  // value baked into docker-compose.yml so standalone `pnpm docs:generate`
  // still works; an inherited export (e.g. from run-local-mac.sh) wins.
  process.env.COMPOSE_PROJECT_NAME = process.env.COMPOSE_PROJECT_NAME || "dash_image";

  mkdirSync(dirname(OUTPUT_FILE), { recursive: true });

  // Ensure local Redoc bundle exists
  const redocDest = join(OUTPUT_DIR, "redoc.standalone.js");
  if (!existsSync(redocDest)) {
    console.log("Downloading Redoc standalone bundle...");
    await downloadFile(
      "https://cdn.redoc.ly/redoc/latest/bundles/redoc.standalone.js",
      redocDest
    );
    console.log("Redoc bundle saved.");
  }

  runSilent("docker compose exec -T app env FIREBASE_ENABLED=0 php artisan config:clear");
  const raw = runCommand("docker compose exec -T app env FIREBASE_ENABLED=0 php artisan route:list --json");
  const routes = JSON.parse(raw);

  const spec = buildSpec(routes);
  writeFileSync(OUTPUT_FILE, JSON.stringify(spec, null, 2), "utf8");

  console.log(`Generated API docs at ${OUTPUT_FILE}`);
}

main().catch((error) => {
  console.error("Failed to generate API docs:", error);
  process.exit(1);
});
