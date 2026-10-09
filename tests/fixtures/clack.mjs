import * as p from '@clack/prompts';
p.intro('scaffold');
const fw = await p.select({ message: 'Select a framework:', options: [{ value: 'vanilla', label: 'Vanilla' }, { value: 'vue', label: 'Vue' }, { value: 'react', label: 'React' }, { value: 'svelte', label: 'Svelte' }] });
const install = await p.confirm({ message: 'Install dependencies?' });
p.outro('done');
console.log('RESULT ' + JSON.stringify({ fw, install }));
