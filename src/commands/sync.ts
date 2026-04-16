import { Command } from 'commander';
import { Table } from 'console-table-printer';
import { SlackClient } from '../lib/slack.js';
import { NeonClient, type MemberRecord } from '../lib/neon.js';

interface SyncOptions {
  channel: string;
  group?: string;
  stdin?: boolean;
  apply?: boolean;
  verbose?: boolean;
}

export function createSyncCommand(): Command {
  const command = new Command('sync');

  command
    .description('Sync a Slack channel to match a member list (Neon group or stdin). Dry-run by default.')
    .requiredOption('-c, --channel <name>', 'Target Slack channel (with or without # prefix)')
    .option('-g, --group <name>', 'Neon network_groups.name to source members from (e.g. "CTO Roundtable")')
    .option('--stdin', 'Read emails from stdin (one per line) instead of querying Neon')
    .option('--apply', 'Actually invite missing members. Without this flag, runs dry-run only.', false)
    .option('-v, --verbose', 'Show detailed output', false)
    .action(async (options: SyncOptions) => {
      await executeSync(options);
    });

  return command;
}

async function readEmailsFromStdin(): Promise<string[]> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf-8');
  return text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith('#'));
}

async function executeSync(options: SyncOptions): Promise<void> {
  const slackToken = process.env.SLACK_TOKEN;
  if (!slackToken) {
    console.error('❌ SLACK_TOKEN environment variable is required');
    process.exit(1);
  }

  if (!options.group && !options.stdin) {
    console.error('❌ Provide either --group <name> (Neon) or --stdin (pipe emails)');
    process.exit(1);
  }
  if (options.group && options.stdin) {
    console.error('❌ Choose one source: --group or --stdin, not both');
    process.exit(1);
  }

  const slack = new SlackClient(slackToken);

  // 1. Fetch source members
  let sourceLabel: string;
  let sourceMembers: MemberRecord[];

  if (options.stdin) {
    const emails = await readEmailsFromStdin();
    sourceLabel = `stdin (${emails.length} emails)`;
    sourceMembers = emails.map(email => ({
      personId: '',
      name: email,
      emails: [email.toLowerCase()],
      role: '',
    }));
  } else {
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) {
      console.error('❌ DATABASE_URL environment variable is required for --group mode');
      console.error('   Add it to .env (Neon connection string)');
      process.exit(1);
    }
    console.log(`🗄️  Querying Neon group "${options.group}"...`);
    const neonClient = new NeonClient(dbUrl);
    sourceMembers = await neonClient.getMembersOfGroup(options.group!);
    sourceLabel = `Neon group "${options.group}" (${sourceMembers.length} members)`;
  }

  if (sourceMembers.length === 0) {
    console.error(`❌ No members found from source: ${sourceLabel}`);
    process.exit(1);
  }

  // 2. Fetch channel members
  console.log(`🔍 Fetching #${options.channel.replace('#', '')} members...`);
  const { emails: channelEmails, channelInfo } = await slack.getChannelMemberEmails(options.channel);

  // 3. Diff — a source member is "present" if ANY of their emails is in the channel
  const sourceEmails = new Set<string>();
  for (const m of sourceMembers) for (const e of m.emails) sourceEmails.add(e);
  const missingFromChannel = sourceMembers.filter(
    m => !m.emails.some(e => channelEmails.has(e))
  );
  const extraInChannel = [...channelEmails].filter(e => !sourceEmails.has(e));

  // 4. Report
  console.log('');
  console.log(`📊 Sync Diff: ${sourceLabel} → #${channelInfo.name}`);
  console.log(`   Source members: ${sourceMembers.length}`);
  console.log(`   Channel members (with email): ${channelEmails.size}`);
  console.log(`   Missing from channel: ${missingFromChannel.length}`);
  console.log(`   Extra in channel (not in source): ${extraInChannel.length}`);
  console.log('');

  if (missingFromChannel.length > 0) {
    console.log(`➕ Members in source but NOT in #${channelInfo.name}:`);
    const t = new Table({
      columns: [
        { name: 'name', title: 'Name', alignment: 'left', color: 'cyan' },
        { name: 'email', title: 'Email', alignment: 'left' },
        { name: 'role', title: 'Role', alignment: 'left', color: 'gray' },
      ],
    });
    for (const m of missingFromChannel) {
      t.addRow({ name: m.name, email: m.emails.join(', '), role: m.role || '—' });
    }
    t.printTable();
    console.log('');
  }

  if (extraInChannel.length > 0 && options.verbose) {
    console.log(`ℹ️  Extras in channel (present in Slack but not in source):`);
    for (const e of extraInChannel) console.log(`   • ${e}`);
    console.log(`   (These are not removed — sync is one-way source→channel)`);
    console.log('');
  }

  if (missingFromChannel.length === 0) {
    console.log('🎉 Channel is in sync. Nothing to do.');
    return;
  }

  // 5. Apply or dry-run
  if (!options.apply) {
    console.log(`🧪 Dry-run. Re-run with --apply to invite ${missingFromChannel.length} member(s) to #${channelInfo.name}.`);
    return;
  }

  console.log(`🚀 Applying: inviting ${missingFromChannel.length} member(s) to #${channelInfo.name}...`);
  console.log('');

  const userIdsToInvite: string[] = [];
  const skipped: Array<{ email: string; reason: string }> = [];

  for (const m of missingFromChannel) {
    let userId: string | null = null;
    for (const email of m.emails) {
      userId = await slack.lookupUserIdByEmail(email);
      if (userId) break;
    }
    if (!userId) {
      skipped.push({ email: m.emails.join(', '), reason: 'no Slack account for any known email' });
      continue;
    }
    userIdsToInvite.push(userId);
  }

  if (userIdsToInvite.length > 0) {
    try {
      await slack.inviteToChannel(channelInfo.id, userIdsToInvite);
      console.log(`✅ Invited ${userIdsToInvite.length} user(s) to #${channelInfo.name}`);
    } catch (err: any) {
      const slackErr = err?.data?.error || err?.message || 'unknown';
      console.error(`❌ conversations.invite failed: ${slackErr}`);
      if (slackErr === 'not_in_channel') {
        console.error(`   → The bot must be a member of #${channelInfo.name} first. In Slack: /invite @<botname>`);
      }
      process.exit(1);
    }
  }

  if (skipped.length > 0) {
    console.log('');
    console.log(`⚠️  Skipped ${skipped.length}:`);
    for (const s of skipped) console.log(`   • ${s.email} — ${s.reason}`);
  }
}
