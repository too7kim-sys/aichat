/**
 * File System Access API helpers.
 *
 * Chromium-only; we gate the entire project feature on the presence of
 * window.showDirectoryPicker.
 */

export function isFsAccessSupported(): boolean {
  return typeof (window as unknown as { showDirectoryPicker?: unknown })
    .showDirectoryPicker === "function";
}

export interface ProjectFile {
  /** Repo-relative path, e.g., "src/App.tsx". */
  path: string;
  /** Just the basename, e.g., "App.tsx". */
  name: string;
  /** Underlying FileSystemFileHandle for reads/writes. */
  handle: FileSystemFileHandle;
  size: number;
}

export interface ProjectTreeNode {
  kind: "dir" | "file";
  name: string;
  path: string;
  /** Defined for files only. */
  file?: ProjectFile;
  /** Defined for directories only. */
  children?: ProjectTreeNode[];
}

// Heuristics so we don't drown the tree in vendor/build output.
const SKIP_DIRS = new Set([
  "node_modules", ".git", "__pycache__", ".venv", "venv",
  "dist", "build", ".next", ".cache", ".vite", ".turbo",
  ".idea", ".vscode", "target", ".pytest_cache", ".mypy_cache",
]);
const MAX_DEPTH = 8;
const MAX_FILE_BYTES = 1024 * 1024; // 1 MB per file when reading into context

export async function pickProjectRoot(): Promise<FileSystemDirectoryHandle> {
  const w = window as unknown as {
    showDirectoryPicker: (opts?: {
      mode?: "read" | "readwrite";
    }) => Promise<FileSystemDirectoryHandle>;
  };
  return w.showDirectoryPicker({ mode: "readwrite" });
}

export async function ensureReadWrite(
  handle: FileSystemDirectoryHandle | FileSystemFileHandle
): Promise<boolean> {
  const h = handle as FileSystemDirectoryHandle & {
    queryPermission?: (opts: { mode: "readwrite" }) => Promise<PermissionState>;
    requestPermission?: (opts: { mode: "readwrite" }) => Promise<PermissionState>;
  };
  if (!h.queryPermission || !h.requestPermission) return true;
  const current = await h.queryPermission({ mode: "readwrite" });
  if (current === "granted") return true;
  const next = await h.requestPermission({ mode: "readwrite" });
  return next === "granted";
}

export async function buildTree(
  dir: FileSystemDirectoryHandle,
  basePath = "",
  depth = 0
): Promise<ProjectTreeNode[]> {
  if (depth >= MAX_DEPTH) {
    return [
      {
        kind: "dir",
        name: "… (max depth reached)",
        path: `${basePath}/__truncated__`,
        children: [],
      },
    ];
  }
  const out: ProjectTreeNode[] = [];
  for await (const [name, child] of (dir as unknown as AsyncIterable<
    [string, FileSystemHandle]
  >)) {
    // Skip hidden entries and known vendor/build folders.
    if (name.startsWith(".")) continue;
    if (SKIP_DIRS.has(name)) continue;
    const path = basePath ? `${basePath}/${name}` : name;
    if (child.kind === "directory") {
      const children = await buildTree(child as FileSystemDirectoryHandle, path, depth + 1);
      out.push({ kind: "dir", name, path, children });
    } else {
      const fh = child as FileSystemFileHandle;
      let size = 0;
      try {
        const f = await fh.getFile();
        size = f.size;
      } catch {
        // ignore — couldn't stat
      }
      out.push({
        kind: "file",
        name,
        path,
        file: { path, name, handle: fh, size },
      });
    }
  }
  // dirs first, then files; alphabetical within each
  out.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return out;
}

export async function readFileText(file: ProjectFile): Promise<string> {
  const blob = await file.handle.getFile();
  if (blob.size > MAX_FILE_BYTES) {
    throw new Error(`파일이 1MB를 초과합니다 (${blob.size} bytes)`);
  }
  return blob.text();
}

export async function writeFile(
  root: FileSystemDirectoryHandle,
  relativePath: string,
  content: string
): Promise<void> {
  const ok = await ensureReadWrite(root);
  if (!ok) throw new Error("쓰기 권한이 거부되었습니다.");
  const parts = relativePath.split("/").filter(Boolean);
  if (parts.length === 0) throw new Error("경로가 비어 있습니다.");
  const fileName = parts.pop()!;
  let dir = root;
  for (const seg of parts) {
    dir = await dir.getDirectoryHandle(seg, { create: true });
  }
  const fh = await dir.getFileHandle(fileName, { create: true });
  const writable = await (fh as FileSystemFileHandle & {
    createWritable: () => Promise<FileSystemWritableFileStream>;
  }).createWritable();
  await writable.write(content);
  await writable.close();
}
