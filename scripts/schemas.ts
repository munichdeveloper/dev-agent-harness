import { mkdir, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { requestSchema, resultSchema } from '../src/contract.js';
await mkdir('schemas', { recursive: true });
for (const [name, schema] of Object.entries({ request: requestSchema, result: resultSchema })) {
  await writeFile(`schemas/${name}.schema.json`, JSON.stringify(z.toJSONSchema(schema), null, 2) + '\n');
}
