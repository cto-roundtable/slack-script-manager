import { neon } from '@neondatabase/serverless';

export interface MemberRecord {
  personId: string;
  name: string;
  emails: string[];
  role: string;
}

export class NeonClient {
  private sql: ReturnType<typeof neon>;

  constructor(connectionString: string) {
    this.sql = neon(connectionString);
  }

  async getMembersOfGroup(groupName: string): Promise<MemberRecord[]> {
    const rows = await this.sql`
      SELECT
        p.id          AS person_id,
        p.name        AS name,
        ci.value      AS email,
        ci.is_primary AS is_primary,
        m.role        AS role
      FROM network_groups g
      JOIN memberships m   ON m.group_id = g.id
      JOIN persons p       ON p.id = m.person_id
      JOIN contact_infos ci ON ci.person_id = p.id
                           AND ci.type = 'email'
      WHERE g.name = ${groupName}
        AND p.status = 'active'
      ORDER BY p.name, ci.is_primary DESC
    ` as Array<{ person_id: string; name: string; email: string; is_primary: boolean; role: string }>;

    const byPerson = new Map<string, MemberRecord>();
    for (const r of rows) {
      const email = r.email.toLowerCase();
      const existing = byPerson.get(r.person_id);
      if (existing) {
        if (!existing.emails.includes(email)) existing.emails.push(email);
      } else {
        byPerson.set(r.person_id, {
          personId: r.person_id,
          name: r.name,
          emails: [email],
          role: r.role,
        });
      }
    }
    return Array.from(byPerson.values());
  }

  /**
   * Resolve a deal by slug. Returns id, name, status, and existing slack_channel_id (if any).
   * Returns null if the slug is unknown.
   */
  async getDealBySlug(slug: string): Promise<{ id: string; orgId: string; name: string; status: string; slackChannelId: string | null } | null> {
    const rows = await this.sql`
      SELECT pd.id, pd.organization_id, o.name, pd.status, pd.slack_channel_id
      FROM pipeline_deals pd
      JOIN organizations o ON o.id = pd.organization_id
      WHERE pd.slug = ${slug}
      LIMIT 1
    ` as Array<{ id: string; organization_id: string; name: string; status: string; slack_channel_id: string | null }>;
    if (rows.length === 0) return null;
    const r = rows[0];
    return { id: r.id, orgId: r.organization_id, name: r.name, status: r.status, slackChannelId: r.slack_channel_id };
  }

  /**
   * Get the helpers (lead, co_lead, supporter) for a deal, including all known emails per person.
   * Used to populate a private channel with the people designated to support that company.
   */
  async getDealHelpers(dealId: string): Promise<MemberRecord[]> {
    const rows = await this.sql`
      SELECT
        p.id          AS person_id,
        p.name        AS name,
        ci.value      AS email,
        ci.is_primary AS is_primary,
        dl.role       AS role
      FROM deal_leads dl
      JOIN persons p        ON p.id = dl.person_id
      JOIN contact_infos ci ON ci.person_id = p.id AND ci.type = 'email'
      WHERE dl.deal_id = ${dealId}
        AND p.status = 'active'
      ORDER BY p.name, ci.is_primary DESC
    ` as Array<{ person_id: string; name: string; email: string; is_primary: boolean; role: string }>;

    const byPerson = new Map<string, MemberRecord>();
    for (const r of rows) {
      const email = r.email.toLowerCase();
      const existing = byPerson.get(r.person_id);
      if (existing) {
        if (!existing.emails.includes(email)) existing.emails.push(email);
      } else {
        byPerson.set(r.person_id, {
          personId: r.person_id,
          name: r.name,
          emails: [email],
          role: r.role,
        });
      }
    }
    return Array.from(byPerson.values());
  }

  /**
   * Look up a person by exact name and return their known emails.
   * Used by --also flag to add extra invitees not currently registered as helpers.
   */
  async getPersonByName(name: string): Promise<MemberRecord | null> {
    const rows = await this.sql`
      SELECT
        p.id          AS person_id,
        p.name        AS name,
        ci.value      AS email,
        ci.is_primary AS is_primary
      FROM persons p
      JOIN contact_infos ci ON ci.person_id = p.id AND ci.type = 'email'
      WHERE p.name = ${name}
        AND p.status = 'active'
      ORDER BY ci.is_primary DESC
    ` as Array<{ person_id: string; name: string; email: string; is_primary: boolean }>;
    if (rows.length === 0) return null;
    const emails: string[] = [];
    for (const r of rows) {
      const email = r.email.toLowerCase();
      if (!emails.includes(email)) emails.push(email);
    }
    return { personId: rows[0].person_id, name: rows[0].name, emails, role: 'extra' };
  }

  /**
   * Company-side slack contacts for a deal: people with is_slack_contact=true on a current
   * (ended_at IS NULL) founder/employee relationship. Persons without any email are omitted.
   */
  async getCompanyContacts(orgId: string): Promise<MemberRecord[]> {
    const rows = await this.sql`
      SELECT
        p.id          AS person_id,
        p.name        AS name,
        ci.value      AS email,
        ci.is_primary AS is_primary,
        po.relationship_type AS rel_type,
        COALESCE(po.role_title, '') AS role_title
      FROM person_organizations po
      JOIN persons p ON p.id = po.person_id
      JOIN contact_infos ci ON ci.person_id = p.id AND ci.type = 'email'
      WHERE po.organization_id = ${orgId}
        AND po.ended_at IS NULL
        AND po.is_slack_contact = true
      ORDER BY p.name, ci.is_primary DESC
    ` as Array<{ person_id: string; name: string; email: string; is_primary: boolean; rel_type: string; role_title: string }>;

    const byPerson = new Map<string, MemberRecord>();
    for (const r of rows) {
      const email = r.email.toLowerCase();
      const existing = byPerson.get(r.person_id);
      if (existing) {
        if (!existing.emails.includes(email)) existing.emails.push(email);
      } else {
        const roleLabel = r.role_title || r.rel_type;
        byPerson.set(r.person_id, {
          personId: r.person_id,
          name: r.name,
          emails: [email],
          role: `company:${roleLabel}`,
        });
      }
    }
    return Array.from(byPerson.values());
  }

  async setDealSlackChannelId(dealId: string, channelId: string): Promise<void> {
    await this.sql`
      UPDATE pipeline_deals
      SET slack_channel_id = ${channelId}, updated_at = now()
      WHERE id = ${dealId}
    `;
  }
}
