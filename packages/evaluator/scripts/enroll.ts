import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Store } from '../src/store.ts';

const [id, collectionId, model, publicKeyFile] = process.argv.slice(2);
if (!publicKeyFile || process.argv.length !== 6)
  throw new Error(
    'Usage: node scripts/enroll.ts <client-id> <opaque-collection-id> <model-id> <public-key-file>',
  );
const directory = path.resolve(process.env.EVALUATOR_DATA_DIR ?? '.data');
mkdirSync(directory, { recursive: true });
const store = new Store(path.join(directory, 'evaluator.sqlite'));
try {
  store.enroll({
    id,
    collection_id: collectionId,
    model,
    public_key: readFileSync(publicKeyFile, 'utf8'),
  });
  console.log('Agent public identity enrolled. No scores or profiles edited.');
} finally {
  store.close();
}
