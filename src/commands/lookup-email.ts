import { WebClient } from '@slack/web-api';

const token = process.env.SLACK_TOKEN;
if (!token) {
  console.error('SLACK_TOKEN missing in env');
  process.exit(1);
}

const query = process.argv[2];
if (!query) {
  console.error('Usage: bun src/commands/lookup-email.ts <slack_user_id | @handle | name>');
  process.exit(1);
}

const web = new WebClient(token);

async function run() {
  if (query.startsWith('U') && query.length >= 9 && !query.includes(' ')) {
    const { user } = await web.users.info({ user: query });
    if (!user) {
      console.error('User not found');
      process.exit(2);
    }
    printUser(user);
    return;
  }

  const needle = query.replace(/^@/, '').toLowerCase();
  let cursor: string | undefined;
  do {
    const res = await web.users.list({ cursor, limit: 200 });
    for (const u of res.members ?? []) {
      const hit =
        u.name?.toLowerCase() === needle ||
        u.real_name?.toLowerCase().includes(needle) ||
        u.profile?.display_name?.toLowerCase().includes(needle) ||
        u.profile?.real_name?.toLowerCase().includes(needle);
      if (hit) printUser(u);
    }
    cursor = res.response_metadata?.next_cursor || undefined;
  } while (cursor);
}

function printUser(u: any) {
  console.log(JSON.stringify({
    id: u.id,
    name: u.name,
    real_name: u.real_name ?? u.profile?.real_name,
    display_name: u.profile?.display_name,
    email: u.profile?.email ?? null,
    deleted: u.deleted ?? false,
  }, null, 2));
}

run().catch((e) => {
  console.error(e?.data ?? e);
  process.exit(1);
});
