import { Command } from 'commander';
import { Table } from 'console-table-printer';
import { SlackClient } from '../lib/slack.js';
import { NeonClient, type MemberRecord } from '../lib/neon.js';

interface TopUpOptions {
  slug: string;
  also?: string[];
  apply?: boolean;
  verbose?: boolean;
}

export function createTopUpCommand(): Command {
  const command = new Command('top-up');

  command
    .description('Invite missing helpers + company contacts (and any --also extras) to an already-provisioned channel. Dry-run by default.')
    .requiredOption('-s, --slug <slug>', 'pipeline_deals.slug for the deal (must already have slack_channel_id set)')
    .option('-a, --also <name...>', 'Additional persons.name to invite on top of registered helpers/contacts (repeatable)')
    .option('--apply', 'Actually invite. Without this flag, runs dry-run only.', false)
    .option('-v, --verbose', 'Show detailed output', false)
    .action(async (options: TopUpOptions) => {
      await executeTopUp(options);
    });

  return command;
}

async function executeTopUp(options: TopUpOptions): Promise<void> {
  const slackToken = process.env.SLACK_TOKEN;
  if (!slackToken) {
    console.error('❌ SLACK_TOKEN environment variable is required');
    process.exit(1);
  }
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error('❌ DATABASE_URL environment variable is required');
    process.exit(1);
  }

  const slack = new SlackClient(slackToken);
  const neon = new NeonClient(dbUrl);

  // 1. Resolve deal
  const deal = await neon.getDealBySlug(options.slug);
  if (!deal) {
    console.error(`❌ No deal found with slug "${options.slug}"`);
    process.exit(1);
  }
  if (!deal.slackChannelId) {
    console.error(`❌ Deal "${deal.name}" has no slack_channel_id. Use \`provision\` first.`);
    process.exit(1);
  }

  // 2. Compute desired invitee set
  const helpers = await neon.getDealHelpers(deal.id);
  const companyContacts = await neon.getCompanyContacts(deal.orgId);
  const helperIds = new Set(helpers.map(h => h.personId));
  const filteredCompanyContacts = companyContacts.filter(c => !helperIds.has(c.personId));

  const extras: MemberRecord[] = [];
  const knownIds = new Set([...helperIds, ...filteredCompanyContacts.map(c => c.personId)]);
  for (const name of options.also || []) {
    const found = await neon.getPersonByName(name);
    if (!found) {
      console.error(`❌ --also: no active person named "${name}" found in DB`);
      process.exit(1);
    }
    if (knownIds.has(found.personId)) continue;
    extras.push(found);
    knownIds.add(found.personId);
  }

  const desired = [...helpers, ...filteredCompanyContacts, ...extras];

  // 3. Fetch current channel members
  const { emails: currentEmails, channelInfo } = await slack.getChannelMemberEmails(deal.slackChannelId);

  // 4. Diff: who's missing?
  const missing = desired.filter(m => !m.emails.some(e => currentEmails.has(e)));

  // 5. Report
  console.log('');
  console.log(`📋 Top-up plan for #${channelInfo.name} ("${deal.name}")`);
  console.log(`   Current members (with email): ${currentEmails.size}`);
  console.log(`   Desired (helpers + contacts + extras): ${desired.length}`);
  console.log(`   Missing from channel: ${missing.length}`);
  console.log('');

  if (missing.length === 0) {
    console.log('🎉 Channel already has everyone. Nothing to do.');
    return;
  }

  const t = new Table({
    columns: [
      { name: 'name', title: 'Name', alignment: 'left', color: 'cyan' },
      { name: 'role', title: 'Role', alignment: 'left', color: 'gray' },
      { name: 'email', title: 'Email', alignment: 'left' },
    ],
  });
  for (const m of missing) {
    t.addRow({ name: m.name, role: m.role, email: m.emails.join(', ') });
  }
  t.printTable();
  console.log('');

  if (!options.apply) {
    console.log(`🧪 Dry-run. Re-run with --apply to invite ${missing.length} member(s).`);
    return;
  }

  // 6. Apply
  const userIdsToInvite: string[] = [];
  const skipped: Array<{ name: string; reason: string }> = [];
  for (const m of missing) {
    let userId: string | null = null;
    for (const email of m.emails) {
      userId = await slack.lookupUserIdByEmail(email);
      if (userId) break;
    }
    if (!userId) {
      skipped.push({ name: m.name, reason: 'no Slack account for any known email' });
      continue;
    }
    if (!userIdsToInvite.includes(userId)) userIdsToInvite.push(userId);
  }

  if (userIdsToInvite.length > 0) {
    try {
      await slack.inviteToChannel(channelInfo.id, userIdsToInvite);
      console.log(`✅ Invited ${userIdsToInvite.length} user(s) to #${channelInfo.name}`);
    } catch (err: any) {
      const slackErr = err?.data?.error || err?.message || 'unknown';
      console.error(`❌ conversations.invite failed: ${slackErr}`);
      if (slackErr === 'not_in_channel') {
        console.error(`   → The bot must be a member of #${channelInfo.name} first. /invite @<botname>`);
      }
      process.exit(1);
    }
  }

  if (skipped.length > 0) {
    console.log('');
    console.log(`⚠️  Skipped ${skipped.length}:`);
    for (const s of skipped) console.log(`   • ${s.name}: ${s.reason}`);
  }
}
