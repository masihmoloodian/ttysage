import enquirer from 'enquirer';
const { pm } = await enquirer.prompt({ type: 'select', name: 'pm', message: 'Package manager', choices: ['npm', 'pnpm', 'yarn'] });
console.log('RESULT ' + JSON.stringify({ pm }));
