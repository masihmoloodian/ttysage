import prompts from 'prompts';
const r = await prompts([
  { type: 'toggle', name: 'ts', message: 'Use TypeScript?', initial: true, active: 'yes', inactive: 'no' },
  { type: 'select', name: 'color', message: 'Pick a color', choices: [{ title: 'Red', value: 'red' }, { title: 'Green', value: 'green' }, { title: 'Blue', value: 'blue' }], initial: 0 },
  { type: 'text', name: 'title', message: 'Title', initial: 'untitled' },
]);
console.log('RESULT ' + JSON.stringify(r));
