import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { classifyUpdaterSignature } from './buildUpdaterManifest.mjs';

const REQUIRED = new Map([
  ['.dmg', 'macos'],
  ['.exe', 'windows'],
  ['.AppImage', 'linux-appimage'],
  ['.deb', 'linux-deb'],
]);

const UPDATER_BUNDLE_SUFFIXES = ['.app.tar.gz', '.nsis.zip'];

async function regularFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await regularFiles(entryPath)));
    if (entry.isFile()) files.push(entryPath);
  }

  return files;
}

async function canonicalPath(targetPath) {
  let existingPath = path.resolve(targetPath);
  const missingParts = [];

  while (true) {
    try {
      return path.join(await realpath(existingPath), ...missingParts.reverse());
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const parent = path.dirname(existingPath);
      if (parent === existingPath) throw error;
      missingParts.push(path.basename(existingPath));
      existingPath = parent;
    }
  }
}

function containsPath(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

async function assertSeparateDirectories(inputDir, outputDir) {
  const [inputPath, outputPath] = await Promise.all([
    canonicalPath(inputDir),
    canonicalPath(outputDir),
  ]);
  if (containsPath(inputPath, outputPath) || containsPath(outputPath, inputPath)) {
    throw new Error(
      `Input and output directories must not overlap: ${inputPath} and ${outputPath}`,
    );
  }
}

function classify(filename) {
  for (const [suffix, kind] of REQUIRED) {
    if (filename.endsWith(suffix)) return kind;
  }
  if (filename === 'latest.json') return 'updater-manifest';
  if (filename.endsWith('.sig')) {
    // Throws its own descriptive error for an unrecognized suffix — let
    // it propagate as-is rather than wrapping it in "Unsupported artifact".
    // Keyed per-platform (not a single shared 'updater-signature' kind) so the
    // darwin/windows/linux signature files don't collide as duplicate kinds.
    const platform = classifyUpdaterSignature(filename);
    return `updater-signature:${platform}`;
  }
  // The payloads those .sig files sign, and what latest.json's URLs point
  // at. Accepted but never required — an unsigned build produces none, and
  // Linux's .deb has no updater bundle at all.
  const bundleSuffix = UPDATER_BUNDLE_SUFFIXES.find((suffix) => filename.endsWith(suffix));
  if (bundleSuffix) return `updater-bundle:${bundleSuffix}`;
  throw new Error(`Unsupported artifact: ${filename}`);
}

export async function collectAlphaArtifacts(inputDir) {
  const files = await regularFiles(inputDir);
  const artifactsByKind = new Map();
  const filenames = new Set();

  for (const sourcePath of files) {
    const filename = path.basename(sourcePath);
    if (filenames.has(filename)) {
      throw new Error(`Duplicate artifact filename: ${filename}`);
    }
    filenames.add(filename);

    const kind = classify(filename);
    if (artifactsByKind.has(kind)) {
      throw new Error(`Duplicate artifact kind ${kind}: ${filename}`);
    }
    artifactsByKind.set(kind, { sourcePath, filename, kind });
  }

  const missing = [...REQUIRED.values()].filter((kind) => !artifactsByKind.has(kind));
  if (missing.length > 0) {
    throw new Error(`Missing required artifact kinds: ${missing.join(', ')}`);
  }

  return [...artifactsByKind.values()];
}

async function sha256(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

export async function prepareAlphaAssets(inputDir, outputDir) {
  await assertSeparateDirectories(inputDir, outputDir);
  const artifacts = await collectAlphaArtifacts(inputDir);
  const filenames = artifacts.map(({ filename }) => filename).sort();

  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const checksums = [];
  for (const filename of filenames) {
    const artifact = artifacts.find((candidate) => candidate.filename === filename);
    const destination = path.join(outputDir, filename);
    await copyFile(artifact.sourcePath, destination);
    checksums.push(`${await sha256(destination)}  ${filename}`);
  }
  await writeFile(path.join(outputDir, 'SHA256SUMS.txt'), `${checksums.join('\n')}\n`);

  return filenames;
}

async function runCli() {
  const args = process.argv.slice(2);
  if (args.length !== 2) {
    throw new Error('Usage: node scripts/prepareAlphaAssets.mjs <download-dir> <release-dir>');
  }
  const filenames = await prepareAlphaAssets(args[0], args[1]);
  console.log(filenames.join('\n'));
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    await runCli();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
