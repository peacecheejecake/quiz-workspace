// Generates src/generated/schema.ts from contracts/openapi.json (never hand-edit the output).
//
//   node scripts/generate.ts           # write
//   node scripts/generate.ts --check   # exit 1 if the committed file is stale
//
// The Python side owns the contract: `make contracts` exports it and then runs this script.
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import openapiTS, { astToString } from 'openapi-typescript';
import { format, resolveConfig } from 'prettier';

const contractUrl = new URL('../../../contracts/openapi.json', import.meta.url);
const outputPath = fileURLToPath(new URL('../src/generated/schema.ts', import.meta.url));

const HEADER = `// Generated from contracts/openapi.json by scripts/generate.ts. Do not edit.
// Regenerate with \`make contracts\`.
/* eslint-disable */
`;

export async function renderSchema(): Promise<string> {
  const contract: unknown = JSON.parse(await readFile(contractUrl, 'utf8'));
  const ast = await openapiTS(contract as Parameters<typeof openapiTS>[0], {
    alphabetize: true,
    exportType: true,
    // Fields with a default stay optional: the API omits `None` fields (e.g. Problem.detail).
    defaultNonNullable: false,
  });
  const source = HEADER + '\n' + astToString(ast);
  const config = (await resolveConfig(outputPath)) ?? {};
  return format(source, { ...config, filepath: outputPath });
}

async function main(): Promise<number> {
  const rendered = await renderSchema();
  if (process.argv.includes('--check')) {
    const current = await readFile(outputPath, 'utf8').catch(() => null);
    if (current !== rendered) {
      console.error(
        'src/generated/schema.ts is stale. Run `make contracts` and commit the result.',
      );
      return 1;
    }
    console.log('src/generated/schema.ts is up to date.');
    return 0;
  }
  await writeFile(outputPath, rendered, 'utf8');
  console.log('Wrote src/generated/schema.ts.');
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
