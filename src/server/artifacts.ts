import * as fs from "node:fs";
import * as path from "node:path";
import { projectDir } from "./store.ts";

type ArtifactManifest = {
  buildSha: string;
  assets: Record<string, { file: string; map?: string }>;
};

export function addArtifacts(
  rootDir: string,
  projectId: string,
  distDir: string,
  buildSha: string,
): void {
  const artifactRoot = path.join(projectDir(rootDir, projectId), "artifacts", buildSha, "assets");
  fs.mkdirSync(artifactRoot, { recursive: true });

  const assets: ArtifactManifest["assets"] = {};

  // walk distDir, copy JS and map files
  const files = walkDir(distDir);
  for (const file of files) {
    const ext = path.extname(file);
    if (ext !== ".js" && ext !== ".mjs" && ext !== ".map") continue;

    const relative = path.relative(distDir, file);
    const dest = path.join(artifactRoot, relative);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(file, dest);

    if (ext === ".js" || ext === ".mjs") {
      const mapPath = file + ".map";
      const mapRelative = relative + ".map";
      assets[relative] = {
        file: relative,
        map: fs.existsSync(mapPath) ? mapRelative : undefined,
      };
    }
  }

  // try to ingest Vite manifest
  const viteManifest = path.join(distDir, ".vite", "manifest.json");
  if (!fs.existsSync(viteManifest)) {
    // older vite layout
    const altManifest = path.join(distDir, "manifest.json");
    if (fs.existsSync(altManifest)) {
      mergeViteManifest(altManifest, assets);
    }
  } else {
    mergeViteManifest(viteManifest, assets);
  }

  const manifest: ArtifactManifest = { buildSha, assets };
  const manifestPath = path.join(path.dirname(artifactRoot), "manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
}

function mergeViteManifest(
  viteManifestPath: string,
  assets: ArtifactManifest["assets"],
): void {
  try {
    const vite = JSON.parse(fs.readFileSync(viteManifestPath, "utf8")) as Record<
      string,
      { file?: string; src?: string }
    >;
    for (const entry of Object.values(vite)) {
      if (entry.file && !assets[entry.file]) {
        assets[entry.file] = { file: entry.file };
      }
    }
  } catch {
    // ignore
  }
}

function walkDir(dir: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkDir(full));
    } else {
      results.push(full);
    }
  }
  return results;
}
