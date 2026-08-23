import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "agentmesh-package-"));

try {
  const packOutput = runNpm(
    ["pack", "--ignore-scripts", "--json", "--pack-destination", temporaryDirectory],
    projectRoot,
  );
  const [packResult] = JSON.parse(packOutput);
  if (!packResult?.filename || !Array.isArray(packResult.files)) {
    throw new Error("npm pack did not return the expected JSON manifest.");
  }

  const packagedPaths = new Set(packResult.files.map((file) => file.path));
  const requiredPaths = [
    "CHANGELOG.md",
    "LICENSE",
    "PROBLEMS.md",
    "README.md",
    "dist/cli/index.js",
    "dist/index.cjs",
    "dist/index.d.ts",
    "dist/index.js",
    "dist/mcp/server.js",
    "package.json",
  ];
  for (const requiredPath of requiredPaths) {
    if (!packagedPaths.has(requiredPath)) {
      throw new Error(`Published package is missing '${requiredPath}'.`);
    }
  }

  const forbiddenPrefixes = [".agentmesh/", ".codegraph/", "coverage/", "src/", "tests/"];
  const forbiddenPath = [...packagedPaths].find((filePath) =>
    forbiddenPrefixes.some((prefix) => filePath.startsWith(prefix)),
  );
  if (forbiddenPath) {
    throw new Error(`Published package contains forbidden path '${forbiddenPath}'.`);
  }

  const consumerDirectory = path.join(temporaryDirectory, "consumer");
  fs.mkdirSync(consumerDirectory);
  fs.writeFileSync(
    path.join(consumerDirectory, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  );
  const archivePath = path.join(temporaryDirectory, packResult.filename);
  runNpm(
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", archivePath],
    consumerDirectory,
  );

  const packageVersion = JSON.parse(
    fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"),
  ).version;
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      [
        'import { VERSION } from "agentmesh";',
        'import { createMcpServer } from "agentmesh/mcp/server";',
        `if (VERSION !== ${JSON.stringify(packageVersion)}) throw new Error("Package version mismatch");`,
        'if (typeof createMcpServer !== "function") throw new Error("MCP server export missing");',
      ].join("\n"),
    ],
    { cwd: consumerDirectory, stdio: "inherit" },
  );
  execFileSync(
    process.execPath,
    [
      "--input-type=commonjs",
      "--eval",
      [
        'const { VERSION } = require("agentmesh");',
        `if (VERSION !== ${JSON.stringify(packageVersion)}) throw new Error("CommonJS version mismatch");`,
      ].join("\n"),
    ],
    { cwd: consumerDirectory, stdio: "inherit" },
  );

  const cliPath = path.join(
    consumerDirectory,
    "node_modules",
    "agentmesh",
    "dist",
    "cli",
    "index.js",
  );
  const cliVersion = execFileSync(process.execPath, [cliPath, "--version"], {
    cwd: consumerDirectory,
    encoding: "utf8",
  }).trim();
  if (cliVersion !== packageVersion) {
    throw new Error(
      `CLI version '${cliVersion}' does not match package version '${packageVersion}'.`,
    );
  }

  process.stdout.write(
    `Verified ${packResult.id}: ${packResult.files.length} files, install and exports passed.\n`,
  );
} finally {
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
}

function runNpm(args, cwd) {
  const npmCli = process.env.npm_execpath || findNpmCli();
  if (npmCli) {
    return execFileSync(process.execPath, [npmCli, ...args], { cwd, encoding: "utf8" });
  }
  if (process.platform === "win32") {
    throw new Error("Unable to locate npm-cli.js for shell-free package verification on Windows.");
  }
  return execFileSync("npm", args, { cwd, encoding: "utf8" });
}

function findNpmCli() {
  const candidates = [
    path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    ...String(process.env.PATH || "")
      .split(path.delimiter)
      .filter(Boolean)
      .map((directory) => path.join(directory, "node_modules", "npm", "bin", "npm-cli.js")),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate));
}
