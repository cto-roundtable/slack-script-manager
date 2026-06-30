/**
 * Sync Slack identity into the activity signal layer, then backfill historical
 * events. 100% correct by construction: members are matched to Slack accounts on
 * EMAIL only (contact_infos.type='email' <-> Slack profile email). Email is a
 * unique key, so a match is always the right person or no match at all. No name
 * matching, ever.
 *
 * Steps:
 *   1. Slack users.list -> { id, email, real_name, username, is_bot, deleted }
 *   2. Upsert into slack_users (fills the email the Riff backfill lacked)
 *   3. Resolve slack_users.person_id via email join to contact_infos
 *   4. Backfill activity_events.person_id + target_person_id from slack_users
 *
 * Idempotent. Re-run any time to pick up new members / new Slack accounts.
 *
 * Env: SLACK_TOKEN (users:read + users:read.email), DATABASE_URL (our Neon).
 */
import { WebClient } from '@slack/web-api'
import { neon } from '@neondatabase/serverless'

const token = process.env.SLACK_TOKEN
const dbUrl = process.env.DATABASE_URL
if (!token) throw new Error('SLACK_TOKEN not set')
if (!dbUrl) throw new Error('DATABASE_URL not set')

const web = new WebClient(token)
const sql = neon(dbUrl)

type SlackUserRow = {
  id: string
  username: string | null
  realName: string | null
  email: string | null
  isBot: boolean
  deleted: boolean
}

async function fetchAllSlackUsers(): Promise<SlackUserRow[]> {
  const out: SlackUserRow[] = []
  let cursor: string | undefined
  do {
    const res = await web.users.list({ limit: 200, cursor })
    if (!res.ok) throw new Error(`users.list failed: ${res.error}`)
    for (const m of res.members || []) {
      out.push({
        id: m.id!,
        username: m.name || null,
        realName: m.real_name || m.profile?.real_name || null,
        email: m.profile?.email || null,
        isBot: !!m.is_bot,
        deleted: !!m.deleted,
      })
    }
    cursor = res.response_metadata?.next_cursor || undefined
  } while (cursor)
  return out
}

async function main() {
  const dryRun = process.argv.includes('--dry-run')
  console.log(`\n=== sync-activity-identity ${dryRun ? '(DRY RUN)' : ''} ===`)

  const auth = await web.auth.test()
  if (!auth.ok) throw new Error('Slack auth.test failed')
  console.log(`Slack workspace: ${auth.team}`)

  const users = await fetchAllSlackUsers()
  const withEmail = users.filter((u) => u.email && !u.deleted)
  console.log(`Slack users: ${users.length} total, ${withEmail.length} with email (non-deleted)`)

  if (withEmail.length === 0) {
    throw new Error(
      'No emails returned. The token is likely missing the users:read.email scope. Aborting (will NOT fall back to name matching).',
    )
  }

  // before snapshot
  const [before] = (await sql`
    SELECT
      (SELECT count(*) FROM slack_users) AS su_total,
      (SELECT count(*) FROM slack_users WHERE person_id IS NOT NULL) AS su_mapped,
      (SELECT count(*) FROM activity_events) AS ev_total,
      (SELECT count(*) FROM activity_events WHERE person_id IS NOT NULL) AS ev_resolved
  `) as Array<Record<string, number>>
  console.log(
    `Before: slack_users ${before.su_mapped}/${before.su_total} mapped, ` +
      `events ${before.ev_resolved}/${before.ev_total} resolved`,
  )

  if (dryRun) {
    // show how many emails would match a member, without writing
    const emails = withEmail.map((u) => u.email!.toLowerCase())
    const matched = (await sql`
      SELECT count(DISTINCT lower(value)) AS n
      FROM contact_infos
      WHERE type = 'email' AND lower(value) = ANY(${emails})
    `) as Array<{ n: number }>
    console.log(`Dry run: ${matched[0].n} Slack emails match a member email. No writes made.`)
    return
  }

  // 2. upsert dimension (fills email)
  let upserts = 0
  for (const u of users) {
    await sql`
      INSERT INTO slack_users (slack_user_id, username, real_name, email, is_bot, deleted, updated_at)
      VALUES (${u.id}, ${u.username}, ${u.realName}, ${u.email}, ${u.isBot}, ${u.deleted}, now())
      ON CONFLICT (slack_user_id) DO UPDATE SET
        username   = COALESCE(EXCLUDED.username, slack_users.username),
        real_name  = COALESCE(EXCLUDED.real_name, slack_users.real_name),
        email      = COALESCE(EXCLUDED.email, slack_users.email),
        is_bot     = EXCLUDED.is_bot,
        deleted    = EXCLUDED.deleted,
        updated_at = now()
    `
    upserts++
  }
  console.log(`Upserted ${upserts} slack_users.`)

  // 3. resolve person_id by EMAIL ONLY (authoritative)
  const resolved = (await sql`
    UPDATE slack_users su
    SET person_id = ci.person_id
    FROM contact_infos ci
    WHERE ci.type = 'email'
      AND lower(ci.value) = lower(su.email)
      AND su.email IS NOT NULL
      AND su.person_id IS NULL
    RETURNING su.slack_user_id
  `) as Array<{ slack_user_id: string }>
  console.log(`Newly mapped ${resolved.length} slack_users to members via email.`)

  // 4. backfill historical events from the (now richer) dimension
  const actorBf = (await sql`
    UPDATE activity_events ae
    SET person_id = su.person_id
    FROM slack_users su
    WHERE su.slack_user_id = ae.actor_external_id
      AND ae.person_id IS NULL
      AND su.person_id IS NOT NULL
    RETURNING ae.id
  `) as Array<{ id: string }>
  const targetBf = (await sql`
    UPDATE activity_events ae
    SET target_person_id = su.person_id
    FROM slack_users su
    WHERE su.slack_user_id = ae.target_external_id
      AND ae.target_person_id IS NULL
      AND su.person_id IS NOT NULL
    RETURNING ae.id
  `) as Array<{ id: string }>
  console.log(`Backfilled person_id on ${actorBf.length} events, target_person_id on ${targetBf.length} events.`)

  const [after] = (await sql`
    SELECT
      (SELECT count(*) FROM slack_users WHERE person_id IS NOT NULL) AS su_mapped,
      (SELECT count(*) FROM slack_users) AS su_total,
      (SELECT count(*) FROM activity_events WHERE person_id IS NOT NULL) AS ev_resolved,
      (SELECT count(*) FROM activity_events) AS ev_total
  `) as Array<Record<string, number>>
  console.log(
    `After:  slack_users ${after.su_mapped}/${after.su_total} mapped, ` +
      `events ${after.ev_resolved}/${after.ev_total} resolved`,
  )
  console.log('Done.')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
