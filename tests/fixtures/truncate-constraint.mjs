// A schema-sync tool adding a unique constraint to a non-empty table (shape of drizzle-kit push).
// argv[2] = "only-truncate": no declining choice is offered, the only way forward truncates.
import { select } from '@inquirer/prompts';
const onlyTruncate = process.argv[2] === 'only-truncate';
console.log('[✓] Pulling schema from database...');
const choices = onlyTruncate
  ? [{ name: 'Yes, truncate the table', value: 'truncate' }, { name: 'Abort', value: 'abort' }]
  : [{ name: 'No, add the constraint without truncating the table', value: 'keep' }, { name: 'Yes, truncate the table', value: 'truncate' }];
const answer = await select({
  message: "· You're about to add bank_account_organization_id_id_uq unique constraint to the table, which contains 4 items. If this statement fails, you will receive an error from the database. Do you want to truncate bank_account table?",
  choices,
});
console.log(`RESULT ${answer}`);
process.exit(answer === 'truncate' ? 4 : 0);
