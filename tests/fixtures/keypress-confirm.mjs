import prompts from 'prompts';
const r = await prompts([
  { type: 'confirm', name: 'ok', message: 'Overwrite the existing sample files?' },
  { type: 'text', name: 'name', message: 'Name for the sample' },
]);
console.log('RESULT ' + JSON.stringify(r));
