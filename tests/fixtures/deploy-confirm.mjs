import { select } from '@inquirer/prompts';
console.log('Built 12 files for the staging environment.');
const a = await select({ message: 'Deploy this build to staging now?', choices: [{ name: 'No', value: 'no' }, { name: 'Yes', value: 'yes' }] });
console.log(a === 'yes' ? 'DEPLOYED' : 'SKIPPED');
