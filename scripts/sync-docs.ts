import { execSync } from 'child_process';
import { existsSync } from 'fs';
import path from 'path';

const DOCS_REPO = 'https://github.com/jito-foundation/jito-omnidocs.git';
const DOCS_DIR = path.join(process.cwd(), 'docs');

function syncDocs() {
  console.log('Syncing documentation repository...');

  // Add token to the URL if available
  const token = process.env.TOKEN_GITHUB;
  const repoUrl = token 
    ? `https://${token}@github.com/jito-foundation/jito-omnidocs.git`
    : DOCS_REPO;

  if (!existsSync(DOCS_DIR)) {
    console.log('Cloning docs repository...');
    execSync(`git clone ${repoUrl} ${DOCS_DIR}`);
  } else {
    console.log('Updating docs repository...');
    execSync('git pull origin master', { cwd: DOCS_DIR });
  }

  console.log('Documentation sync complete!');
}

// Run if called directly
if (require.main === module) {
  syncDocs();
}

export { syncDocs }; 