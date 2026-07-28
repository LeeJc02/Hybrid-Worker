import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_MODEL = "deepseek-v4-flash";
export const DEFAULT_PERMISSION_MODE = "bypassPermissions";
export const DEFAULT_MAX_CHANGED_FILES = 80;
export const DEFAULT_MAX_DIFF_LINES = 8000;
export const DEFAULT_MAX_PARALLELISM = 3;
export const DEFAULT_WORKER_TIMEOUT_SEC = 1500;
export const DEFAULT_TEST_TIMEOUT_SEC = 1800;
export const DEFAULT_BROKER_MAX_READONLY = 8;
export const DEFAULT_BROKER_MAX_WRITE = 4;
export const DEFAULT_BROKER_MAX_CALLS = 64;
export const DEFAULT_BROKER_MAX_COST_USD = 10;
export const DEFAULT_BROKER_LEASE_SEC = 1800;
export const PASS_MARKER = "SELF_EVALUATION: PASS";
export const NOT_OBSERVED = "not_observed";
export const CACHE_ROOT = join(homedir(), ".codex", "cache", "hybrid-worker");

export const GENERATED_ARTIFACT_DIRS = new Set([
  ".angular",
  ".aws-sam",
  ".bundle",
  ".cache",
  ".coverage",
  ".dart_tool",
  ".expo",
  ".gradle",
  ".hypothesis",
  ".idea",
  ".metals",
  ".mypy_cache",
  ".next",
  ".nuxt",
  ".parcel-cache",
  ".pytest_cache",
  ".ruff_cache",
  ".serverless",
  ".stack-work",
  ".svelte-kit",
  ".terraform",
  ".tox",
  ".turbo",
  ".venv",
  ".vite",
  ".vscode",
  "__pycache__",
  "DerivedData",
  "build",
  "coverage",
  "dist",
  "htmlcov",
  "logs",
  "node_modules",
  "out",
  "target",
  "tmp",
  "venv",
  "worker_artifacts"
]);

export const GENERATED_ARTIFACT_FILES = new Set([
  ".claudeignore",
  ".coverage",
  ".DS_Store",
  ".env",
  ".env.local",
  ".env.production",
  ".env.test",
  "coverage.xml",
  "debug.log",
  "error.log",
  "npm-debug.log",
  "pnpm-debug.log",
  "reviewer_decision.json",
  "worker_summary.json",
  "yarn-error.log",
  "yarn-debug.log"
]);

export const GENERATED_ARTIFACT_SUFFIXES = [
  ".class",
  ".dll",
  ".dSYM",
  ".egg-info",
  ".exe",
  ".log",
  ".o",
  ".obj",
  ".orig",
  ".pyc",
  ".pyo",
  ".rej",
  ".so",
  ".swp",
  ".tmp"
];

export const GIT_EXCLUDE_BLOCK = `# hybrid-worker generated artifacts
# OS/editor
.DS_Store
.idea/
.vscode/
*.swp
*.tmp

# env/secrets/local config
.env
.env.*
!.env.example

# Python
__pycache__/
*.py[cod]
*.pyo
.pytest_cache/
.mypy_cache/
.ruff_cache/
.tox/
.venv/
venv/
htmlcov/
.coverage
coverage.xml

# Node/frontend
node_modules/
dist/
build/
coverage/
.next/
.nuxt/
.vite/
.turbo/
.parcel-cache/
.svelte-kit/

# JVM/Go/Rust/mobile/cloud
.gradle/
target/
DerivedData/
.dart_tool/
.expo/
.terraform/
.serverless/
.aws-sam/
.stack-work/

# logs and harness artifacts
*.log
logs/
tmp/
worker_artifacts/
.claudeignore
debug.log
error.log
npm-debug.log
yarn-debug.log
yarn-error.log
pnpm-debug.log

# Legacy entries kept for compatibility
.cache/
reviewer_decision.json
worker_summary.json
# end hybrid-worker generated artifacts
`;
