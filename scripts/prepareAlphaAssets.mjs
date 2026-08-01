import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const REQUIRED = new Map([
  ['.dmg', 'macos'],
  ['.exe', 'windows'],
  ['.AppImage', 'linux-appimage'],
  ['.deb', 'linux-deb'],
]);

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

function classify(filename) {
  for (const [suffix, kind] of REQUIRED) {
    if (filename.endsWith(suffix)) return kind;
  }
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

  return [...REQUIRED.values()].map((kind) => artifactsByKind.get(kind));
}

async function sha256(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

export async function prepareAlphaAssets(inputDir, outputDir) {
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
