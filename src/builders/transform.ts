import type { BuildContext, TransformEntry } from "../types.ts";

import { pathToFileURL } from "node:url";
import { dirname, extname, join, relative } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { consola } from "consola";
import { resolveModulePath } from "exsolve";
import MagicString from "magic-string";
import oxcTransform from "oxc-transform";
import oxcParser from "oxc-parser";
import { fmtPath } from "../utils.ts";

/**
 * Transform all .ts modules in a directory using oxc-transform.
 */
export async function transformDir(
  ctx: BuildContext,
  entry: TransformEntry,
): Promise<void> {
  const start = Date.now();

  const promises: Promise<void>[] = [];

  const { glob } = await import("node:fs/promises");

  for await (const entryName of glob("**/*.*", { cwd: entry.input })) {
    promises.push(
      (async () => {
        const entryPath = join(entry.input, entryName);
        const ext = extname(entryPath);
        switch (ext) {
          case ".ts": {
            {
              const transformed = await transformModule(entryPath);
              const entryDistPath = join(
                entry.outDir!,
                entryName.replace(/\.ts$/, ".mjs"),
              );
              await mkdir(dirname(entryDistPath), { recursive: true });
              await writeFile(entryDistPath, transformed.code, "utf8");
              await writeFile(
                entryDistPath.replace(/\.mjs$/, ".d.mts"),
                transformed.declaration!,
                "utf8",
              );
            }
            break;
          }
          default: {
            {
              const entryDistPath = join(entry.outDir!, entryName);
              await mkdir(dirname(entryDistPath), { recursive: true });
              await writeFile(entryDistPath, await readFile(entryPath), "utf8");
            }
            break;
          }
        }
      })(),
    );
  }

  await Promise.all(promises);

  consola.log(
    `Transformed ${promises.length} files from \`${fmtPath(entry.input!)}\` to \`${fmtPath(entry.outDir!)}\` in ${Date.now() - start}ms`,
  );
}

/**
 * Transform a .ts module using oxc-transform.
 */
async function transformModule(entryPath: string) {
  let sourceText = await readFile(entryPath, "utf8");

  const sourceOptions = {
    lang: "ts",
    sourceType: "module",
  } as const;

  const parsed = oxcParser.parseSync(entryPath, sourceText, {
    ...sourceOptions,
  });

  if (parsed.errors.length > 0) {
    throw new Error(`Errors while parsing ${entryPath}:`, {
      cause: parsed.errors,
    });
  }

  const magicString = new MagicString(sourceText);

  // Rewrite relative imports
  const updatedStarts = new Set<number>();
  const rewriteSpecifier = (req: {
    value: string;
    start: number;
    end: number;
  }) => {
    const moduleId = req.value;
    if (!moduleId.startsWith(".")) {
      return;
    }
    if (updatedStarts.has(req.start)) {
      return; // prevent double rewritings
    }
    updatedStarts.add(req.start);
    const resolvedAbsolute = resolveModulePath(moduleId, {
      from: pathToFileURL(entryPath),
    });
    const newId = relative(
      dirname(entryPath),
      resolvedAbsolute.replace(/\.ts$/, ".mjs"),
    );
    magicString.remove(req.start, req.end);
    magicString.prependLeft(
      req.start,
      JSON.stringify(newId.startsWith(".") ? newId : `./${newId}`),
    );
  };

  for (const staticImport of parsed.module.staticImports) {
    rewriteSpecifier(staticImport.moduleRequest);
  }

  for (const staticExport of parsed.module.staticExports) {
    for (const staticExportEntry of staticExport.entries) {
      if (staticExportEntry.moduleRequest) {
        rewriteSpecifier(staticExportEntry.moduleRequest);
      }
    }
  }

  sourceText = magicString.toString();

  const transformed = oxcTransform.transform(entryPath, sourceText, {
    ...sourceOptions,
    cwd: dirname(entryPath),
    typescript: { declaration: { stripInternal: true } },
  });

  const transformErrors = transformed.errors.filter(
    (err) => !err.message.includes("--isolatedDeclarations"),
  );

  if (transformErrors.length > 0) {
    // console.log(sourceText);
    await writeFile(
      "build-dump.ts",
      `/** Error dump for ${entryPath} */\n\n` + sourceText,
      "utf8",
    );
    throw new Error(
      `Errors while transforming ${entryPath}: (hint: check build-dump.ts)`,
      {
        cause: transformErrors,
      },
    );
  }

  return transformed;
}
