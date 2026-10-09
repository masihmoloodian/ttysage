import { select } from '@inquirer/prompts';
console.log('Comparing schema with the database...');
console.log('');
console.log(' ~ rename column users.name -> users.full_name');
console.log(' - drop column users.legacy_email (3 rows have values)');
console.log('');
console.log('⚠ Warning: this operation will cause data loss and cannot be undone.');
const answer = await select({ message: 'Do you still want to apply these changes?', choices: [{ name: 'No, abort', value: 'no' }, { name: 'Yes, apply changes', value: 'yes' }] });
if (answer === 'yes') { console.log('APPLIED'); process.exit(0); }
console.log('ABORTED'); process.exit(3);
