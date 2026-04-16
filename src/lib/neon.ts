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
}
