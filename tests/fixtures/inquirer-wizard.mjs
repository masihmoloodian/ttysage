import { input, select, confirm } from '@inquirer/prompts';
const name = await input({ message: 'Project name:', default: 'demo-app' });
const db = await select({ message: 'Select a database:', choices: ['PostgreSQL', 'MySQL', 'SQLite'].map((v) => ({ value: v, name: v })) });
const go = await confirm({ message: 'Create the project now?', default: true });
console.log('RESULT ' + JSON.stringify({ name, db, go }));
