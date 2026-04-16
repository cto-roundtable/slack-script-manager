#!/usr/bin/env bun

import { Command } from 'commander';
import { config } from 'dotenv';
import { createCompareCommand } from './commands/compare.js';
import { createSyncCommand } from './commands/sync.js';

// Load environment variables
config();

const program = new Command();

program
  .name('slack-member-comparer')
  .description('Compare members between Slack channels')
  .version('1.0.0');

// Add commands
program.addCommand(createCompareCommand());
program.addCommand(createSyncCommand());

// Handle case where no command is provided - default to compare
if (process.argv.length > 2 && !process.argv[2].startsWith('-')) {
  // If first arg is not a flag and not a known command, assume it's for compare
  const knownCommands = ['compare', 'sync', 'help', '--help', '-h', '--version', '-V'];
  if (!knownCommands.includes(process.argv[2])) {
    // Insert 'compare' command
    process.argv.splice(2, 0, 'compare');
  }
}

// Add a default action that shows help
program.action(() => {
  program.help();
});

// Error handling
program.exitOverride();

try {
  program.parse();
} catch (err: any) {
  if (err.code === 'commander.help' || err.code === 'commander.version') {
    process.exit(0);
  } else if (err.code === 'commander.unknownCommand') {
    console.error(`❌ Unknown command: ${err.message}`);
    console.log('\nAvailable commands:');
    program.help();
  } else {
    console.error('❌ An error occurred:', err.message || err);
    process.exit(1);
  }
}

// Show help if no args provided
if (process.argv.length === 2) {
  console.log('🚀 Slack Member Comparer\n');
  program.help();
}
