export interface SlackUser {
  id: string;
  name: string;
  realName: string;
  email: string;
  displayName: string;
}

export interface ChannelMemberComparison {
  channelAName: string;
  channelBName: string;
  uniqueToA: SlackUser[];
  uniqueToB: SlackUser[];
  totalUniqueCount: number;
}

export interface SlackChannel {
  id: string;
  name: string;
  isPrivate: boolean;
  memberCount?: number;
}

export interface ComparisonOptions {
  channelA: string;
  channelB: string;
  verbose?: boolean;
}
