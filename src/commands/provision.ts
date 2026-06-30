import { Command } from 'commander';
import { Table } from 'console-table-printer';
import { SlackClient } from '../lib/slack.js';
import { NeonClient, type MemberRecord } from '../lib/neon.js';

interface ProvisionOptions {
  slug: string;
  also?: string[];
  topic?: string;
  apply?: boolean;
  verbose?: boolean;
}

const DEFAULT_TOPIC = 'Direct communication with your main contact points in CTORI';

export function createProvisionCommand(): Command {
  const command = new Command('provision');

  command
    .description('Create a private Slack channel for an invested deal, invite its helpers from Neon, and store the channel id back on pipeline_deals. Dry-run by default.')
    .requiredOption('-s, --slug <slug>', 'pipeline_deals.slug for the deal (e.g. "altek-ai")')
    .option('-a, --also <name...>', 'Additional persons.name to invite on top of registered helpers (repeatable)')
    .option('-t, --topic <topic>', `Channel topic. Default: "${DEFAULT_TOPIC}"`)
    .option('--apply', 'Actually create the channel and invite. Without this flag, runs dry-run only.', false)
    .option('-v, --verbose', 'Show detailed output', false)
    .action(async (options: ProvisionOptions) => {
      await executeProvision(options);
    });

  return command;
}

async function executeProvision(options: ProvisionOptions): Promise<void> {
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
  const topic = options.topic || DEFAULT_TOPIC;

  // 1. Resolve deal
  console.log(`🗄️  Looking up deal slug "${options.slug}"...`);
  const deal = await neon.getDealBySlug(options.slug);
  if (!deal) {
    console.error(`❌ No deal found with slug "${options.slug}"`);
    process.exit(1);
  }
  if (deal.slackChannelId) {
    console.error(`❌ Deal "${deal.name}" already has slack_channel_id ${deal.slackChannelId}.`);
    console.error(`   This tool refuses to overwrite. Clear the column manually if you really want to re-provision.`);
    process.exit(1);
  }
  if (deal.status !== 'invested') {
    console.warn(`⚠️  Deal "${deal.name}" has status "${deal.status}", not "invested". Continuing anyway.`);
  }

  // 2. Resolve invitees
  const helpers = await neon.getDealHelpers(deal.id);
  const companyContacts = await neon.getCompanyContacts(deal.orgId);

  // Dedup: company contacts already registered as helpers shouldn't appear twice
  const helperIds = new Set(helpers.map(h => h.personId));
  const filteredCompanyContacts = companyContacts.filter(c => !helperIds.has(c.personId));

  const extras: MemberRecord[] = [];
  const alsoNames = options.also || [];
  const knownIds = new Set([...helperIds, ...filteredCompanyContacts.map(c => c.personId)]);
  for (const name of alsoNames) {
    const found = await neon.getPersonByName(name);
    if (!found) {
      console.error(`❌ --also: no active person named "${name}" found in DB`);
      process.exit(1);
    }
    if (knownIds.has(found.personId)) {
      if (options.verbose) console.log(`   (skipping --also "${name}": already in helpers or company contacts)`);
      continue;
    }
    if (extras.some(e => e.personId === found.personId)) continue;
    extras.push(found);
    knownIds.add(found.personId);
  }

  const allInvitees = [...helpers, ...filteredCompanyContacts, ...extras];

  // 3. Print plan
  console.log('');
  console.log(`📋 Provision plan for "${deal.name}" (status: ${deal.status})`);
  console.log(`   Channel name:    #${options.slug}`);
  console.log(`   Visibility:      private`);
  console.log(`   Topic:           ${topic}`);
  console.log(`   Helpers (DB):    ${helpers.length}`);
  console.log(`   Company contacts: ${filteredCompanyContacts.length}`);
  console.log(`   Extras (--also): ${extras.length}`);
  console.log('');

  if (allInvitees.length === 0) {
    console.warn(`⚠️  No invitees resolved. Channel would be created with only the bot.`);
    console.warn(`   Either register helpers in deal_leads, or pass --also "<Person Name>".`);
  } else {
    const t = new Table({
      columns: [
        { name: 'name', title: 'Name', alignment: 'left', color: 'cyan' },
        { name: 'role', title: 'Role', alignment: 'left', color: 'gray' },
        { name: 'email', title: 'Email (lookup chain)', alignment: 'left' },
      ],
    });
    for (const m of allInvitees) {
      t.addRow({ name: m.name, role: m.role, email: m.emails.join(', ') });
    }
    t.printTable();
    console.log('');
  }

  if (!options.apply) {
    console.log('🧪 Dry-run. Re-run with --apply to actually create the channel.');
    return;
  }

  // 4. Resolve emails to Slack user IDs
  const userIdsToInvite: string[] = [];
  const skipped: Array<{ name: string; reason: string }> = [];
  for (const m of allInvitees) {
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

  // 5. Create channel
  console.log(`🚀 Creating private channel #${options.slug}...`);
  let channel: { id: string; name: string };
  try {
    channel = await slack.createPrivateChannel(options.slug);
  } catch (err: any) {
    const slackErr = err?.data?.error || err?.message || 'unknown';
    console.error(`❌ conversations.create failed: ${slackErr}`);
    if (slackErr === 'name_taken') {
      console.error(`   → A channel named #${options.slug} already exists. Find its id and set pipeline_deals.slack_channel_id manually.`);
    }
    process.exit(1);
  }
  console.log(`✅ Created #${channel.name} (id: ${channel.id})`);

  // 6. Set topic
  try {
    await slack.setChannelTopic(channel.id, topic);
    console.log(`✅ Topic set`);
  } catch (err: any) {
    console.warn(`⚠️  setTopic failed (continuing): ${err?.data?.error || err?.message}`);
  }

  // 7. Invite
  if (userIdsToInvite.length > 0) {
    try {
      await slack.inviteToChannel(channel.id, userIdsToInvite);
      console.log(`✅ Invited ${userIdsToInvite.length} user(s)`);
    } catch (err: any) {
      const slackErr = err?.data?.error || err?.message || 'unknown';
      console.error(`❌ conversations.invite failed: ${slackErr}`);
      console.error(`   Channel was created. You may need to invite manually.`);
    }
  } else {
    console.log(`ℹ️  No users invited (only the bot is in the channel).`);
  }

  // 8. Persist
  await neon.setDealSlackChannelId(deal.id, channel.id);
  console.log(`✅ Saved pipeline_deals.slack_channel_id = ${channel.id}`);

  if (skipped.length > 0) {
    console.log('');
    console.log(`⚠️  Skipped ${skipped.length}:`);
    for (const s of skipped) console.log(`   • ${s.name}: ${s.reason}`);
  }

  console.log('');
  console.log(`🎉 Done. #${channel.name} is provisioned.`);
}
