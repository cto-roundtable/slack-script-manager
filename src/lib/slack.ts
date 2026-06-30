import { WebClient } from '@slack/web-api';
import type { SlackUser, SlackChannel, ChannelMemberComparison } from '../types/index.js';

export class SlackClient {
  private web: WebClient;

  constructor(token: string) {
    this.web = new WebClient(token);
  }

  /**
   * Get channel ID from channel name (with or without # prefix)
   */
  private async getChannelIdFromName(channelName: string): Promise<{ id: string; name: string; isPrivate: boolean }> {
    const cleanName = channelName.replace('#', '');
    
    try {
      // Try to find the channel in conversations list
      const result = await this.web.conversations.list({
        types: 'public_channel,private_channel',
        limit: 1000
      });

      if (!result.channels) {
        throw new Error('No channels found');
      }

      const channel = result.channels.find(ch => ch.name === cleanName);
      
      if (!channel) {
        throw new Error(`Channel '${channelName}' not found. Make sure the bot is added to the channel if it's private.`);
      }

      return {
        id: channel.id!,
        name: channel.name!,
        isPrivate: channel.is_private || false
      };
    } catch (error) {
      throw new Error(`Failed to find channel '${channelName}': ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Get all members of a channel by name
   */
  private async getChannelMembersByName(channelName: string): Promise<{ users: SlackUser[]; channelInfo: SlackChannel }> {
    const channelInfo = await this.getChannelIdFromName(channelName);
    
    try {
      const members: string[] = [];
      let cursor: string | undefined;

      // Get all members with pagination
      do {
        const result = await this.web.conversations.members({
          channel: channelInfo.id,
          cursor,
          limit: 1000
        });

        if (!result.ok) {
          throw new Error(`Failed to fetch members: ${result.error}`);
        }

        if (result.members) {
          members.push(...result.members);
        }

        cursor = result.response_metadata?.next_cursor;
      } while (cursor);

      // Get user info for all members
      const users = await this.getUsersInfo(members);
      
      return {
        users,
        channelInfo: {
          id: channelInfo.id,
          name: channelInfo.name,
          isPrivate: channelInfo.isPrivate,
          memberCount: members.length
        }
      };
    } catch (error) {
      throw new Error(`Failed to get members for channel '${channelName}': ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Get user information for multiple users
   */
  private async getUsersInfo(userIds: string[]): Promise<SlackUser[]> {
    const users: SlackUser[] = [];
    
    // Process users in batches to avoid rate limits
    const batchSize = 20;
    for (let i = 0; i < userIds.length; i += batchSize) {
      const batch = userIds.slice(i, i + batchSize);
      const batchPromises = batch.map(async (userId) => {
        try {
          const result = await this.web.users.info({ user: userId });
          
          if (!result.ok || !result.user) {
            console.warn(`Failed to get info for user ${userId}`);
            return null;
          }

          const user = result.user;
          return {
            id: user.id!,
            name: user.name || 'unknown',
            realName: user.real_name || user.profile?.real_name || 'Unknown User',
            email: user.profile?.email || 'No email',
            displayName: user.profile?.display_name || user.real_name || user.name || 'Unknown'
          } as SlackUser;
        } catch (error) {
          console.warn(`Error fetching user ${userId}:`, error);
          return null;
        }
      });

      const batchResults = await Promise.all(batchPromises);
      users.push(...batchResults.filter((user): user is SlackUser => user !== null));
      
      // Small delay between batches to be nice to the API
      if (i + batchSize < userIds.length) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    return users;
  }

  /**
   * Compare members between two channels and return symmetric difference
   */
  async compareChannels(channelAName: string, channelBName: string): Promise<ChannelMemberComparison> {
    console.log(`🔍 Fetching members from #${channelAName}...`);
    const channelAData = await this.getChannelMembersByName(channelAName);
    
    console.log(`🔍 Fetching members from #${channelBName}...`);
    const channelBData = await this.getChannelMembersByName(channelBName);

    // Create sets for efficient comparison
    const membersAIds = new Set(channelAData.users.map(user => user.id));
    const membersBIds = new Set(channelBData.users.map(user => user.id));

    // Find symmetric difference (users in either channel but not both)
    const uniqueToA = channelAData.users.filter(user => !membersBIds.has(user.id));
    const uniqueToB = channelBData.users.filter(user => !membersAIds.has(user.id));

    return {
      channelAName: channelAData.channelInfo.name,
      channelBName: channelBData.channelInfo.name,
      uniqueToA,
      uniqueToB,
      totalUniqueCount: uniqueToA.length + uniqueToB.length
    };
  }

  /**
   * Get channel metadata + member Slack IDs (public method wrapper)
   */
  async resolveChannel(channelName: string): Promise<{ id: string; name: string; isPrivate: boolean }> {
    return this.getChannelIdFromName(channelName);
  }

  /**
   * Get the emails of all members currently in a channel.
   * Accepts either a channel name (with or without #) or a channel ID (Cxxxx/Gxxxx).
   * Returns a Set of lowercased emails. Users without an email (e.g. bots) are skipped.
   */
  async getChannelMemberEmails(channelNameOrId: string): Promise<{ emails: Set<string>; users: SlackUser[]; channelInfo: SlackChannel }> {
    const isId = /^[CG][A-Z0-9]+$/.test(channelNameOrId);
    const { users, channelInfo } = isId
      ? await this.getChannelMembersById(channelNameOrId)
      : await this.getChannelMembersByName(channelNameOrId);
    const emails = new Set<string>();
    for (const u of users) {
      if (u.email && u.email !== 'No email') emails.add(u.email.toLowerCase());
    }
    return { emails, users, channelInfo };
  }

  /**
   * Get channel members by channel ID. Used when we already have the id stored
   * (e.g. pipeline_deals.slack_channel_id) and don't need to resolve by name.
   */
  private async getChannelMembersById(channelId: string): Promise<{ users: SlackUser[]; channelInfo: SlackChannel }> {
    const info = await this.web.conversations.info({ channel: channelId });
    if (!info.ok || !info.channel) {
      throw new Error(`conversations.info failed for ${channelId}: ${info.error || 'unknown'}`);
    }
    const channelInfo = {
      id: info.channel.id!,
      name: info.channel.name!,
      isPrivate: info.channel.is_private || false,
    };

    const members: string[] = [];
    let cursor: string | undefined;
    do {
      const result = await this.web.conversations.members({ channel: channelId, cursor, limit: 1000 });
      if (!result.ok) throw new Error(`Failed to fetch members: ${result.error}`);
      if (result.members) members.push(...result.members);
      cursor = result.response_metadata?.next_cursor;
    } while (cursor);

    const users = await this.getUsersInfo(members);
    return {
      users,
      channelInfo: { ...channelInfo, memberCount: members.length },
    };
  }

  /**
   * Resolve an email to a Slack user ID. Returns null if not in workspace.
   */
  async lookupUserIdByEmail(email: string): Promise<string | null> {
    try {
      const result = await this.web.users.lookupByEmail({ email });
      if (!result.ok || !result.user) return null;
      return result.user.id || null;
    } catch (err: any) {
      if (err?.data?.error === 'users_not_found') return null;
      throw err;
    }
  }

  /**
   * Invite one or more user IDs to a channel. Slack accepts up to 1000 IDs per call.
   */
  async inviteToChannel(channelId: string, userIds: string[]): Promise<void> {
    if (userIds.length === 0) return;
    await this.web.conversations.invite({
      channel: channelId,
      users: userIds.join(','),
    });
  }

  /**
   * Create a private channel. Returns channel id + name.
   * Throws if a channel with this name already exists.
   */
  async createPrivateChannel(name: string): Promise<{ id: string; name: string }> {
    const cleanName = name.replace('#', '');
    const result = await this.web.conversations.create({
      name: cleanName,
      is_private: true,
    });
    if (!result.ok || !result.channel?.id || !result.channel?.name) {
      throw new Error(`conversations.create failed: ${result.error || 'unknown'}`);
    }
    return { id: result.channel.id, name: result.channel.name };
  }

  /**
   * Set a channel's topic.
   */
  async setChannelTopic(channelId: string, topic: string): Promise<void> {
    await this.web.conversations.setTopic({ channel: channelId, topic });
  }

  /**
   * Test the connection and token validity
   */
  async testConnection(): Promise<{ ok: boolean; user?: string; team?: string }> {
    try {
      const result = await this.web.auth.test();
      
      if (!result.ok) {
        return { ok: false };
      }

      return {
        ok: true,
        user: result.user || 'Unknown',
        team: result.team || 'Unknown'
      };
    } catch (error) {
      return { ok: false };
    }
  }
}
