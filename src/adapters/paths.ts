import { LibraryError } from "./types.js";

/**
 * Split a library-relative path into segments, refusing anything that could
 * escape the library root. Shared by every adapter — none of them can
 * actually reach outside their storage, but failing loudly here beats a
 * confusing error three frames deep in each one's own internals.
 */
export function assertRelativeSegments(relPath: string): string[] {
  if (relPath.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(relPath)) {
    throw new LibraryError(
      "out-of-root",
      `absolute paths are unreachable here: "${relPath}". Keep audio and assets inside the library.`,
    );
  }
  const parts = relPath.split(/[\\/]+/).filter((p) => p.length > 0 && p !== ".");
  if (parts.some((p) => p === "..")) {
    throw new LibraryError("out-of-root", `path escapes the library root: "${relPath}"`);
  }
  return parts;
}
