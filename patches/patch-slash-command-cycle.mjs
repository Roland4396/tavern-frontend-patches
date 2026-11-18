import fs from 'node:fs';

const target = process.argv[2];

if (!target) {
  console.error('Usage: node patch-slash-command-cycle.mjs <variables.js>');
  process.exit(1);
}

let source = fs.readFileSync(target, 'utf8');

const importNeedle = "import { executeSlashCommandsWithOptions } from './slash-commands.js';\n";
const importReplacement = `let executeSlashCommandsWithOptions;\nasync function getExecuteSlashCommandsWithOptions() {\n    if (!executeSlashCommandsWithOptions) {\n        ({ executeSlashCommandsWithOptions } = await import('./slash-commands.js'));\n    }\n    return executeSlashCommandsWithOptions;\n}\n`;

const callNeedle = "    const result = await executeSlashCommandsWithOptions(command, {\n";
const callReplacement = "    const executeSlashCommandsWithOptions = await getExecuteSlashCommandsWithOptions();\n    const result = await executeSlashCommandsWithOptions(command, {\n";

if (source.includes('async function getExecuteSlashCommandsWithOptions()')) {
  console.log('Slash command cycle patch already present');
  process.exit(0);
}

if (!source.includes(importNeedle) || !source.includes(callNeedle)) {
  console.error('Expected variables.js patterns not found');
  process.exit(2);
}

source = source.replace(importNeedle, importReplacement);
source = source.replace(callNeedle, callReplacement);

fs.writeFileSync(target, source);
console.log(`Patched slash command cycle in ${target}`);
