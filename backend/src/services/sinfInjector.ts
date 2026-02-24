import AdmZip from "adm-zip";
import bplistParser from "bplist-parser";
import bplistCreator from "bplist-creator";
import plist from "plist";
import type { Sinf } from "../types/index.js";

export async function inject(
  sinfs: Sinf[],
  ipaPath: string,
  iTunesMetadata?: string,
): Promise<void> {
  const zip = new AdmZip(ipaPath);
  const entries = zip.getEntries();

  const bundleName = readBundleName(entries);

  const manifest = readManifestPlist(zip, entries);
  if (manifest) {
    injectFromManifest(zip, manifest, sinfs, bundleName);
  } else {
    const info = readInfoPlist(zip, entries);
    if (info) {
      injectFromInfo(zip, info, sinfs, bundleName);
    } else {
      throw new Error("Could not read manifest or info plist");
    }
  }

  // Inject iTunesMetadata.plist at the archive root if provided
  // Frontend sends base64-encoded XML plist; convert to binary plist
  // to match Apple's native format (PropertyListSerialization .binary)
  if (iTunesMetadata) {
    const xmlBuffer = Buffer.from(iTunesMetadata, "base64");
    const xmlString = xmlBuffer.toString("utf-8");
    try {
      const parsed = plist.parse(xmlString);
      const binaryBuffer = bplistCreator(parsed as Record<string, unknown>);
      zip.addFile("iTunesMetadata.plist", binaryBuffer);
    } catch {
      // Fallback: inject as-is if conversion fails
      zip.addFile("iTunesMetadata.plist", xmlBuffer);
    }
  }

  zip.writeZip(ipaPath);
}

function readBundleName(entries: AdmZip.IZipEntry[]): string {
  for (const entry of entries) {
    const entryPath = entry.entryName;
    if (
      entryPath.includes(".app/Info.plist") &&
      !entryPath.includes("/Watch/")
    ) {
      const components = entryPath.split("/");
      for (let i = 0; i < components.length; i++) {
        if (components[i].endsWith(".app")) {
          return components[i].replace(".app", "");
        }
      }
    }
  }
  throw new Error("Could not read bundle name");
}

function parsePlistBuffer(data: Buffer): Record<string, unknown> | null {
  // Try binary plist first
  try {
    const parsed = bplistParser.parseBuffer(data);
    if (parsed && parsed.length > 0) {
      return parsed[0] as Record<string, unknown>;
    }
  } catch {
    // Not binary plist, try XML
  }

  // Try XML plist
  try {
    const xml = data.toString("utf-8");
    if (xml.includes("<?xml") || xml.includes("<plist")) {
      const parsed = plist.parse(xml);
      if (parsed && typeof parsed === "object") {
        return parsed as Record<string, unknown>;
      }
    }
  } catch {
    // Not valid XML plist either
  }

  return null;
}

function readManifestPlist(
  zip: AdmZip,
  entries: AdmZip.IZipEntry[],
): { sinfPaths: string[] } | null {
  for (const entry of entries) {
    if (entry.entryName.endsWith(".app/SC_Info/Manifest.plist")) {
      const data = zip.readFile(entry);
      if (!data) continue;
      const parsed = parsePlistBuffer(data);
      if (parsed) {
        const sinfPaths = parsed["SinfPaths"];
        if (Array.isArray(sinfPaths)) {
          return { sinfPaths: sinfPaths as string[] };
        }
      }
      return null;
    }
  }
  return null;
}

function readInfoPlist(
  zip: AdmZip,
  entries: AdmZip.IZipEntry[],
): { bundleExecutable: string } | null {
  for (const entry of entries) {
    if (
      entry.entryName.includes(".app/Info.plist") &&
      !entry.entryName.includes("/Watch/")
    ) {
      const data = zip.readFile(entry);
      if (!data) continue;
      const parsed = parsePlistBuffer(data);
      if (parsed) {
        const executable = parsed["CFBundleExecutable"];
        if (typeof executable === "string") {
          return { bundleExecutable: executable };
        }
      }
      return null;
    }
  }
  return null;
}

function injectFromManifest(
  zip: AdmZip,
  manifest: { sinfPaths: string[] },
  sinfs: Sinf[],
  bundleName: string,
): void {
  for (let i = 0; i < manifest.sinfPaths.length; i++) {
    if (i >= sinfs.length) continue;
    const sinfPath = manifest.sinfPaths[i];
    const fullPath = `Payload/${bundleName}.app/${sinfPath}`;
    const sinfData = Buffer.from(sinfs[i].sinf, "base64");
    zip.addFile(fullPath, sinfData);
  }
}

function injectFromInfo(
  zip: AdmZip,
  info: { bundleExecutable: string },
  sinfs: Sinf[],
  bundleName: string,
): void {
  if (sinfs.length === 0) return;
  const sinfPath = `Payload/${bundleName}.app/SC_Info/${info.bundleExecutable}.sinf`;
  const sinfData = Buffer.from(sinfs[0].sinf, "base64");
  zip.addFile(sinfPath, sinfData);
}
