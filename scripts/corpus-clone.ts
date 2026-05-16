/**
 * scripts/corpus-clone.ts
 *
 * Clona los repos definidos en corpus.json al commit SHA exacto pinned,
 * con cache local idempotente en D:/Nreki/corpus/<slug>/.
 *
 * Uso:
 *   npx tsx scripts/corpus-clone.ts                  # clona los 10
 *   npx tsx scripts/corpus-clone.ts microsoft/vscode # clona solo uno
 *
 * Sprint v10.19.0 corpus baseline. Firma E (Furia + Jherson).
 * NO modifica produccion. Solo crea archivos en D:/Nreki/corpus/.
 */

import { execSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync, rmSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { argv, exit } from "node:process";

interface RepoEntry {
  name: string;
  priority: "ALTA" | "MEDIA" | "BAJA";
  language: string;
  tag: string;
  tag_type: "lightweight" | "annotated";
  commit_sha: string;
  published: string;
  note?: string;
}

interface CorpusJson {
  version: string;
  description: string;
  strategy: string;
  criterion: string;
  resolved_at: string;
  resolved_by: string;
  repositories: RepoEntry[];
}

type CloneStatus =
  | "cache_hit"
  | "cache_invalid_recloned"
  | "fresh_clone"
  | "sha_mismatch"
  | "clone_silent_fail"
  | "error";

interface CloneResult {
  name: string;
  sha_pinned: string;
  sha_actual: string | null;
  size_mb: number | null;
  status: CloneStatus;
  error?: string;
}

const REPO_ROOT = resolve("D:/Nreki");
const CORPUS_DIR = join(REPO_ROOT, "corpus");
const CORPUS_JSON = join(REPO_ROOT, "corpus.json");

function slugify(repoName: string): string {
  return repoName.replace("/", "__");
}

function dirSizeMb(dir: string): number {
  let total = 0;
  const stack: string[] = [dir];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(cur);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(cur, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        stack.push(full);
      } else {
        total += st.size;
      }
    }
  }
  return Math.round((total / (1024 * 1024)) * 10) / 10;
}

function runGit(args: string[], cwd: string): { stdout: string; stderr: string; code: number } {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  });
  return {
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
    code: result.status ?? -1,
  };
}

function cloneOne(repo: RepoEntry): CloneResult {
  const slug = slugify(repo.name);
  const cloneDir = join(CORPUS_DIR, slug);
  const cloneUrl = `https://github.com/${repo.name}.git`;

  // Cache check
  if (existsSync(cloneDir)) {
    const head = runGit(["rev-parse", "HEAD"], cloneDir);
    if (head.code === 0 && head.stdout === repo.commit_sha) {
      return {
        name: repo.name,
        sha_pinned: repo.commit_sha,
        sha_actual: head.stdout,
        size_mb: dirSizeMb(cloneDir),
        status: "cache_hit",
      };
    }
    // Cache invalid: nuke and reclone
    try {
      rmSync(cloneDir, { recursive: true, force: true });
    } catch (err) {
      return {
        name: repo.name,
        sha_pinned: repo.commit_sha,
        sha_actual: null,
        size_mb: null,
        status: "error",
        error: `cache invalidation failed: ${(err as Error).message}`,
      };
    }
  }

  // Fresh clone (shallow, no checkout)
  const cloneRes = runGit(
    ["clone", "--depth", "1", "--no-checkout", cloneUrl, cloneDir],
    REPO_ROOT
  );
  if (cloneRes.code !== 0) {
    return {
      name: repo.name,
      sha_pinned: repo.commit_sha,
      sha_actual: null,
      size_mb: null,
      status: "error",
      error: `git clone failed: ${cloneRes.stderr}`,
    };
  }

  // Fetch the specific commit (shallow clone alone may not contain it)
  const fetchRes = runGit(
    ["fetch", "--depth", "1", "origin", repo.commit_sha],
    cloneDir
  );
  if (fetchRes.code !== 0) {
    return {
      name: repo.name,
      sha_pinned: repo.commit_sha,
      sha_actual: null,
      size_mb: null,
      status: "error",
      error: `git fetch <sha> failed: ${fetchRes.stderr}`,
    };
  }

  // Checkout pinned SHA
  const checkoutRes = runGit(["checkout", repo.commit_sha], cloneDir);
  if (checkoutRes.code !== 0) {
    return {
      name: repo.name,
      sha_pinned: repo.commit_sha,
      sha_actual: null,
      size_mb: null,
      status: "error",
      error: `git checkout <sha> failed: ${checkoutRes.stderr}`,
    };
  }

  // Verify HEAD matches pinned SHA
  const headRes = runGit(["rev-parse", "HEAD"], cloneDir);
  if (headRes.code !== 0) {
    return {
      name: repo.name,
      sha_pinned: repo.commit_sha,
      sha_actual: null,
      size_mb: null,
      status: "clone_silent_fail",
      error: `rev-parse HEAD failed post-checkout: ${headRes.stderr}`,
    };
  }

  if (headRes.stdout !== repo.commit_sha) {
    return {
      name: repo.name,
      sha_pinned: repo.commit_sha,
      sha_actual: headRes.stdout,
      size_mb: dirSizeMb(cloneDir),
      status: "sha_mismatch",
      error: `HEAD ${headRes.stdout} != pinned ${repo.commit_sha}`,
    };
  }

  return {
    name: repo.name,
    sha_pinned: repo.commit_sha,
    sha_actual: headRes.stdout,
    size_mb: dirSizeMb(cloneDir),
    status: "fresh_clone",
  };
}

function main(): void {
  if (!existsSync(CORPUS_JSON)) {
    console.error(`[corpus-clone] FATAL: ${CORPUS_JSON} not found`);
    exit(1);
  }

  const raw = readFileSync(CORPUS_JSON, "utf-8");
  const corpus: CorpusJson = JSON.parse(raw) as CorpusJson;

  const filterName = argv[2];
  const targets: RepoEntry[] = filterName
    ? corpus.repositories.filter((r) => r.name === filterName)
    : corpus.repositories;

  if (targets.length === 0) {
    console.error(`[corpus-clone] FATAL: no repos match filter "${filterName ?? ""}"`);
    exit(1);
  }

  console.error(
    `[corpus-clone] cloning ${targets.length} repo(s) into ${CORPUS_DIR}`
  );

  const results: CloneResult[] = [];
  let allOk = true;
  for (const repo of targets) {
    console.error(`[corpus-clone] >> ${repo.name} @ ${repo.commit_sha.slice(0, 8)}`);
    const result = cloneOne(repo);
    results.push(result);
    console.log(JSON.stringify(result));
    if (
      result.status === "error" ||
      result.status === "sha_mismatch" ||
      result.status === "clone_silent_fail"
    ) {
      allOk = false;
    }
  }

  // Summary to stderr (stdout is JSON-lines for parsing)
  console.error("");
  console.error("[corpus-clone] summary:");
  for (const r of results) {
    const sizeStr = r.size_mb !== null ? `${r.size_mb} MB` : "n/a";
    console.error(
      `  ${r.status.padEnd(22)} ${r.name.padEnd(32)} ${sizeStr}`
    );
  }

  exit(allOk ? 0 : 1);
}

main();