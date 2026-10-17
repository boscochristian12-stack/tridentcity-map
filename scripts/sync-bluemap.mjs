import { createWriteStream } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";

const token = process.env.EXAROTON_API_TOKEN;
const serverAddress = process.env.EXAROTON_SERVER_ADDRESS;
const repository = process.env.GITHUB_REPOSITORY;
const remoteRoot = "bluemap/web";
const siteDirectory = path.join(process.cwd(), "site");
const apiRoot = "https://api.exaroton.com/v1";
const maxSiteBytes = 900 * 1024 * 1024;

if (!token) throw new Error("EXAROTON_API_TOKEN is not configured.");
if (!serverAddress) throw new Error("EXAROTON_SERVER_ADDRESS is not configured.");
if (!repository || !repository.includes("/")) throw new Error("GITHUB_REPOSITORY is not available.");

function encodeRemotePath(remotePath) {
  return remotePath.split("/").map(encodeURIComponent).join("/");
}

function endpoint(kind, serverId, remotePath) {
  const pathPart = remotePath ? encodeRemotePath(remotePath) + "/" : "";
  return apiRoot + "/servers/" + encodeURIComponent(serverId) + "/files/" + kind + "/" + pathPart;
}

async function getJson(url) {
  const response = await fetch(url, {
    headers: {
      Authorization: "Bearer " + token,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error("exaroton API request failed with HTTP " + response.status + ".");
  }

  const payload = await response.json();
  if (!payload || payload.success !== true) {
    throw new Error("exaroton API did not return a successful response.");
  }
  return payload.data;
}

async function getFileInfo(serverId, remotePath) {
  return getJson(endpoint("info", serverId, remotePath));
}

const serverList = await getJson(apiRoot + "/servers/");
const matchingServers = (Array.isArray(serverList) ? serverList : []).filter(
  (server) => String(server.address || "").toLowerCase() === serverAddress.toLowerCase(),
);

if (matchingServers.length !== 1) {
  throw new Error("Could not identify exactly one exaroton server by its configured address.");
}

const server = matchingServers[0];
const files = [];
const visitedDirectories = new Set();
let skippedPhpFiles = 0;

async function collectFiles(remotePath, depth = 0) {
  if (depth > 100) throw new Error("BlueMap directory nesting is unexpectedly deep.");

  const normalizedDirectory = path.posix.normalize(remotePath).replace(/^\/+/, "");
  if (visitedDirectories.has(normalizedDirectory)) {
    throw new Error("The exaroton file listing contains a repeated directory.");
  }
  visitedDirectories.add(normalizedDirectory);

  const info = await getFileInfo(server.id, normalizedDirectory);
  if (!info || info.isDirectory !== true || !Array.isArray(info.children)) {
    throw new Error("Could not list the configured BlueMap web directory.");
  }

  for (const child of info.children) {
    const childName = String(child.name || "");
    const childPath = path.posix.normalize(
      String(child.path || path.posix.join(normalizedDirectory, childName)),
    ).replace(/^\/+/, "");
    const relativePath = path.posix.relative(remoteRoot, childPath);

    if (
      !childName ||
      !relativePath ||
      relativePath === ".." ||
      relativePath.startsWith("../") ||
      path.posix.isAbsolute(relativePath)
    ) {
      throw new Error("The exaroton file listing contains an unsafe path.");
    }

    if (child.isDirectory === true) {
      await collectFiles(childPath, depth + 1);
      continue;
    }

    if (path.posix.extname(childName).toLowerCase() === ".php") {
      skippedPhpFiles += 1;
      continue;
    }

    const size = Number(child.size);
    if (!Number.isFinite(size) || size < 0) {
      throw new Error("A BlueMap file has no valid size, so the Pages size limit cannot be checked.");
    }

    files.push({ remotePath: childPath, relativePath, size });
    if (files.length > 500000) {
      throw new Error("The BlueMap file count exceeds the safe sync limit.");
    }
  }
}

await collectFiles(remoteRoot);

if (!files.some((file) => file.relativePath === "index.html")) {
  throw new Error("The configured BlueMap web directory does not contain index.html.");
}

const mapTileFiles = files.filter(
  (file) =>
    /^maps\/[^/]+\/tiles\//i.test(file.relativePath) &&
    /\.(?:prbm(?:\.gz)?|png)$/i.test(file.relativePath),
);
if (!mapTileFiles.length) {
  throw new Error("No rendered BlueMap tile files were found under maps/<map>/tiles.");
}
console.log(
  "Found " +
    mapTileFiles.length +
    " map tile files; examples: " +
    mapTileFiles.slice(0, 3).map((file) => file.relativePath).join(", "),
);

const totalBytes = files.reduce((total, file) => total + file.size, 0);
if (totalBytes > maxSiteBytes) {
  throw new Error(
    "The BlueMap site is larger than the 900 MiB safety limit for this GitHub Pages deployment.",
  );
}

await rm(siteDirectory, { recursive: true, force: true });
await mkdir(siteDirectory, { recursive: true });
await writeFile(path.join(siteDirectory, ".nojekyll"), "");

let nextFile = 0;
async function downloadWorker() {
  while (nextFile < files.length) {
    const file = files[nextFile];
    nextFile += 1;

    const destination = path.join(siteDirectory, ...file.relativePath.split("/"));
    await mkdir(path.dirname(destination), { recursive: true });

    const response = await fetch(endpoint("data", server.id, file.remotePath), {
      headers: { Authorization: "Bearer " + token },
    });

    if (!response.ok || !response.body) {
      throw new Error("A BlueMap file download failed with HTTP " + response.status + ".");
    }

    await pipeline(Readable.fromWeb(response.body), createWriteStream(destination));
  }
}

await Promise.all(Array.from({ length: Math.min(4, files.length) }, () => downloadWorker()));

const settingsPath = path.join(siteDirectory, "settings.json");
const settings = JSON.parse(await readFile(settingsPath, "utf8"));
if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
  throw new Error("BlueMap settings.json does not contain a JSON object.");
}
settings.clientDecompression = true;
await writeFile(settingsPath, JSON.stringify(settings, null, 2) + "\n");

const repositoryName = repository.split("/")[1];
const indexPath = path.join(siteDirectory, "index.html");
let html = await readFile(indexPath, "utf8");
if (!/<base\b/i.test(html)) {
  const headTag = html.match(/<head\b[^>]*>/i);
  if (!headTag) throw new Error("BlueMap index.html has no head element.");
  html = html.replace(headTag[0], headTag[0] + '\n    <base href="/' + repositoryName + '/">');
  await writeFile(indexPath, html);
}

console.log(
  "Synced " +
    files.length +
    " BlueMap files (" +
    (totalBytes / 1024 / 1024).toFixed(1) +
    " MiB); skipped " +
    skippedPhpFiles +
    " PHP file(s).",
);
