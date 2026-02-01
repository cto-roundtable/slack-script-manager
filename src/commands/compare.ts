import { Command } from 'commander';
import { Table } from 'console-table-printer';
import { SlackClient } from '../lib/slack.js';
import type { ComparisonOptions } from '../types/index.js';

export function createCompareCommand(): Command {
  const command = new Command('compare');
  
  command
    .description('Compare members between two Slack channels')
    .argument('<channelA>', 'First channel name (with or without # prefix)')
    .argument('<channelB>', 'Second channel name (with or without # prefix)')
    .option('-v, --verbose', 'Show detailed output', false)
    .action(async (channelA: string, channelB: string, options: { verbose?: boolean }) => {
      await executeCompare({
        channelA,
        channelB,
        verbose: options.verbose
      });
    });

  return command;
}

async function executeCompare(options: ComparisonOptions): Promise<void> {
  const token = process.env.SLACK_TOKEN;
  
  if (!token) {
    console.error('❌ SLACK_TOKEN environment variable is required');
    console.error('   Please set your Slack Bot User OAuth Token in .env file');
    process.exit(1);
  }

  const client = new SlackClient(token);

  try {
    // Test connection first
    if (options.verbose) {
      console.log('🔌 Testing Slack connection...');
      const connectionTest = await client.testConnection();
      
      if (!connectionTest.ok) {
        console.error('❌ Failed to connect to Slack. Please check your token.');
        process.exit(1);
      }
      
      console.log(`✅ Connected to Slack as ${connectionTest.user} on ${connectionTest.team}`);
      console.log('');
    }

    // Perform comparison
    console.log(`🔀 Comparing members between #${options.channelA} and #${options.channelB}...\n`);
    
    const comparison = await client.compareChannels(options.channelA, options.channelB);
    
    // Display results
    displayComparisonResults(comparison, options.verbose);
    
  } catch (error) {
    console.error('❌ Error:', error instanceof Error ? error.message : 'Unknown error');
    process.exit(1);
  }
}

function formatUsernamesAsList(users: any[]): string {
  return users.map(user => user.name).join(', ');
}

function displayComparisonResults(comparison: any, verbose?: boolean): void {
  const { channelAName, channelBName, uniqueToA, uniqueToB, totalUniqueCount } = comparison;

  console.log(`📊 Comparison Results\n`);
  
  if (totalUniqueCount === 0) {
    console.log('🎉 Perfect match! Both channels have identical members.');
    return;
  }

  // Summary
  console.log(`📈 Summary:`);
  console.log(`   • Members only in #${channelAName}: ${uniqueToA.length}`);
  console.log(`   • Members only in #${channelBName}: ${uniqueToB.length}`);
  console.log(`   • Total unique members: ${totalUniqueCount}\n`);

  // Members only in Channel A
  if (uniqueToA.length > 0) {
    console.log(`👥 Members only in #${channelAName}:`);
    
    const tableA = new Table({
      title: `Only in #${channelAName}`,
      columns: [
        { name: 'name', title: 'Name', alignment: 'left', color: 'cyan' },
        { name: 'email', title: 'Email', alignment: 'left', color: 'white' },
        { name: 'username', title: 'Username', alignment: 'left', color: 'gray' }
      ],
      colorMap: {
        cyan: '\x1b[36m',
        white: '\x1b[37m',
        gray: '\x1b[90m'
      }
    });

    uniqueToA.forEach(user => {
      tableA.addRow({
        name: user.realName,
        email: user.email,
        username: `@${user.name}`
      });
    });

    tableA.printTable();
    console.log(`\n📝 Usernames: ${formatUsernamesAsList(uniqueToA)}\n`);
  }

  // Members only in Channel B
  if (uniqueToB.length > 0) {
    console.log(`👥 Members only in #${channelBName}:`);
    
    const tableB = new Table({
      title: `Only in #${channelBName}`,
      columns: [
        { name: 'name', title: 'Name', alignment: 'left', color: 'cyan' },
        { name: 'email', title: 'Email', alignment: 'left', color: 'white' },
        { name: 'username', title: 'Username', alignment: 'left', color: 'gray' }
      ],
      colorMap: {
        cyan: '\x1b[36m',
        white: '\x1b[37m',
        gray: '\x1b[90m'
      }
    });

    uniqueToB.forEach(user => {
      tableB.addRow({
        name: user.realName,
        email: user.email,
        username: `@${user.name}`
      });
    });

    tableB.printTable();
    console.log(`\n📝 Usernames: ${formatUsernamesAsList(uniqueToB)}\n`);
  }

  // Verbose output
  if (verbose) {
    console.log(`\n📋 Additional Details:`);
    console.log(`   • Total members processed from #${channelAName}: ${uniqueToA.length + (comparison.commonCount || 0)}`);
    console.log(`   • Total members processed from #${channelBName}: ${uniqueToB.length + (comparison.commonCount || 0)}`);
  }
}
